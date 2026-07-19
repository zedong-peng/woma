import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await pathExists(filePath))) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export async function writeTextPreservingFile(filePath: string, content: string): Promise<void> {
  const linkInfo = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const target = linkInfo?.isSymbolicLink()
    ? await realpath(filePath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        const linked = await readlink(filePath);
        return path.resolve(path.dirname(filePath), linked);
      })
    : filePath;
  const targetInfo = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, content, { encoding: "utf8", ...(targetInfo ? { mode: targetInfo.mode } : {}) });
  if (targetInfo) await chmod(tempPath, targetInfo.mode);
  await rename(tempPath, target);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function harnessHome(): string {
  return process.env.HARNESS_HOME ? path.resolve(process.env.HARNESS_HOME) : path.join(os.homedir(), ".harness-conda");
}

export function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the harness package: ${candidate}`);
  }
}

const ignoredNames = new Set([".git", ".harness", "node_modules", ".DS_Store"]);

async function hashEntry(root: string, relative: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute);
  const normalized = relative.split(path.sep).join("/");
  if (info.isSymbolicLink()) {
    hash.update(`link:${normalized}:${await readlink(absolute)}\0`);
    return;
  }
  if (info.isDirectory()) {
    const entries = (await readdir(absolute)).filter((entry) => !ignoredNames.has(entry)).sort();
    for (const entry of entries) await hashEntry(root, path.join(relative, entry), hash);
    return;
  }
  if (!info.isFile()) return;
  // Cache publication removes write bits; integrity tracks content and executable/readable shape, not mutability.
  hash.update(`file:${normalized}:${info.mode & 0o555}\0`);
  hash.update(await readFile(absolute));
  hash.update("\0");
}

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashEntry(root, "", hash);
  return `sha256-${hash.digest("hex")}`;
}

export async function removeEmptyParents(start: string, stop: string): Promise<void> {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (current !== boundary && current.startsWith(`${boundary}${path.sep}`)) {
    const entries = await readdir(current).catch(() => ["not-empty"]);
    if (entries.length > 0) break;
    await rm(current, { recursive: true });
    current = path.dirname(current);
  }
}

export function relativeDisplay(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative || ".";
}
