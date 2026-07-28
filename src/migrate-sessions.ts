import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_SESSION_ENTRIES } from "./agent-state-paths.js";
import { environmentSnapshot } from "./environment.js";
import { withEnvironmentLock } from "./environment-lock.js";
import { writeBufferPreservingFile } from "./fs.js";
import { environmentAgentHomePath, sourceAgentHome } from "./view.js";
import type { CodexClaudePlatform } from "./types.js";

const STRUCTURED_JSONL_ENTRIES = new Set(["history.jsonl", "session_index.jsonl"]);

export type SessionMigrationSource = CodexClaudePlatform | "both";

interface SessionEntry {
  platform: CodexClaudePlatform;
  name: string;
  source: string;
  fingerprint: string;
  files: number;
  bytes: number;
}

export interface SessionMigrationResult {
  environment: string;
  from: SessionMigrationSource;
  entries: { platform: CodexClaudePlatform; name: string; files: number; bytes: number; recordsAdded?: number; recordsDeduplicated?: number }[];
  dryRun: boolean;
  unchanged: boolean;
}

interface JsonlRecord {
  raw: string;
  identity: string;
  order: number;
  timestamp?: number;
}

interface StructuredMerge {
  entry: SessionEntry;
  staged: string;
  destination: string;
  targetInput: Buffer | null;
  targetMode?: number;
  legacyLink?: string;
  output: Buffer;
  recordsAdded: number;
  recordsDeduplicated: number;
}

interface LegacyLink {
  entry: SessionEntry;
  relative: string;
  destination: string;
  link: string;
}

interface ReplacedLegacyLink extends LegacyLink {
  backup: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonl(
  input: Buffer | null,
  filePath: string,
  platform: CodexClaudePlatform,
  name: string,
  orderOffset = 0,
): JsonlRecord[] {
  if (!input || input.length === 0) return [];
  const records: JsonlRecord[] = [];
  for (const [index, raw] of input.toString("utf8").split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Cannot migrate ${filePath}:${index + 1}: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Cannot migrate ${filePath}:${index + 1}: record must be an object`);
    }
    const object = value as Record<string, unknown>;
    const isHistory = name === "history.jsonl";
    const sessionField = platform === "codex" ? "session_id" : "sessionId";
    const timestampField = platform === "codex" ? "ts" : "timestamp";
    if (isHistory && (typeof object[sessionField] !== "string" || object[sessionField].length === 0)) {
      throw new Error(`Cannot migrate ${filePath}:${index + 1}: ${sessionField} must be a non-empty string`);
    }
    if (isHistory && (typeof object[timestampField] !== "number" || !Number.isFinite(object[timestampField]))) {
      throw new Error(`Cannot migrate ${filePath}:${index + 1}: ${timestampField} must be a finite number`);
    }
    const normalized = canonical(object);
    const timestamp = isHistory ? object[timestampField] : object.ts;
    records.push({
      raw,
      identity: createHash("sha256").update(normalized).digest("hex"),
      order: orderOffset + records.length,
      ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}),
    });
  }
  return records;
}

function mergeJsonl(target: JsonlRecord[], source: JsonlRecord[]): {
  output: Buffer;
  recordsAdded: number;
  recordsDeduplicated: number;
} {
  const records: JsonlRecord[] = [];
  const identities = new Set<string>();
  let recordsAdded = 0;
  let recordsDeduplicated = 0;
  for (const record of [...target, ...source]) {
    if (identities.has(record.identity)) {
      recordsDeduplicated += 1;
      continue;
    }
    identities.add(record.identity);
    records.push(record);
    if (record.order >= target.length) recordsAdded += 1;
  }
  if (records.every((record) => record.timestamp !== undefined)) {
    records.sort((left, right) => left.timestamp! - right.timestamp! || left.order - right.order);
  }
  return {
    output: Buffer.from(records.length > 0 ? `${records.map((record) => record.raw).join("\n")}\n` : ""),
    recordsAdded,
    recordsDeduplicated,
  };
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
  const platforms: CodexClaudePlatform[] = source === "both" ? ["codex", "claude"] : [source];
  const entries: SessionEntry[] = [];
  for (const platform of platforms) {
    const home = sourceAgentHome(platform);
    for (const name of AGENT_SESSION_ENTRIES[platform]) {
      const candidate = path.join(home, name);
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue;
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

async function prepareStructuredMerges(
  root: string,
  environment: string,
  entries: SessionEntry[],
): Promise<StructuredMerge[]> {
  const merges: StructuredMerge[] = [];
  for (const entry of entries.filter((candidate) => STRUCTURED_JSONL_ENTRIES.has(candidate.name))) {
    const staged = path.join(root, entry.platform, entry.name);
    const destination = path.join(environmentAgentHomePath(environment, entry.platform), entry.name);
    const destinationInfo = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const legacyLink = destinationInfo?.isSymbolicLink()
      ? await readlink(destination)
      : undefined;
    if (legacyLink !== undefined && path.resolve(path.dirname(destination), legacyLink) !== path.resolve(entry.source)) {
      throw new Error(`Session migration conflicts with existing target state: ${destination}`);
    }
    if (destinationInfo && !destinationInfo.isFile() && legacyLink === undefined) {
      throw new Error(`Session migration conflicts with existing target state: ${destination}`);
    }
    const [sourceInput, targetInput] = await Promise.all([
      readFile(staged),
      destinationInfo ? readFile(destination) : Promise.resolve(null),
    ]);
    const targetRecords = parseJsonl(targetInput, destination, entry.platform, entry.name);
    const sourceRecords = parseJsonl(sourceInput, entry.source, entry.platform, entry.name, targetRecords.length);
    const merged = mergeJsonl(targetRecords, sourceRecords);
    await writeFile(staged, merged.output);
    merges.push({
      entry,
      staged,
      destination,
      targetInput,
      ...(destinationInfo && legacyLink === undefined ? { targetMode: destinationInfo.mode } : {}),
      ...(legacyLink === undefined ? {} : { legacyLink }),
      ...merged,
    });
  }
  return merges;
}

async function currentTargetInput(merge: StructuredMerge): Promise<Buffer | null> {
  const info = await lstat(merge.destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return null;
  if (merge.legacyLink !== undefined) {
    if (!info.isSymbolicLink() || await readlink(merge.destination) !== merge.legacyLink) {
      throw new Error(`Session migration target changed while the snapshot was being published: ${merge.destination}`);
    }
    return readFile(merge.destination);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Session migration target changed while the snapshot was being published: ${merge.destination}`);
  }
  return readFile(merge.destination);
}

