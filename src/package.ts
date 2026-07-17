import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { satisfies } from "semver";
import { assertInside, harnessHome, hashDirectory, pathExists } from "./fs.js";
import { loadManifest } from "./schema.js";
import type { HarnessManifest, InstalledPackage, LockedPackage, PackageDependency } from "./types.js";

interface MaterializedSource {
  root: string;
  source: string;
  resolved: string;
  cleanup?: () => Promise<void>;
}

export interface PackageInstallPlan {
  root: InstalledPackage;
  packages: InstalledPackage[];
}

const builtinNames = new Set([
  "reproducibility-core",
  "performance-engineering",
  "paper-search",
  "idea-gen",
  "exp-design",
  "auto-research",
  "meta-skill-builder",
]);

function builtinPath(name: string): string {
  if (!builtinNames.has(name)) throw new Error(`Unknown built-in Harness: ${name}`);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(packageRoot, "examples", name);
}

function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args[0] ?? ""} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function splitRef(source: string): { locator: string; ref?: string } {
  const index = source.lastIndexOf("#");
  if (index <= source.indexOf(":")) return { locator: source };
  const locator = source.slice(0, index);
  const ref = source.slice(index + 1);
  return ref ? { locator, ref } : { locator };
}

function normalizeGitSource(source: string): { url: string; canonical: string; ref?: string } | undefined {
  const { locator, ref } = splitRef(source);
  const shorthand = /^(?:gh|github):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(locator);
  if (shorthand?.[1]) {
    const repo = shorthand[1].replace(/\.git$/, "");
    return {
      url: `https://github.com/${repo}.git`,
      canonical: `gh:${repo}${ref ? `#${ref}` : ""}`,
      ...(ref ? { ref } : {}),
    };
  }
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/.test(locator) || locator.endsWith(".git")) {
    return {
      url: locator,
      canonical: `${locator}${ref ? `#${ref}` : ""}`,
      ...(ref ? { ref } : {}),
    };
  }
  return undefined;
}

async function materializeSource(source: string, cwd: string): Promise<MaterializedSource> {
  if (source.startsWith("builtin:")) {
    const name = source.slice("builtin:".length);
    const root = builtinPath(name);
    if (!(await pathExists(root))) throw new Error(`Built-in Harness is missing from this installation: ${name}`);
    return { root, source: `builtin:${name}`, resolved: "builtin" };
  }
  const git = normalizeGitSource(source);
  if (!git) {
    const root = path.resolve(cwd, source.replace(/^file:/, ""));
    if (!(await pathExists(root))) throw new Error(`Local source does not exist: ${root}`);
    return { root, source: `file:${root}`, resolved: "local" };
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-conda-"));
  try {
    if (git.ref) {
      await run("git", ["clone", "--filter=blob:none", "--no-checkout", git.url, temp]);
      await run("git", ["fetch", "--depth", "1", "origin", git.ref], temp);
      await run("git", ["checkout", "--detach", "FETCH_HEAD"], temp);
    } else {
      await rm(temp, { recursive: true, force: true });
      await run("git", ["clone", "--depth", "1", git.url, temp]);
    }
    const resolved = await run("git", ["rev-parse", "HEAD"], temp);
    return {
      root: temp,
      source: git.canonical,
      resolved,
      cleanup: () => rm(temp, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

function selectedPlatforms(manifest: HarnessManifest, itemPlatforms?: ("codex" | "claude")[]): Set<string> {
  return new Set(itemPlatforms ?? manifest.spec.platforms);
}

export async function validatePackage(root: string, manifest: HarnessManifest): Promise<void> {
  const realRoot = await realpath(root);
  const names = new Set<string>();
  for (const skill of manifest.spec.skills) {
    if (names.has(`skill:${skill.name}`)) throw new Error(`Duplicate skill name: ${skill.name}`);
    names.add(`skill:${skill.name}`);
    const skillRoot = path.resolve(root, skill.path);
    assertInside(root, skillRoot, `Skill ${skill.name}`);
    const rootInfo = await lstat(skillRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`Skill ${skill.name} does not exist at ${skill.path}`);
      throw error;
    });
    if (rootInfo.isSymbolicLink()) throw new Error(`Skill ${skill.name} root is an unsupported symlink: ${skill.path}`);
    if (!rootInfo.isDirectory()) throw new Error(`Skill ${skill.name} root is not a directory: ${skill.path}`);
    assertInside(realRoot, await realpath(skillRoot), `Skill ${skill.name}`);
    if (!(await pathExists(path.join(skillRoot, "SKILL.md")))) {
      throw new Error(`Skill ${skill.name} has no SKILL.md at ${skill.path}`);
    }
    const pending = [skillRoot];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of await readdir(current)) {
        const candidate = path.join(current, entry);
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) throw new Error(`Skill ${skill.name} contains unsupported symlink: ${path.relative(root, candidate)}`);
        if (info.isDirectory()) pending.push(candidate);
      }
    }
  }

  const dependencyNames = new Set<string>();
  for (const dependency of manifest.spec.dependencies) {
    if (dependencyNames.has(dependency.name)) throw new Error(`Duplicate package dependency: ${dependency.name}`);
    dependencyNames.add(dependency.name);
  }

  const skillNames = new Set(manifest.spec.skills.map((skill) => skill.name));
  const entrypointNames = new Set<string>();
  for (const entrypoint of manifest.spec.entrypoints) {
    if (entrypointNames.has(entrypoint.name)) throw new Error(`Duplicate entrypoint name: ${entrypoint.name}`);
    entrypointNames.add(entrypoint.name);
    if (!skillNames.has(entrypoint.skill)) {
      throw new Error(`Entrypoint ${entrypoint.name} references unknown skill ${entrypoint.skill}`);
    }
  }

  const declaredEnv = new Set(manifest.spec.requirements.env.map((item) => item.name));
  for (const server of manifest.spec.mcpServers) {
    if (names.has(`mcp:${server.name}`)) throw new Error(`Duplicate MCP server name: ${server.name}`);
    names.add(`mcp:${server.name}`);
    const usedEnv = server.transport === "stdio" ? server.env : Object.values(server.headers);
    for (const variable of usedEnv) {
      if (!declaredEnv.has(variable)) {
        throw new Error(`MCP server ${server.name} uses undeclared environment variable ${variable}`);
      }
    }
    if ((server.transport === "sse" || server.transport === "ws") && selectedPlatforms(manifest, server.platforms).has("codex")) {
      throw new Error(`MCP transport ${server.transport} for ${server.name} is Claude-only; set platforms: [claude]`);
    }
  }

  for (const hook of manifest.spec.hooks) {
    for (const platform of hook.platforms ?? manifest.spec.platforms) {
      if (!manifest.spec.platforms.includes(platform)) {
        throw new Error(`Hook ${hook.event} targets ${platform}, which is not listed in spec.platforms`);
      }
    }
  }
}

