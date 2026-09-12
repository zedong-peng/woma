import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { satisfies, valid } from "semver";
import { extract, list } from "tar";
import { cachePath, publishContent, removeTree, verifyContent } from "./content.js";
import { withPackageLock } from "./environment-lock.js";
import { pathExists, womaHome, writeJsonAtomic } from "./fs.js";
import { parsePackageRecord } from "./schema.js";
import type { Harness, InstalledPackage, PackageRecord, RuntimeArtifact } from "./types.js";

export interface RuntimeProvider {
  resolve(harness: Harness, version: string): Promise<InstalledPackage>;
  restore(record: PackageRecord): Promise<InstalledPackage>;
}

export function runtimePlatform(): string {
  if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error(`Unsupported runtime platform: ${process.platform}-${process.arch}`);
  const musl = process.platform === "linux" && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
  return `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
}

const officialNames: Record<Harness, string> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };
interface Metadata {
  name: string; version: string; dist: { tarball: string; integrity: string };
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  engines?: { node?: string };
}

function officialUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org" || parsed.username || parsed.password || parsed.port) throw new Error(`Runtime source is not the official npm registry: ${url}`);
  return parsed.href;
}

async function metadata(name: string, version: string): Promise<Metadata> {
  const url = `https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok) throw new Error(`Official runtime release unavailable: ${name}@${version} (HTTP ${response.status})`);
  const data = await response.json() as Metadata;
  if (data.name !== name || !valid(data.version) || (version !== "latest" && data.version !== version)) throw new Error(`Official runtime identity mismatch: ${name}@${version}`);
  officialUrl(data.dist?.tarball);
  if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(data.dist?.integrity)) throw new Error(`Official runtime release has no SHA-512 integrity: ${name}@${version}`);
  if (Object.keys(data.dependencies ?? {}).length) throw new Error(`Runtime ${name}@${version} has unsupported non-bundled dependencies`);
  return data;
}