async function discoverLegacyLinks(environment: string, entries: SessionEntry[]): Promise<LegacyLink[]> {
  const links: LegacyLink[] = [];
  for (const entry of entries) {
    const root = path.join(environmentAgentHomePath(environment, entry.platform), entry.name);
    async function visit(source: string, destination: string, relative: string): Promise<void> {
      const [sourceInfo, destinationInfo] = await Promise.all([
        lstat(source),
        lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      ]);
      if (!destinationInfo) return;
      if (destinationInfo.isSymbolicLink()) {
        const link = await readlink(destination);
        if (path.resolve(path.dirname(destination), link) !== path.resolve(source)) {
          throw new Error(`Session migration conflicts with existing target state: ${destination}`);
        }
        links.push({ entry, relative, destination, link });
        return;
      }
      if (!sourceInfo.isDirectory() || !destinationInfo.isDirectory()) return;
      for (const name of (await readdir(source)).sort()) {
        await visit(path.join(source, name), path.join(destination, name), path.join(relative, name));
      }
    }
    await visit(entry.source, root, "");
  }
  return links;
}

async function assertLegacyLinksUnchanged(links: LegacyLink[]): Promise<void> {
  for (const legacy of links) {
    const info = await lstat(legacy.destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isSymbolicLink() || await readlink(legacy.destination) !== legacy.link) {
      throw new Error(`Session migration target changed while the snapshot was being published: ${legacy.destination}`);
    }
  }
}

function sameInput(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
  return leftContent.equals(rightContent);
}

