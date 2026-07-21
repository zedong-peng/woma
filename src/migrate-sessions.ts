import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { environmentSnapshot } from "./environment.js";
import { withEnvironmentLock } from "./environment-lock.js";
import { pathExists } from "./fs.js";
import { environmentAgentHomePath, sourceAgentHome } from "./view.js";
import type { Platform } from "./types.js";

const SESSION_ENTRIES: Record<Platform, string[]> = {
  codex: ["archived_sessions", "history.jsonl", "session_index.jsonl", "sessions", "shell_snapshots"],
  claude: ["file-history", "history.jsonl", "plans", "projects", "session-env", "shell-snapshots", "tasks", "todos"],
};

export type SessionMigrationSource = Platform | "both";

interface SessionEntry {
  platform: Platform;
  name: string;
  source: string;
  fingerprint: string;
  files: number;
  bytes: number;
}

export interface SessionMigrationResult {
  environment: string;
  from: SessionMigrationSource;
  entries: { platform: Platform; name: string; files: number; bytes: number }[];
  dryRun: boolean;
  unchanged: boolean;
}

interface TreeSummary {
  fingerprint: string;
  files: number;
  bytes: number;
}

async function summarizeTree(root: string): Promise<TreeSummary> {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  async function visit(current: string, relative: string): Promise<void> {
    const info = await lstat(current);
    const display = relative.split(path.sep).join("/");
    if (info.isSymbolicLink()) throw new Error(`Session migration does not support symbolic links: ${current}`);
    if (info.isDirectory()) {
      hash.update(`directory:${display}:${info.mode & 0o777}\0`);
      for (const name of (await readdir(current)).sort()) await visit(path.join(current, name), path.join(relative, name));
      return;
    }
    if (!info.isFile()) throw new Error(`Session migration does not support special files: ${current}`);
    const content = await readFile(current);
    hash.update(`file:${display}:${info.mode & 0o777}:${content.length}\0`);
    hash.update(content);
    hash.update("\0");
    files += 1;
    bytes += content.length;
  }
  await visit(root, "");
  return { fingerprint: hash.digest("hex"), files, bytes };
}

async function discoverEntries(source: SessionMigrationSource): Promise<SessionEntry[]> {
  const platforms: Platform[] = source === "both" ? ["codex", "claude"] : [source];
  const entries: SessionEntry[] = [];
  for (const platform of platforms) {
    const home = sourceAgentHome(platform);
    for (const name of SESSION_ENTRIES[platform]) {
      const candidate = path.join(home, name);
      if (!(await pathExists(candidate))) continue;
      const summary = await summarizeTree(candidate);
      entries.push({ platform, name, source: candidate, ...summary });
    }
  }
  if (entries.length === 0) throw new Error(`No existing Agent session state found for --from ${source}`);
  return entries;
}

async function buildSnapshot(root: string, entries: SessionEntry[]): Promise<void> {
  for (const entry of entries) {
    const destination = path.join(root, entry.platform, entry.name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(entry.source, destination, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    const copied = await summarizeTree(destination);
    const current = await summarizeTree(entry.source);
    if (copied.fingerprint !== entry.fingerprint || current.fingerprint !== entry.fingerprint) {
      throw new Error(`Existing ${entry.platform} session state changed while it was being migrated; retry the command`);
    }
  }
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
  return leftContent.equals(rightContent);
}

async function assertMergeable(source: string, destination: string): Promise<boolean> {
  const [sourceInfo, destinationInfo] = await Promise.all([
    lstat(source),
    lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  if (!destinationInfo) return false;
  if (sourceInfo.isDirectory() && destinationInfo.isDirectory() && !destinationInfo.isSymbolicLink()) {
    let unchanged = true;
    for (const name of (await readdir(source)).sort()) {
      unchanged = (await assertMergeable(path.join(source, name), path.join(destination, name))) && unchanged;
    }
    return unchanged;
  }
  if (sourceInfo.isFile() && destinationInfo.isFile() && await filesEqual(source, destination)) return true;
  throw new Error(`Session migration conflicts with existing target state: ${destination}`);
}

async function mergeSnapshot(source: string, destination: string, created: string[]): Promise<void> {
  const destinationInfo = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!destinationInfo) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
    created.push(destination);
    return;
  }
  const sourceInfo = await lstat(source);
  if (sourceInfo.isDirectory() && destinationInfo.isDirectory() && !destinationInfo.isSymbolicLink()) {
    for (const name of (await readdir(source)).sort()) {
      await mergeSnapshot(path.join(source, name), path.join(destination, name), created);
    }
    return;
  }
  if (sourceInfo.isFile() && destinationInfo.isFile() && await filesEqual(source, destination)) return;
  throw new Error(`Session migration target changed while the snapshot was being published: ${destination}`);
}

async function removeCreated(paths: string[]): Promise<void> {
  const errors: unknown[] = [];
  for (const created of [...paths].reverse()) {
    try {
      await rm(created, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not roll back migrated session state");
}

export async function migrateExistingSessions(options: {
  projectRoot: string;
  environment: string;
  from: SessionMigrationSource;
  dryRun?: boolean;
}): Promise<SessionMigrationResult> {
  const snapshot = await environmentSnapshot(options.projectRoot, options.environment);
  const platforms: Platform[] = options.from === "both" ? ["codex", "claude"] : [options.from];
  for (const platform of platforms) {
    if (!snapshot.environment.spec.targets.includes(platform)) {
      throw new Error(`Environment ${options.environment} does not support ${platform}; choose a compatible --from value`);
    }
  }
  const entries = await discoverEntries(options.from);
  const homeRoot = path.dirname(environmentAgentHomePath(options.environment, "codex"));
  const temporaryParent = options.dryRun ? os.tmpdir() : homeRoot;
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(temporaryParent, ".sessions-migration-"));
  try {
    await buildSnapshot(temporary, entries);
    let unchanged = true;
    for (const entry of entries) {
      unchanged = (await assertMergeable(
        path.join(temporary, entry.platform, entry.name),
        path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
      )) && unchanged;
    }
    const result: SessionMigrationResult = {
      environment: options.environment,
      from: options.from,
      entries: entries.map(({ platform, name, files, bytes }) => ({ platform, name, files, bytes })),
      dryRun: options.dryRun ?? false,
      unchanged,
    };
    if (options.dryRun || unchanged) return result;

    await withEnvironmentLock(options.environment, async () => {
      for (const platform of platforms) {
        const home = environmentAgentHomePath(options.environment, platform);
        const info = await lstat(home).catch(() => undefined);
        if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Stable Agent home is missing or invalid: ${home}`);
      }
      for (const entry of entries) {
        await assertMergeable(
          path.join(temporary, entry.platform, entry.name),
          path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
        );
      }
      const created: string[] = [];
      try {
        for (const entry of entries) {
          await mergeSnapshot(
            path.join(temporary, entry.platform, entry.name),
            path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
            created,
          );
        }
      } catch (error) {
        try {
          await removeCreated(created);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Session migration failed and rollback was incomplete");
        }
        throw error;
      }
    });
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
