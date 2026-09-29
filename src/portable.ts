import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { create as createTar, extract, list } from "tar";
import { cachePath, copyContent, publishContent, removeTree } from "./content.js";
import { describePackage } from "./package.js";
import { parseLock } from "./schema.js";
import { canonicalSource, gitIntent } from "./source.js";
import type { EnvironmentLock, EnvironmentRecipe, PackageRecord } from "./types.js";

export interface PortableLock { lock: EnvironmentLock; converted: string[]; local: string[] }

/**
 * Rewrite local packages that have a verified Git origin as Git packages, so the lock can be recreated elsewhere.
 * A package is rewritten only if its snapshot describes identically under the Git source (dependencies included).
 */
export async function portableLock(input: EnvironmentLock): Promise<PortableLock> {
  const lock = structuredClone(input);
  let candidates = new Set(Object.values(lock.packages).filter((p) => p.source.type === "local" && p.origin).map((p) => p.name));
  let result: Record<string, PackageRecord> = {};
  let intents = new Map<string, string>();
  for (;;) {
    intents = new Map<string, string>();
    for (const name of candidates) {
      const record = lock.packages[name]!;
      const origin = record.origin!;
      intents.set(canonicalSource(`file:${(record.source as { path: string }).path}`), gitIntent({ url: origin.url, ref: origin.commit, subdirectory: origin.subdirectory }));
    }
    const remap = (source: string) => intents.get(canonicalSource(source)) ?? source;
    result = {};
    const failed: string[] = [];
    for (const record of Object.values(lock.packages)) {
      const { origin, ...rest } = record;
      const next: PackageRecord = { ...rest, dependencies: record.dependencies.map((d) => ({ ...d, source: remap(d.source) })) };
      if (candidates.has(record.name) && origin) {
        next.source = { type: "git", url: origin.url, commit: origin.commit, ...(origin.subdirectory ? { subdirectory: origin.subdirectory } : {}) };
        const described = await describePackage(cachePath(record.integrity), next.source, record.integrity).catch(() => undefined);
        if (!described || !isDeepStrictEqual(described, next)) failed.push(record.name);
      } else if (origin) next.origin = origin;
      result[record.name] = next;
    }
    if (!failed.length) break;
    candidates = new Set([...candidates].filter((name) => !failed.includes(name)));
  }
  const remap = (source: string) => intents.get(canonicalSource(source)) ?? source;
  lock.packages = result;
  lock.recipe.packages = lock.recipe.packages.map((p) => ({ ...p, source: remap(p.source) }));
  const local = Object.values(result).filter((p) => p.source.type === "local").map((p) => p.name);
  return { lock, converted: [...candidates], local };
}

/** A recipe others can use: sources are Git locations or paths relative to the recipe file. */
export function portableRecipe(recipe: EnvironmentRecipe, file?: string): Record<string, unknown> {
  const directory = file ? path.dirname(path.resolve(file)) : undefined;
  const packages = recipe.packages.map((p) => {
    if (!p.source.startsWith("file:")) return p.source;
    if (!directory) return p.source.slice(5);
    const relative = path.relative(directory, p.source.slice(5)).split(path.sep).join("/");
    return relative.startsWith("../") || relative === ".." ? relative : `./${relative}`;
  });
  return {
    format: recipe.format, name: recipe.name, agents: recipe.agents, packages,
    ...(Object.keys(recipe.mcp_servers).length ? { mcp_servers: recipe.mcp_servers } : {}),
  };
}

const packFormat = "woma.pack/v1";

/** Write a single-file environment: the exact lock plus every package snapshot. */
export async function writePack(lock: EnvironmentLock, file: string): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "woma-pack-"));
  try {
    const records = Object.values(lock.packages);
    await writeFile(path.join(temp, "woma-pack.json"), `${JSON.stringify({ format: packFormat, lock }, null, 2)}\n`);
    await mkdir(path.join(temp, "store"));
    for (const record of records) await copyContent(cachePath(record.integrity), path.join(temp, "store", record.integrity.slice(7)));
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await createTar({ gzip: true, file, cwd: temp, portable: true, noMtime: true }, ["woma-pack.json", "store"]);
  } finally { await removeTree(temp); }
}

export async function isPack(file: string): Promise<boolean> {
  const bytes = await readFile(file);
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Import a pack's snapshots into the content store and return its lock. */
export async function readPack(file: string): Promise<EnvironmentLock> {
  const invalid: string[] = [];
  await list({ file, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, "");
    const parts = name.split("/");
    const allowed = name === "woma-pack.json" || name === "store" || (parts[0] === "store" && /^[a-f0-9]{64}$/.test(parts[1] ?? ""));
    if (!allowed || name.includes("\\") || parts.some((p) => p === ".." || p === "") || !["File", "Directory"].includes(entry.type)) invalid.push(entry.path);
  } });
  if (invalid.length) throw new Error(`Invalid pack entry: ${invalid[0]}`);
  const temp = await mkdtemp(path.join(os.tmpdir(), "woma-unpack-"));
  try {
    await extract({ file, cwd: temp, strict: true, preserveOwner: false });
    const data = JSON.parse(await readFile(path.join(temp, "woma-pack.json"), "utf8")) as { format?: unknown; lock?: unknown };
    if (data.format !== packFormat) throw new Error(`Unsupported pack format: ${String(data.format)}`);
    const lock = parseLock(data.lock);
    for (const record of Object.values(lock.packages)) {
      await publishContent(path.join(temp, "store", record.integrity.slice(7)), record.integrity).catch((error: Error) => {
        throw new Error(`Pack is missing or corrupts ${record.name}: ${error.message}`);
      });
    }
    return lock;
  } finally { await removeTree(temp); }
}