async function downloadArtifact(artifact: RuntimeArtifact, file: string): Promise<void> {
  const response = await fetch(officialUrl(artifact.url), { signal: AbortSignal.timeout(300_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: ${artifact.url} (HTTP ${response.status})`);
  const hash = createHash("sha512");
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({
    transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
  }), createWriteStream(file, { flags: "wx" }));
  const actual = `sha512-${hash.digest("base64")}`;
  if (actual !== artifact.integrity) throw new Error(`Runtime download integrity mismatch for ${artifact.name}: expected ${artifact.integrity}, got ${actual}`);
}

export async function extractRuntimeArchive(file: string, root: string): Promise<void> {
  const invalid: string[] = [];
  const paths = new Set<string>();
  await list({ file, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, "");
    if (!name.startsWith("package/") && name !== "package" || name.includes("\\") || name.split("/").some((p) => p === ".." || p === "") || !["File", "Directory"].includes(entry.type) || paths.has(name)) invalid.push(entry.path);
    paths.add(name);
  } });
  if (invalid.length) throw new Error(`Unsafe runtime archive entry: ${invalid[0]}`);
  await mkdir(root, { recursive: true });
  await extract({ file, cwd: root, strip: 1, strict: true, preserveOwner: false });
}

async function materializeRuntime(harness: Harness, version: string, artifacts: RuntimeArtifact[], expected?: PackageRecord): Promise<InstalledPackage> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "woma-runtime-"));
  const tree = path.join(temp, "content");
  try {
    for (const [index, artifact] of artifacts.entries()) {
      const archive = path.join(temp, `${index}.tgz`);
      await downloadArtifact(artifact, archive);
      const destination = path.join(tree, artifact.directory);
      await extractRuntimeArchive(archive, destination);
      const identity = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8")) as Metadata;
      if (identity.name !== artifact.name || identity.version !== artifact.version) throw new Error(`Runtime artifact identity mismatch: ${artifact.name}@${artifact.version}`);
    }
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const triple = `${arch}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
    const candidates = harness === "codex"
      ? [`platform/vendor/${triple}/bin/codex`, `platform/vendor/${triple}/codex/codex`, `package/vendor/${triple}/bin/codex`, `package/vendor/${triple}/codex/codex`]
      : ["platform/claude", "platform/bin/claude", "package/cli.js"];
    const executable = expected?.source.type === "runtime" ? expected.source.executable : (await Promise.all(candidates.map(async (file) => await pathExists(path.join(tree, file)) ? file : undefined))).find(Boolean);
    if (!executable || !(await lstat(path.join(tree, executable))).isFile()) throw new Error(`Unsupported official ${harness}@${version} executable layout`);
    if (executable.endsWith(".js")) {
      const data = JSON.parse(await readFile(path.join(tree, "package/package.json"), "utf8")) as Metadata;
      if (data.engines?.node && !satisfies(process.version, data.engines.node)) throw new Error(`${harness}@${version} requires Node.js ${data.engines.node}`);
    } else await chmod(path.join(tree, executable), 0o755);
    const cached = await publishContent(tree, expected?.integrity);
    const record: PackageRecord = expected ?? {
      name: harness, kind: "runtime", version,
      source: { type: "runtime", provider: "npm", platform: runtimePlatform(), artifacts, executable },
      integrity: cached.integrity, dependencies: [], harnesses: { [harness]: "*" }, skills: [],
    };
    await verifyRuntimeIdentity(record, cached.root);
    return { root: cached.root, record };
  } finally { await removeTree(temp); }
}

export async function verifyRuntimeIdentity(record: PackageRecord, root: string): Promise<void> {
  if (record.kind !== "runtime" || record.source.type !== "runtime" || !["codex", "claude"].includes(record.name)) throw new Error("Invalid locked runtime");
  if (record.source.platform !== runtimePlatform()) throw new Error(`Runtime platform mismatch: lock has ${record.source.platform}, current platform is ${runtimePlatform()}`);
  const harness = record.name as Harness;
  const base = officialNames[harness];
  const platform = harness === "codex" ? runtimePlatform().replace(/-musl$/, "") : runtimePlatform();
  if (!record.source.artifacts.length) throw new Error("Runtime has no official artifacts");
  for (const artifact of record.source.artifacts) {
    officialUrl(artifact.url);
    const allowedVersion = artifact.name === base && harness === "codex" && artifact.directory === "platform" ? `${record.version}-${platform}` : record.version;
    if (![base, `${base}-${platform}`].includes(artifact.name) || ![record.version, allowedVersion].includes(artifact.version)) throw new Error(`Locked runtime artifact identity does not match ${harness}@${record.version}`);
    const identity = JSON.parse(await readFile(path.join(root, artifact.directory, "package.json"), "utf8")) as Metadata;
    if (identity.name !== artifact.name || identity.version !== artifact.version || Object.keys(identity.dependencies ?? {}).length) throw new Error(`Locked runtime metadata does not match artifact ${artifact.name}@${artifact.version}`);
    if (record.source.executable.endsWith(".js") && identity.engines?.node && !satisfies(process.version, identity.engines.node)) throw new Error(`${harness}@${record.version} requires Node.js ${identity.engines.node}`);
  }
  const info = await lstat(path.join(root, record.source.executable)).catch(() => undefined);
  if (!info?.isFile() || (!record.source.executable.endsWith(".js") && !(info.mode & 0o111))) throw new Error(`Locked runtime executable is missing or not executable: ${record.source.executable}`);
}

export const npmRuntimeProvider: RuntimeProvider = {
  async resolve(harness, requested) {
    if (requested !== "latest" && !valid(requested)) throw new Error("Runtime version must be latest or an exact semantic version");
    const main = await metadata(officialNames[harness], requested);
    const platform = runtimePlatform();
    const artifacts: RuntimeArtifact[] = [];
    const platformName = `${officialNames[harness]}-${harness === "codex" ? platform.replace(/-musl$/, "") : platform}`;
    const selected = main.optionalDependencies?.[platformName];
    if (selected) {
      const alias = /^npm:(@[^/]+\/[^@]+)@(.+)$/.exec(selected);
      const release = await metadata(alias ? alias[1]! : platformName, alias ? alias[2]! : selected);
      artifacts.push({ name: release.name, version: release.version, url: release.dist.tarball, integrity: release.dist.integrity, directory: "platform" });
    } else {
      artifacts.push({ name: main.name, version: main.version, url: main.dist.tarball, integrity: main.dist.integrity, directory: "package" });
    }
    const index = path.join(womaHome(), "runtimes", "v2", platform, harness, `${main.version}.json`);
    const key = createHash("sha256").update(`${platform}\0${main.version}`).digest("hex").slice(0, 20);
    return withPackageLock(harness, key, async () => {
      if (await pathExists(index)) {
        const record = parsePackageRecord(JSON.parse(await readFile(index, "utf8")));
        if (record.name !== harness || record.version !== main.version || record.source.type !== "runtime" || !isDeepStrictEqual(record.source.artifacts, artifacts)) throw new Error(`Official runtime source changed for ${harness}@${main.version}; cached release identity differs`);
        return this.restore(record);
      }
      const installed = await materializeRuntime(harness, main.version, artifacts);
      await writeJsonAtomic(index, installed.record);
      return installed;
    });
  },
  async restore(record) {
    record = parsePackageRecord(record);
    if (record.kind !== "runtime" || record.source.type !== "runtime" || !["codex", "claude"].includes(record.name)) throw new Error("Invalid locked runtime");
    if (record.source.platform !== runtimePlatform()) throw new Error(`Runtime platform mismatch: lock has ${record.source.platform}, current platform is ${runtimePlatform()}`);
    for (const artifact of record.source.artifacts) {
      officialUrl(artifact.url);
      const base = officialNames[record.name as Harness];
      if (artifact.name !== base && !artifact.name.startsWith(`${base}-`)) throw new Error(`Unexpected runtime artifact: ${artifact.name}`);
    }
    const root = cachePath(record.integrity);
    if (await pathExists(root)) {
      await verifyContent(root, record.integrity, true);
      await verifyRuntimeIdentity(record, root);
      return { root, record };
    }
    return materializeRuntime(record.name as Harness, record.version, record.source.artifacts, record);
  },
};