async function assertMergeable(source: string, destination: string, legacyDestinations = new Set<string>()): Promise<boolean> {
  const [sourceInfo, destinationInfo] = await Promise.all([
    lstat(source),
    lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  if (!destinationInfo) return false;
  if (legacyDestinations.has(destination)) return false;
  if (sourceInfo.isDirectory() && destinationInfo.isDirectory() && !destinationInfo.isSymbolicLink()) {
    let unchanged = true;
    for (const name of (await readdir(source)).sort()) {
      unchanged = (await assertMergeable(path.join(source, name), path.join(destination, name), legacyDestinations)) && unchanged;
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

async function restoreStructuredMerges(replaced: { merge: StructuredMerge; content: Buffer; mode: number }[]): Promise<void> {
  const errors: unknown[] = [];
  for (const { merge, content, mode } of [...replaced].reverse()) {
    try {
      await writeBufferPreservingFile(merge.destination, content, mode);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not roll back structured session history");
}

async function replaceLegacyLink(staged: string, legacy: LegacyLink): Promise<ReplacedLegacyLink> {
  const backup = `${legacy.destination}.woma-link-backup-${process.pid}-${randomUUID()}`;
  await rename(legacy.destination, backup);
  try {
    await rename(staged, legacy.destination);
  } catch (error) {
    await rename(backup, legacy.destination);
    throw error;
  }
  return { ...legacy, backup };
}

async function restoreLegacyLinks(replaced: ReplacedLegacyLink[]): Promise<void> {
  const errors: unknown[] = [];
  for (const legacy of [...replaced].reverse()) {
    try {
      await rm(legacy.destination, { recursive: true, force: true });
      const backup = await lstat(legacy.backup).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (backup) await rename(legacy.backup, legacy.destination);
      else await symlink(legacy.link, legacy.destination);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not roll back legacy session links");
}

async function removeLegacyLinkBackups(replaced: ReplacedLegacyLink[]): Promise<void> {
  for (const legacy of replaced) await rm(legacy.backup, { force: true });
}

export async function migrateExistingSessions(options: {
  projectRoot: string;
  environment: string;
  from: SessionMigrationSource;
  dryRun?: boolean;
}): Promise<SessionMigrationResult> {
  const snapshot = await environmentSnapshot(options.projectRoot, options.environment);
  const platforms: CodexClaudePlatform[] = options.from === "both" ? ["codex", "claude"] : [options.from];
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
    const structuredMerges = await prepareStructuredMerges(temporary, options.environment, entries);
    const structuredNames = new Set(structuredMerges.map((merge) => `${merge.entry.platform}:${merge.entry.name}`));
    const legacyLinks = await discoverLegacyLinks(options.environment, entries);
    const legacyDestinations = new Set(legacyLinks.map((legacy) => legacy.destination));
    const topLevelLegacyNames = new Set(legacyLinks
      .filter((legacy) => legacy.relative === "")
      .map((legacy) => `${legacy.entry.platform}:${legacy.entry.name}`));
    let unchanged = true;
    for (const entry of entries.filter((candidate) => {
      const key = `${candidate.platform}:${candidate.name}`;
      return !structuredNames.has(key);
    })) {
      unchanged = (await assertMergeable(
        path.join(temporary, entry.platform, entry.name),
        path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
        legacyDestinations,
      )) && unchanged;
    }
    for (const merge of structuredMerges) {
      unchanged = merge.legacyLink === undefined && sameInput(merge.targetInput, merge.output) && unchanged;
    }
    if (legacyLinks.length > 0) unchanged = false;
    const result: SessionMigrationResult = {
      environment: options.environment,
      from: options.from,
      entries: entries.map(({ platform, name, files, bytes }) => {
        const structured = structuredMerges.find((merge) => merge.entry.platform === platform && merge.entry.name === name);
        return {
          platform,
          name,
          files,
          bytes,
          ...(structured
            ? { recordsAdded: structured.recordsAdded, recordsDeduplicated: structured.recordsDeduplicated }
            : {}),
        };
      }),
      dryRun: options.dryRun ?? false,
      unchanged,
    };
    if (options.dryRun || unchanged) return result;

    await withEnvironmentLock(options.environment, async () => {
      for (const entry of entries) {
        const current = await summarizeTree(entry.source);
        if (current.fingerprint !== entry.fingerprint) {
          throw new Error(`Existing ${entry.platform} session state changed while it was being migrated; retry the command`);
        }
      }
      for (const platform of platforms) {
        const home = environmentAgentHomePath(options.environment, platform);
        const info = await lstat(home).catch(() => undefined);
        if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Stable Agent home is missing or invalid: ${home}`);
      }
      for (const merge of structuredMerges) {
        const current = await currentTargetInput(merge);
        if (!sameInput(current, merge.targetInput)) {
          throw new Error(`Session migration target changed while the snapshot was being published: ${merge.destination}`);
        }
      }
      await assertLegacyLinksUnchanged(legacyLinks);
      for (const entry of entries.filter((candidate) => {
        const key = `${candidate.platform}:${candidate.name}`;
        return !structuredNames.has(key);
      })) {
        await assertMergeable(
          path.join(temporary, entry.platform, entry.name),
          path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
          legacyDestinations,
        );
      }
      const created: string[] = [];
      const replaced: { merge: StructuredMerge; content: Buffer; mode: number }[] = [];
      const replacedLinks: ReplacedLegacyLink[] = [];
      try {
        for (const legacy of legacyLinks.filter((candidate) => !structuredNames.has(`${candidate.entry.platform}:${candidate.entry.name}`))) {
          replacedLinks.push(await replaceLegacyLink(
            path.join(temporary, legacy.entry.platform, legacy.entry.name, legacy.relative),
            legacy,
          ));
        }
        for (const entry of entries.filter((candidate) => {
          const key = `${candidate.platform}:${candidate.name}`;
          return !structuredNames.has(key) && !topLevelLegacyNames.has(key);
        })) {
          await mergeSnapshot(
            path.join(temporary, entry.platform, entry.name),
            path.join(environmentAgentHomePath(options.environment, entry.platform), entry.name),
            created,
          );
        }
        for (const merge of structuredMerges) {
          if (merge.legacyLink !== undefined) {
            replacedLinks.push(await replaceLegacyLink(merge.staged, {
              entry: merge.entry,
              relative: "",
              destination: merge.destination,
              link: merge.legacyLink,
            }));
          } else if (sameInput(merge.targetInput, merge.output)) {
            continue;
          } else if (merge.targetInput === null) {
            const sourceMode = await stat(merge.staged).then((info) => info.mode);
            await writeBufferPreservingFile(merge.destination, merge.output, sourceMode);
            created.push(merge.destination);
          } else {
            replaced.push({ merge, content: merge.targetInput, mode: merge.targetMode! });
            await writeBufferPreservingFile(merge.destination, merge.output, merge.targetMode);
          }
        }
        await removeLegacyLinkBackups(replacedLinks);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          await restoreStructuredMerges(replaced);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await restoreLegacyLinks(replacedLinks);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await removeCreated(created);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "Session migration failed and rollback was incomplete");
        }
        throw error;
      }
    });
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
