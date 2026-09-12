import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { womaHome, writeJsonAtomic } from "./fs.js";

const LOCK_TIMEOUT_MS = 60_000;
const STALE_LOCK_MS = 5 * 60_000;
const REMOTE_STALE_LOCK_MS = 24 * 60 * 60_000;
const RETRY_MS = 25;
const heldEnvironmentLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

function environmentLockPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Environment lock name: ${name}`);
  return path.join(womaHome(), "locks", "environments", `${name}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(directory: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.hostname === "string" &&
      typeof value.acquiredAt === "string"
    ) return value as LockOwner;
  } catch {
    // A process can die between mkdir and writing owner.json. The directory mtime handles that case.
  }
  return undefined;
}

async function stale(directory: string): Promise<boolean> {
  const info = await stat(directory).catch(() => undefined);
  const age = info ? Date.now() - info.mtimeMs : 0;
  if (!info || age < STALE_LOCK_MS) return false;
  const owner = await readOwner(directory);
  if (!owner) return true;
  if (owner.hostname !== hostname()) return age >= REMOTE_STALE_LOCK_MS;
  return !processIsAlive(owner.pid);
}

async function breakStaleLock(directory: string): Promise<void> {
  const tombstone = `${directory}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(directory, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
}

async function acquire(directory: string, label: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const started = Date.now();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeJsonAtomic(path.join(directory, "owner.json"), owner);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const current = await readOwner(directory);
        if (current?.token === owner.token) await rm(directory, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await stale(directory)) {
        await breakStaleLock(directory);
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        const current = await readOwner(directory);
        const detail = current ? ` held by pid ${current.pid} on ${current.hostname} since ${current.acquiredAt}` : "";
        throw new Error(`Timed out waiting for ${label} lock${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

export async function withEnvironmentLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = environmentLockPath(name);
  const held = heldEnvironmentLocks.getStore();
  if (held?.get(lockPath)?.active) return operation();
  const release = await acquire(lockPath, `Environment ${name}`);
  const lease = { active: true };
  try {
    return await heldEnvironmentLocks.run(new Map([...(held ?? []), [lockPath, lease]]), operation);
  } finally {
    lease.active = false;
    await release();
  }
}

export async function canonicalPrefix(input: string): Promise<string> {
  const resolved = path.resolve(input);
  try { return await realpath(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonicalPrefix(path.dirname(resolved)), path.basename(resolved));
  }
}

export async function withPrefixLock<T>(prefix: string, operation: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(await canonicalPrefix(prefix)).digest("hex");
  return withEnvironmentLock(key, operation);
}

export async function withPackageLock<T>(name: string, cacheKey: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Package lock name: ${name}`);
  if (!/^[a-f0-9]{20}$/.test(cacheKey)) throw new Error(`Invalid Package cache key: ${cacheKey}`);
  const directory = path.join(womaHome(), "locks", "packages", name, `${cacheKey}.lock`);
  const release = await acquire(directory, `Package ${name}/${cacheKey}`);
  try {
    return await operation();
  } finally {
    await release();
  }
}
