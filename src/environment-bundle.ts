import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { satisfies } from "semver";
import { z } from "zod";
import {
  environmentSnapshot,
  importEnvironmentSnapshot,
  normalizeLegacyEnvironmentSnapshot,
  parseEnvironment,
  parseEnvironmentLock,
  type EnvironmentSnapshot,
} from "./environment.js";
import {
  importLockedPackage,
  loadCachedPackage,
  validateLockedPackageDirectory,
} from "./package.js";
import type { HarnessEnvironment, HarnessManifest, LockFile } from "./types.js";

const FORMAT = "harness.conda/environment-bundle-v1";
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 384 * 1024 * 1024;
const MAX_FILES = 100_000;

const bundleFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    mode: z.number().int().min(0).max(0o777),
    data: z.string(),
  })
  .strict();

const bundledPackageSchema = z
  .object({
    name: z.string().min(1).max(80),
    files: z.array(bundleFileSchema).max(MAX_FILES),
  })
  .strict();

const bundleSchema = z
  .object({
    format: z.literal(FORMAT),
    environment: z.unknown(),
    lock: z.unknown(),
    packages: z.array(bundledPackageSchema).max(1000),
  })
  .strict();

interface BundleFile {
  path: string;
  mode: number;
  data: string;
}

interface BundledPackage {
  name: string;
  files: BundleFile[];
}

interface EnvironmentBundle {
  format: typeof FORMAT;
  environment: HarnessEnvironment;
  lock: LockFile;
  packages: BundledPackage[];
}

export interface EnvironmentBundleResult {
  path: string;
  environment: string;
  packages: number;
  bytes: number;
}

export interface EnvironmentBundleImportResult {
  path: string;
  snapshot: EnvironmentSnapshot;
  packages: number;
  bytes: number;
}