function cacheKey(source: string, resolved: string, integrity: string): string {
  return createHash("sha256").update(`${source}\0${resolved}\0${integrity}`).digest("hex").slice(0, 20);
}

function copyFilter(source: string): boolean {
  const name = path.basename(source);
  return ![".git", ".harness", "node_modules", ".DS_Store"].includes(name);
}

async function verifyCache(root: string, manifest: HarnessManifest, integrity: string): Promise<void> {
  const cachedIntegrity = await hashDirectory(root);
  if (cachedIntegrity !== integrity) {
    throw new Error(`Cached package is corrupt at ${root}: expected ${integrity}, got ${cachedIntegrity}`);
  }
  const cachedManifest = await loadManifest(root);
  await validatePackage(root, cachedManifest);
  if (
    cachedManifest.metadata.name !== manifest.metadata.name ||
    cachedManifest.metadata.version !== manifest.metadata.version
  ) {
    throw new Error(
      `Cached package identity mismatch: expected ${manifest.metadata.name}@${manifest.metadata.version}, got ${cachedManifest.metadata.name}@${cachedManifest.metadata.version}`,
    );
  }
}

async function populateCache(sourceRoot: string, cacheRoot: string): Promise<void> {
  await mkdir(path.dirname(cacheRoot), { recursive: true });
  const temporary = path.join(path.dirname(cacheRoot), `.${path.basename(cacheRoot)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await cp(sourceRoot, temporary, { recursive: true, errorOnExist: true, filter: copyFilter });
    await rename(temporary, cacheRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === "EEXIST" || code === "ENOTEMPTY") && (await pathExists(cacheRoot))) return;
    throw error;
  }
}

async function cacheMaterializedPackage(materialized: MaterializedSource): Promise<InstalledPackage> {
  const manifest = await loadManifest(materialized.root);
  await validatePackage(materialized.root, manifest);
  const integrity = await hashDirectory(materialized.root);
  const resolved = materialized.resolved === "local" || materialized.resolved === "builtin" ? integrity : materialized.resolved;
  const key = cacheKey(materialized.source, resolved, integrity);
  const cacheRoot = path.join(harnessHome(), "packages", manifest.metadata.name, key);
  if (!(await pathExists(cacheRoot))) await populateCache(materialized.root, cacheRoot);
  await verifyCache(cacheRoot, manifest, integrity);
  const lock: LockedPackage = {
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    source: materialized.source,
    resolved,
    integrity,
    cacheKey: key,
    dependencies: manifest.spec.dependencies.map((dependency) => dependency.name),
    installedAt: new Date().toISOString(),
  };
  return { manifest, root: cacheRoot, lock };
}

export async function installPackageSource(source: string, cwd = process.cwd()): Promise<InstalledPackage> {
  const materialized = await materializeSource(source, cwd);
  try {
    return await cacheMaterializedPackage(materialized);
  } finally {
    await materialized.cleanup?.();
  }
}

function assertDependency(dependency: PackageDependency, pkg: InstalledPackage): void {
  if (pkg.manifest.metadata.name !== dependency.name) {
    throw new Error(
      `Dependency ${dependency.name} resolved to package ${pkg.manifest.metadata.name} from ${dependency.source}`,
    );
  }
  if (!satisfies(pkg.manifest.metadata.version, dependency.version, { includePrerelease: true })) {
    throw new Error(
      `Dependency ${dependency.name} requires ${dependency.version}, but ${dependency.source} resolved to ${pkg.manifest.metadata.version}`,
    );
  }
}

export async function installPackageTree(source: string, cwd = process.cwd()): Promise<PackageInstallPlan> {
  const resolved = new Map<string, InstalledPackage>();
  const visiting: string[] = [];
  const ordered: InstalledPackage[] = [];

  async function visit(candidateSource: string, candidateCwd: string, dependency?: PackageDependency): Promise<InstalledPackage> {
    const materialized = await materializeSource(candidateSource, candidateCwd);
    try {
      const pkg = await cacheMaterializedPackage(materialized);
      if (dependency) assertDependency(dependency, pkg);

      const name = pkg.manifest.metadata.name;
      const cycleAt = visiting.indexOf(name);
      if (cycleAt !== -1) {
        throw new Error(`Package dependency cycle: ${[...visiting.slice(cycleAt), name].join(" -> ")}`);
      }

      const existing = resolved.get(name);
      if (existing) {
        const sameResolution =
          existing.lock.version === pkg.lock.version &&
          existing.lock.source === pkg.lock.source &&
          existing.lock.resolved === pkg.lock.resolved &&
          existing.lock.integrity === pkg.lock.integrity;
        if (!sameResolution) {
          throw new Error(
            `Conflicting resolutions for ${name}: ${existing.lock.source}@${existing.lock.version} and ${pkg.lock.source}@${pkg.lock.version}`,
          );
        }
        return existing;
      }

      visiting.push(name);
      try {
        for (const child of pkg.manifest.spec.dependencies) {
          const childIsPortable = child.source.startsWith("builtin:") || normalizeGitSource(child.source) !== undefined;
          if (!materialized.source.startsWith("file:") && !childIsPortable) {
            throw new Error(
              `Package ${name} from ${materialized.source} cannot use local dependency source ${child.source}; use a Git or built-in source`,
            );
          }
          await visit(child.source, materialized.root, child);
        }
      } finally {
        visiting.pop();
      }
      resolved.set(name, pkg);
      ordered.push(pkg);
      return pkg;
    } finally {
      await materialized.cleanup?.();
    }
  }

  const root = await visit(source, cwd);
  return { root, packages: ordered };
}

export async function loadCachedPackage(lock: LockedPackage): Promise<InstalledPackage> {
  const root = path.join(harnessHome(), "packages", lock.name, lock.cacheKey);
  if (!(await pathExists(root))) {
    throw new Error(`Package ${lock.name}@${lock.version} is not cached; run harness install ${lock.source}`);
  }
  const integrity = await hashDirectory(root);
  if (integrity !== lock.integrity) {
    throw new Error(`Integrity mismatch for ${lock.name}: expected ${lock.integrity}, got ${integrity}`);
  }
  const manifest = await loadManifest(root);
  await validatePackage(root, manifest);
  if (manifest.metadata.name !== lock.name || manifest.metadata.version !== lock.version) {
    throw new Error(
      `Locked identity mismatch: expected ${lock.name}@${lock.version}, got ${manifest.metadata.name}@${manifest.metadata.version}`,
    );
  }
  return { manifest, root, lock };
}

function sourceAtRevision(source: string, resolved: string): string {
  if (source.startsWith("file:") || source.startsWith("builtin:")) return source;
  const { locator } = splitRef(source);
  return `${locator}#${resolved}`;
}

export async function syncLockedPackage(lock: LockedPackage): Promise<InstalledPackage> {
  const expectedRoot = path.join(harnessHome(), "packages", lock.name, lock.cacheKey);
  if (await pathExists(expectedRoot)) {
    try {
      return await loadCachedPackage(lock);
    } catch {
      await rm(expectedRoot, { recursive: true, force: true });
    }
  }

  const materialized = await materializeSource(sourceAtRevision(lock.source, lock.resolved), process.cwd());
  try {
    const manifest = await loadManifest(materialized.root);
    await validatePackage(materialized.root, manifest);
    const integrity = await hashDirectory(materialized.root);
    if (manifest.metadata.name !== lock.name || manifest.metadata.version !== lock.version) {
      throw new Error(
        `Locked identity mismatch: expected ${lock.name}@${lock.version}, got ${manifest.metadata.name}@${manifest.metadata.version}`,
      );
    }
    if (integrity !== lock.integrity) {
      throw new Error(`Locked integrity mismatch for ${lock.name}: expected ${lock.integrity}, got ${integrity}`);
    }
    if (!lock.source.startsWith("file:") && !lock.source.startsWith("builtin:") && materialized.resolved !== lock.resolved) {
      throw new Error(`Locked revision mismatch for ${lock.name}: expected ${lock.resolved}, got ${materialized.resolved}`);
    }
    await populateCache(materialized.root, expectedRoot);
    await verifyCache(expectedRoot, manifest, integrity);
    return { manifest, root: expectedRoot, lock };
  } catch (error) {
    await rm(expectedRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await materialized.cleanup?.();
  }
}