function portablePath(input: string): string {
  const segments = input.split("/");
  if (
    input === "" ||
    input.startsWith("/") ||
    input.includes("\\") ||
    /^[A-Za-z]:/.test(input) ||
    path.posix.normalize(input) !== input ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Bundle contains an unsafe Package path: ${JSON.stringify(input)}`);
  }
  if (segments.some((segment) => [".git", ".harness", "node_modules", ".DS_Store"].includes(segment))) {
    throw new Error(`Bundle contains an excluded Package path: ${JSON.stringify(input)}`);
  }
  return input;
}

function decodeBase64(input: string, label: string): Buffer {
  if (input.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
    throw new Error(`${label} is not canonical Base64`);
  }
  const decoded = Buffer.from(input, "base64");
  if (decoded.toString("base64") !== input) throw new Error(`${label} is not canonical Base64`);
  return decoded;
}

async function collectPackageFiles(root: string): Promise<BundleFile[]> {
  const packageRoot = await realpath(root);
  const files: BundleFile[] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = relative ? path.join(packageRoot, relative) : packageRoot;
    for (const name of (await readdir(absolute)).sort()) {
      const childRelative = relative ? path.join(relative, name) : name;
      const child = path.join(packageRoot, childRelative);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error(`Package bundle export does not support symbolic links: ${childRelative}`);
      if (info.isDirectory()) {
        await visit(childRelative);
        continue;
      }
      if (!info.isFile()) throw new Error(`Package bundle export does not support special files: ${childRelative}`);
      files.push({
        path: portablePath(childRelative.split(path.sep).join("/")),
        mode: info.mode & 0o555,
        data: (await readFile(child)).toString("base64"),
      });
      if (files.length > MAX_FILES) throw new Error(`Package contains more than ${MAX_FILES} files`);
    }
  }
  await visit("");
  return files;
}

function normalizedLock(lock: LockFile): LockFile {
  return {
    lockfileVersion: 1,
    packages: Object.fromEntries(Object.keys(lock.packages).sort().map((name) => [name, lock.packages[name]!])),
  };
}

async function publishExclusive(filePath: string, content: Buffer): Promise<void> {
  const destination = path.resolve(filePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Refusing to overwrite ${destination}`);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function exportEnvironmentBundle(
  projectRoot: string,
  environmentName: string,
  outputPath: string,
): Promise<EnvironmentBundleResult> {
  const { environment, lock } = await environmentSnapshot(projectRoot, environmentName);
  const packages: BundledPackage[] = [];
  for (const name of Object.keys(lock.packages).sort()) {
    const pkg = await loadCachedPackage(lock.packages[name]!);
    packages.push({ name, files: await collectPackageFiles(pkg.root) });
  }
  const bundle: EnvironmentBundle = {
    format: FORMAT,
    environment,
    lock: normalizedLock(lock),
    packages,
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"), { level: 9 });
  await publishExclusive(outputPath, compressed);
  return { path: path.resolve(outputPath), environment: environmentName, packages: packages.length, bytes: compressed.length };
}

function parseBundle(input: Buffer, source: string): EnvironmentBundle {
  if (input.length > MAX_COMPRESSED_BYTES) throw new Error(`Environment bundle exceeds ${MAX_COMPRESSED_BYTES} compressed bytes`);
  let uncompressed: Buffer;
  try {
    uncompressed = gunzipSync(input, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(`Cannot decompress Environment bundle ${source}: ${(error as Error).message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(uncompressed.toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot parse Environment bundle ${source}: ${(error as Error).message}`);
  }
  const parsed = bundleSchema.safeParse(document);
  if (!parsed.success) throw new Error(`Invalid Environment bundle ${source}: ${parsed.error.issues[0]?.message ?? "invalid document"}`);
  const environment = parseEnvironment(JSON.stringify(parsed.data.environment), `${source}:environment`);
  const lock = parseEnvironmentLock(JSON.stringify(parsed.data.lock), `${source}:lock`);
  const packageNames = new Set<string>();
  let totalBytes = 0;
  const packages: BundledPackage[] = parsed.data.packages.map((pkg) => {
    if (packageNames.has(pkg.name)) throw new Error(`Environment bundle contains duplicate Package ${pkg.name}`);
    packageNames.add(pkg.name);
    if (!lock.packages[pkg.name]) throw new Error(`Environment bundle contains undeclared Package ${pkg.name}`);
    const paths = new Set<string>();
    const files = pkg.files.map((file) => {
      const filePath = portablePath(file.path);
      if (paths.has(filePath)) throw new Error(`Environment bundle Package ${pkg.name} contains duplicate path ${filePath}`);
      if ([...paths].some((existing) => existing.startsWith(`${filePath}/`) || filePath.startsWith(`${existing}/`))) {
        throw new Error(`Environment bundle Package ${pkg.name} contains a file/directory path collision at ${filePath}`);
      }
      paths.add(filePath);
      if ((file.mode & 0o222) !== 0) throw new Error(`Environment bundle Package ${pkg.name} contains writable mode for ${filePath}`);
      const content = decodeBase64(file.data, `Environment bundle Package ${pkg.name} file ${filePath}`);
      totalBytes += content.length;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Environment bundle Package payload exceeds ${MAX_PACKAGE_BYTES} bytes`);
      return { path: filePath, mode: file.mode, data: content.toString("base64") };
    });
    return { name: pkg.name, files };
  });
  const missing = Object.keys(lock.packages).filter((name) => !packageNames.has(name));
  if (missing.length > 0) throw new Error(`Environment bundle is missing locked Packages: ${missing.join(", ")}`);
  return { format: FORMAT, environment, lock, packages };
}

async function materializeBundledPackage(root: string, pkg: BundledPackage): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of pkg.files) {
    const destination = path.join(root, ...portablePath(file.path).split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, decodeBase64(file.data, `${pkg.name}:${file.path}`), { flag: "wx", mode: file.mode | 0o200 });
    await chmod(destination, file.mode);
  }
}

function validateBundleClosure(
  environment: HarnessEnvironment,
  lock: LockFile,
  manifests: Map<string, HarnessManifest>,
): void {
  if (new Set(environment.spec.targets).size !== environment.spec.targets.length) {
    throw new Error("Environment bundle contains duplicate targets");
  }
  const visited = new Set<string>();
  const visiting: string[] = [];
  function visit(name: string): void {
    if (visited.has(name)) return;
    const cycleAt = visiting.indexOf(name);
    if (cycleAt !== -1) throw new Error(`Bundled dependency cycle: ${[...visiting.slice(cycleAt), name].join(" -> ")}`);
    const locked = lock.packages[name];
    const manifest = manifests.get(name);
    if (!locked || !manifest) throw new Error(`Bundled root or dependency ${name} is missing`);
    visiting.push(name);
    for (const dependency of manifest.spec.dependencies) {
      const resolved = lock.packages[dependency.name];
      if (!resolved) throw new Error(`Bundled Package ${name} requires missing Package ${dependency.name}`);
      if (!satisfies(resolved.version, dependency.version, { includePrerelease: true })) {
        throw new Error(`Bundled Package ${name} requires ${dependency.name}@${dependency.version}, but resolves ${resolved.version}`);
      }
      visit(dependency.name);
    }
    visiting.pop();
    visited.add(name);
  }
  for (const root of environment.spec.roots) {
    const locked = lock.packages[root.name];
    if (!locked) throw new Error(`Bundled root ${root.name} is missing from the lock`);
    if (locked.source !== root.source) {
      throw new Error(`Bundled root ${root.name} source ${root.source} does not match lock source ${locked.source}`);
    }
    visit(root.name);
  }
  const unreachable = Object.keys(lock.packages).filter((name) => !visited.has(name));
  if (unreachable.length > 0) throw new Error(`Environment bundle contains unreachable Packages: ${unreachable.join(", ")}`);
  for (const [name, manifest] of manifests) {
    const unsupported = environment.spec.targets.filter((target) => !manifest.spec.platforms.includes(target));
    if (unsupported.length > 0) throw new Error(`Bundled Package ${name} does not support Environment target ${unsupported.join(", ")}`);
  }
}

export async function importEnvironmentBundle(
  projectRoot: string,
  bundlePath: string,
  requestedName?: string,
): Promise<EnvironmentBundleImportResult> {
  const source = path.resolve(bundlePath);
  const inputInfo = await stat(source);
  if (!inputInfo.isFile()) throw new Error(`Environment bundle is not a file: ${source}`);
  if (inputInfo.size > MAX_COMPRESSED_BYTES) throw new Error(`Environment bundle exceeds ${MAX_COMPRESSED_BYTES} compressed bytes`);
  const bundle = parseBundle(await readFile(source), source);
  const normalized = normalizeLegacyEnvironmentSnapshot(bundle.environment, bundle.lock);
  const environment = normalized.environment;
  const lock = normalized.lock;
  const packages = bundle.packages.filter((pkg) => lock.packages[pkg.name] !== undefined);
  const name = requestedName ?? environment.metadata.name;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-environment-import-"));
  try {
    const roots = new Map<string, string>();
    const manifests = new Map<string, HarnessManifest>();
    for (const pkg of packages) {
      const packageRoot = path.join(temporary, "packages", pkg.name);
      await materializeBundledPackage(packageRoot, pkg);
      manifests.set(pkg.name, await validateLockedPackageDirectory(lock.packages[pkg.name]!, packageRoot));
      roots.set(pkg.name, packageRoot);
    }
    validateBundleClosure(environment, lock, manifests);
    for (const pkg of packages) {
      await importLockedPackage(lock.packages[pkg.name]!, roots.get(pkg.name)!);
    }
    const snapshot = await importEnvironmentSnapshot(projectRoot, environment, lock, name);
    return { snapshot, path: source, packages: packages.length, bytes: inputInfo.size };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
