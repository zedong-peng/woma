import { access, cp, lstat, mkdir, mkdtemp, readlink, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { satisfies } from "semver";
import { z } from "zod";
import { activatePackage, deactivatePackage } from "./activation.js";
import { assertInside, harnessHome, hashDirectory, pathExists, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { installPackageTree, loadCachedPackage, syncLockedPackage } from "./package.js";
import {
  initializeProjectMemory,
  localMemoryPath,
  packageMemoryPath,
  PROJECT_MEMORY_PACKAGE,
  projectMemoryPath,
} from "./memory.js";
import { prepareMemoryBootstrapTransition } from "./memory-bootstrap.js";
import { deleteActiveEnvironment, deleteActiveProfile, putActiveEnvironment, readLock, readState, statePath } from "./store.js";
import type { Action, HarnessEnvironment, InstalledPackage, LockFile, LockedPackage, Platform, StateFile } from "./types.js";

const environmentName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");
const platform = z.enum(["codex", "claude"]);

export const DEFAULT_ENVIRONMENT = "base";
export const FOUNDATIONAL_PACKAGES = ["harness-project-memory", "meta-skill-builder"] as const;
const baseInitializations = new Map<string, Promise<HarnessEnvironment>>();

const lockedPackageSchema = z
  .object({
    name: environmentName,
    version: z.string().min(1),
    source: z.string().min(1),
    resolved: z.string().min(1),
    integrity: z.string().min(1),
    cacheKey: z.string().min(1),
    dependencies: z.array(environmentName),
    installedAt: z.string().min(1),
  })
  .strict();

const lockSchema = z
  .object({
    lockfileVersion: z.literal(1),
    packages: z.record(environmentName, lockedPackageSchema),
  })
  .strict();

const environmentSchema = z
  .object({
    apiVersion: z.literal("harness.conda/environment-v1"),
    kind: z.literal("HarnessEnvironment"),
    metadata: z.object({ name: environmentName }).strict(),
    spec: z
      .object({
        targets: z.array(platform).min(1),
        roots: z
          .array(z.object({ name: environmentName, source: z.string().min(1) }).strict())
          .default([]),
      })
      .strict(),
  })
  .strict();

export interface EnvironmentActivationResult {
  name?: string;
  packages: string[];
  targets: Platform[];
  actions: Action[];
}

export interface EnvironmentCheck {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

export interface CurrentEnvironmentContext {
  projectRoot: string;
  environment: { name: string; targets: Platform[] } | null;
  memory: { project: string; local: string };
  packages: {
    name: string;
    version: string;
    source: string;
    memory: string;
    skills: string[];
    entrypoints: { name: string; skill: string; description: string }[];
  }[];
}

interface LoadedEnvironment {
  environment: HarnessEnvironment;
  lock: LockFile;
  names: string[];
  packages: Map<string, InstalledPackage>;
}

interface EnvironmentInstallHooks {
  onResourcesApplied?: () => Promise<void> | void;
}

export function environmentsRoot(_projectRoot?: string): string {
  return path.join(harnessHome(), "environments");
}

export function environmentPath(_projectRoot: string, name: string): string {
  environmentName.parse(name);
  return path.join(environmentsRoot(), name, "environment.yaml");
}

export function environmentLockPath(_projectRoot: string, name: string): string {
  environmentName.parse(name);
  return path.join(environmentsRoot(), name, "lock.json");
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`).join("\n");
}

export function parseEnvironment(input: string, source = "environment.yaml"): HarnessEnvironment {
  let document: unknown;
  try {
    document = parseYaml(input);
  } catch (error) {
    throw new Error(`${source}: invalid YAML: ${(error as Error).message}`);
  }
  const parsed = environmentSchema.safeParse(document);
  if (!parsed.success) throw new Error(`${source}: invalid environment\n${formatIssues(parsed.error)}`);
  const roots = new Set<string>();
  for (const root of parsed.data.spec.roots) {
    if (roots.has(root.name)) throw new Error(`${source}: duplicate root package ${root.name}`);
    roots.add(root.name);
  }
  return parsed.data;
}

export async function readEnvironment(projectRoot: string, name: string): Promise<HarnessEnvironment> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  const filePath = environmentPath(projectRoot, name);
  const input = await readFile(filePath, "utf8").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      const legacyPath = path.join(projectRoot, ".harness", "environments", `${name}.yaml`);
      if (await pathExists(legacyPath)) {
        throw new Error(
          `Project-local environment detected at ${legacyPath}; recreate ${name} as a global Environment. The legacy files were not modified`,
        );
      }
      throw new Error(`Unknown environment: ${name}; run harness env create ${name}`);
    }
    throw error;
  });
  const environment = parseEnvironment(input, filePath);
  if (environment.metadata.name !== name) {
    throw new Error(`${filePath}: metadata.name must match filename ${name}`);
  }
  for (const foundational of FOUNDATIONAL_PACKAGES) {
    if (!environment.spec.roots.some((root) => root.name === foundational)) {
      throw new Error(`${filePath}: missing foundational root package ${foundational}`);
    }
  }
  return environment;
}

async function writeEnvironment(projectRoot: string, environment: HarnessEnvironment): Promise<void> {
  const validated = environmentSchema.parse(environment);
  await writeTextAtomic(environmentPath(projectRoot, validated.metadata.name), stringifyYaml(validated, { lineWidth: 120 }));
}

async function ensureLocalGitExcludes(projectRoot: string): Promise<void> {
  const filePath = path.join(projectRoot, ".gitignore");
  const existing = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = existing.split(/\r?\n/).filter(Boolean);
  let changed = false;
  for (const required of ["/.harness/state.json", "/.harness/local/"]) {
    if (!lines.includes(required)) {
      lines.push(required);
      changed = true;
    }
  }
  if (changed) await writeTextAtomic(filePath, `${lines.join("\n")}\n`);
}

function emptyLock(): LockFile {
  return { lockfileVersion: 1, packages: {} };
}

export async function readEnvironmentLock(projectRoot: string, name: string): Promise<LockFile> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  const filePath = environmentLockPath(projectRoot, name);
  if (!(await pathExists(filePath))) return emptyLock();
  let document: unknown;
  try {
    document = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
  const parsed = lockSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`${filePath}: invalid environment lock\n${formatIssues(parsed.error)}`);
  }
  for (const [packageName, locked] of Object.entries(parsed.data.packages)) {
    if (packageName !== locked.name) {
      throw new Error(`${filePath}: lock key ${packageName} does not match package identity ${locked.name}`);
    }
  }
  return parsed.data;
}

async function initializeEnvironment(projectRoot: string, name: string, targets: Platform[]): Promise<HarnessEnvironment> {
  environmentName.parse(name);
  if (await pathExists(environmentPath(projectRoot, name))) throw new Error(`Environment already exists: ${name}`);
  const installations = [];
  for (const packageName of FOUNDATIONAL_PACKAGES) {
    installations.push(await installPackageTree(`builtin:${packageName}`));
  }
  const roots = installations.map((installation) => ({
    name: installation.root.lock.name,
    source: installation.root.lock.source,
  }));
  const packages = Object.fromEntries(
    installations.flatMap((installation) => installation.packages).map((pkg) => [pkg.lock.name, pkg.lock]),
  );
  const environment: HarnessEnvironment = {
    apiVersion: "harness.conda/environment-v1",
    kind: "HarnessEnvironment",
    metadata: { name },
    spec: { targets: [...new Set(targets)], roots },
  };
  environmentSchema.parse(environment);
  try {
    await writeJsonAtomic(environmentLockPath(projectRoot, name), { lockfileVersion: 1, packages });
    await writeEnvironment(projectRoot, environment);
  } catch (error) {
    await rm(path.dirname(environmentPath(projectRoot, name)), { recursive: true, force: true });
    throw error;
  }
  return environment;
}

export function ensureBaseEnvironment(projectRoot = process.cwd()): Promise<HarnessEnvironment> {
  const filePath = environmentPath(projectRoot, DEFAULT_ENVIRONMENT);
  const existing = baseInitializations.get(filePath);
  if (existing) return existing;
  const initialization = (async () => {
    if (await pathExists(filePath)) {
      const input = await readFile(filePath, "utf8");
      return parseEnvironment(input, filePath);
    }
    return initializeEnvironment(projectRoot, DEFAULT_ENVIRONMENT, ["codex", "claude"]);
  })();
  baseInitializations.set(filePath, initialization);
  void initialization.finally(() => {
    if (baseInitializations.get(filePath) === initialization) baseInitializations.delete(filePath);
  }).catch(() => undefined);
  return initialization;
}

export async function createEnvironment(projectRoot: string, name: string, targets: Platform[]): Promise<HarnessEnvironment> {
  if (name === DEFAULT_ENVIRONMENT) {
    await ensureBaseEnvironment(projectRoot);
    throw new Error("The base environment exists implicitly and cannot be created");
  }
  return initializeEnvironment(projectRoot, name, targets);
}

export async function listEnvironments(projectRoot: string): Promise<string[]> {
  await ensureBaseEnvironment(projectRoot);
  return (await readdir(environmentsRoot(projectRoot), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function removeEnvironment(projectRoot: string, name: string): Promise<void> {
  if (name === DEFAULT_ENVIRONMENT) throw new Error("The base environment cannot be removed");
  const state = await readState(projectRoot);
  if (state.activeEnvironment?.name === name) throw new Error(`Environment ${name} is active; run harness deactivate first`);
  await readEnvironment(projectRoot, name);
  await rm(path.dirname(environmentPath(projectRoot, name)), { recursive: true, force: true });
}

async function validateLock(lock: LockFile): Promise<void> {
  for (const [packageName, locked] of Object.entries(lock.packages)) {
    if (packageName !== locked.name) throw new Error(`Lock key ${packageName} does not match package identity ${locked.name}`);
    const pkg = await loadCachedPackage(locked);
    const declared = pkg.manifest.spec.dependencies.map((dependency) => dependency.name);
    if (JSON.stringify(locked.dependencies ?? []) !== JSON.stringify(declared)) {
      throw new Error(`Lock dependency edges for ${locked.name} do not match its manifest`);
    }
    for (const dependency of pkg.manifest.spec.dependencies) {
      const resolved = lock.packages[dependency.name];
      if (!resolved) throw new Error(`Package ${locked.name} requires ${dependency.name}, which is missing from the lock`);
      if (!satisfies(resolved.version, dependency.version, { includePrerelease: true })) {
        throw new Error(`Package ${locked.name} requires ${dependency.name}@${dependency.version}, but the lock resolves ${resolved.version}`);
      }
    }
  }
}

function validateEnvironmentLockGraph(environment: HarnessEnvironment, lock: LockFile): string[] {
  const rootNames = environment.spec.roots.map((root) => root.name);
  const names = dependencyOrder(lock, rootNames);
  for (const root of environment.spec.roots) {
    const locked = lock.packages[root.name];
    if (!locked) throw new Error(`Root ${root.name} is missing from the environment lock`);
    if (locked.source !== root.source) {
      throw new Error(`Root ${root.name} source ${root.source} does not match lock source ${locked.source}`);
    }
  }
  const reachable = new Set(names);
  const unreachable = Object.keys(lock.packages).filter((name) => !reachable.has(name));
  if (unreachable.length > 0) throw new Error(`Environment lock contains packages unreachable from its roots: ${unreachable.join(", ")}`);
  return names;
}

async function validateEnvironmentLock(environment: HarnessEnvironment, lock: LockFile): Promise<string[]> {
  const names = validateEnvironmentLockGraph(environment, lock);
  await validateLock(lock);
  return names;
}

export function dependencyOrder(lock: LockFile, roots: string[]): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting: string[] = [];
  function visit(name: string): void {
    if (visited.has(name)) return;
    const cycleAt = visiting.indexOf(name);
    if (cycleAt !== -1) throw new Error(`Locked dependency cycle: ${[...visiting.slice(cycleAt), name].join(" -> ")}`);
    const pkg = lock.packages[name];
    if (!pkg) throw new Error(`Root or dependency ${name} is missing from the environment lock`);
    visiting.push(name);
    for (const dependency of pkg.dependencies ?? []) visit(dependency);
    visiting.pop();
    visited.add(name);
    ordered.push(name);
  }
  for (const root of roots) visit(root);
  return ordered;
}

function reachableLock(lock: LockFile, roots: string[]): LockFile {
  const names = dependencyOrder(lock, roots);
  return { lockfileVersion: 1, packages: Object.fromEntries(names.map((name) => [name, lock.packages[name]!])) };
}

type PathBackup =
  | { target: string; kind: "missing" }
  | { target: string; kind: "file" | "directory"; backup: string }
  | { target: string; kind: "symlink"; link: string };

function transitionPaths(projectRoot: string, environmentNameValue: string, state: StateFile, desired: LoadedEnvironment): string[] {
  const project = path.resolve(projectRoot);
  const paths = new Set<string>([
    environmentPath(project, environmentNameValue),
    environmentLockPath(project, environmentNameValue),
    statePath(project),
    path.join(project, ".codex", "config.toml"),
    path.join(project, ".codex", "hooks.json"),
    path.join(project, ".mcp.json"),
    path.join(project, ".claude", "settings.json"),
    path.join(project, "AGENTS.md"),
    path.join(project, "CLAUDE.md"),
  ]);
  for (const activation of Object.values(state.activations)) {
    for (const artifact of activation.artifacts) {
      const absolute = path.resolve(project, artifact.path);
      assertInside(project, absolute, `Managed artifact ${artifact.path}`);
      paths.add(absolute);
    }
  }
  for (const pkg of desired.packages.values()) {
    for (const target of desired.environment.spec.targets) {
      const skillBase = path.join(project, target === "codex" ? ".agents/skills" : ".claude/skills");
      for (const skill of pkg.manifest.spec.skills) paths.add(path.join(skillBase, skill.name));
    }
  }
  return [...paths];
}

async function withPathSnapshot<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-environment-transition-"));
  const backups: PathBackup[] = [];
  try {
    for (const [index, target] of paths.entries()) {
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) {
        backups.push({ target, kind: "missing" });
        continue;
      }
      if (info.isSymbolicLink()) {
        backups.push({ target, kind: "symlink", link: await readlink(target) });
        continue;
      }
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Cannot snapshot unsupported path type: ${target}`);
      const backup = path.join(temporary, String(index));
      await cp(target, backup, { recursive: info.isDirectory(), preserveTimestamps: true });
      backups.push({ target, kind: info.isDirectory() ? "directory" : "file", backup });
    }
    return await operation();
  } catch (error) {
    try {
      for (const backup of backups) {
        await rm(backup.target, { recursive: true, force: true });
        if (backup.kind === "missing") continue;
        await mkdir(path.dirname(backup.target), { recursive: true });
        if (backup.kind === "symlink") {
          await symlink(backup.link, backup.target);
        } else {
          await cp(backup.backup, backup.target, { recursive: backup.kind === "directory", preserveTimestamps: true });
        }
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Environment transition failed and rollback could not restore the project`);
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeEnvironmentInstall(
  projectRoot: string,
  environmentNameValue: string,
  environment: HarnessEnvironment,
  lock: LockFile,
  previousLock: LockFile,
): Promise<void> {
  await writeJsonAtomic(environmentLockPath(projectRoot, environmentNameValue), lock);
  try {
    await writeEnvironment(projectRoot, environment);
  } catch (error) {
    await writeJsonAtomic(environmentLockPath(projectRoot, environmentNameValue), previousLock);
    throw error;
  }
}

export async function installIntoEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  source: string,
  cwd = process.cwd(),
  hooks: EnvironmentInstallHooks = {},
): Promise<{ environment: HarnessEnvironment; root: InstalledPackage; packages: InstalledPackage[] }> {
  const [environment, currentLock, state] = await Promise.all([
    readEnvironment(projectRoot, environmentNameValue),
    readEnvironmentLock(projectRoot, environmentNameValue),
    readState(projectRoot),
  ]);
  validateEnvironmentLockGraph(environment, currentLock);
  const installation = await installPackageTree(source, cwd);
  const next: LockFile = { lockfileVersion: 1, packages: { ...currentLock.packages } };
  for (const pkg of installation.packages) {
    const existing = currentLock.packages[pkg.lock.name];
    const unchanged =
      existing &&
      existing.version === pkg.lock.version &&
      existing.source === pkg.lock.source &&
      existing.resolved === pkg.lock.resolved &&
      existing.integrity === pkg.lock.integrity &&
      existing.cacheKey === pkg.lock.cacheKey;
    next.packages[pkg.lock.name] = unchanged ? existing : pkg.lock;
  }
  const roots = environment.spec.roots.some((root) => root.name === installation.root.lock.name)
    ? environment.spec.roots.map((root) =>
        root.name === installation.root.lock.name ? { name: root.name, source: installation.root.lock.source } : root,
      )
    : [...environment.spec.roots, { name: installation.root.lock.name, source: installation.root.lock.source }];
  const pruned = reachableLock(next, roots.map((root) => root.name));
  const updated: HarnessEnvironment = { ...environment, spec: { ...environment.spec, roots } };
  if (state.activeEnvironment?.name === environmentNameValue) {
    const desired = await loadEnvironmentSnapshot(updated, pruned);
    const previous = await loadEnvironmentSnapshot(environment, currentLock);
    await withPathSnapshot(transitionPaths(projectRoot, environmentNameValue, state, desired), async () => {
      await transitionEnvironment(projectRoot, environmentNameValue, desired, previous);
      await hooks.onResourcesApplied?.();
      await writeEnvironmentInstall(projectRoot, environmentNameValue, updated, pruned, currentLock);
    });
  } else {
    await validateEnvironmentLock(updated, pruned);
    await writeEnvironmentInstall(projectRoot, environmentNameValue, updated, pruned, currentLock);
  }
  return { environment: updated, root: installation.root, packages: installation.packages };
}

async function loadEnvironmentSnapshot(environment: HarnessEnvironment, lock: LockFile): Promise<LoadedEnvironment> {
  const names = await validateEnvironmentLock(environment, lock);
  const packages = new Map<string, InstalledPackage>();
  for (const packageName of names) packages.set(packageName, await loadCachedPackage(lock.packages[packageName]!));
  for (const pkg of packages.values()) {
    for (const target of environment.spec.targets) {
      if (!pkg.manifest.spec.platforms.includes(target)) {
        throw new Error(`${pkg.manifest.metadata.name} does not support environment target ${target}`);
      }
    }
  }
  return { environment, lock, names, packages };
}

async function loadOrderedPackages(projectRoot: string, name: string): Promise<LoadedEnvironment> {
  const [environment, lock] = await Promise.all([readEnvironment(projectRoot, name), readEnvironmentLock(projectRoot, name)]);
  return loadEnvironmentSnapshot(environment, lock);
}

export async function currentEnvironmentContext(projectRoot: string): Promise<CurrentEnvironmentContext> {
  const project = path.resolve(projectRoot);
  const state = await readState(project);
  const memory = { project: projectMemoryPath(project), local: localMemoryPath(project) };
  const selected = process.env.HARNESS_ENV || state.activeEnvironment?.name || DEFAULT_ENVIRONMENT;
  const loaded = await loadOrderedPackages(project, selected);
  return {
    projectRoot: project,
    environment: { name: loaded.environment.metadata.name, targets: loaded.environment.spec.targets },
    memory,
    packages: loaded.names.map((name) => {
      const pkg = loaded.packages.get(name)!;
      return {
        name,
        version: pkg.manifest.metadata.version,
        source: pkg.lock.source,
        memory: packageMemoryPath(project, name),
        skills: pkg.manifest.spec.skills.map((skill) => skill.name),
        entrypoints: pkg.manifest.spec.entrypoints,
      };
    }),
  };
}

function sameIdentity(pkg: InstalledPackage, active: Awaited<ReturnType<typeof readState>>["activations"][string], targets: Platform[]): boolean {
  return (
    active !== undefined &&
    active.packageVersion === pkg.lock.version &&
    active.packageIntegrity === pkg.lock.integrity &&
    active.packageCacheKey === pkg.lock.cacheKey &&
    JSON.stringify(active.targets) === JSON.stringify(targets)
  );
}

async function transitionEnvironment(
  projectRoot: string,
  name: string,
  desired: LoadedEnvironment,
  previousEnvironment?: LoadedEnvironment,
): Promise<EnvironmentActivationResult> {
  const state = await readState(projectRoot);
  if (state.profile) throw new Error("Legacy workflow profile state is active; deactivate it with the previous CLI before using environments");
  const previousNames = state.activeEnvironment?.packages ?? [];
  for (const activeName of Object.keys(state.activations)) {
    if (!previousNames.includes(activeName)) {
      throw new Error(`Package ${activeName} is active outside an environment; deactivate it with the previous CLI first`);
    }
  }

  const retained = new Set(
    desired.names.filter((packageName) => {
      const active = state.activations[packageName];
      return active && sameIdentity(desired.packages.get(packageName)!, active, desired.environment.spec.targets);
    }),
  );
  const removals = [...previousNames].reverse().filter((packageName) => !retained.has(packageName));
  const additions = desired.names.filter((packageName) => !retained.has(packageName));
  const actions: Action[] = [];
  for (const packageName of removals) {
    const plan = await deactivatePackage(packageName, projectRoot, true);
    if (plan.some((action) => action.verb === "keep" && !action.detail.startsWith("still used by "))) {
      throw new Error(`${packageName} has modified or missing managed files; resolve drift before switching environments`);
    }
    actions.push(...plan);
  }
  for (const packageName of additions) {
    if (!state.activations[packageName]) {
      actions.push(...(await activatePackage(desired.packages.get(packageName)!, projectRoot, desired.environment.spec.targets, true)));
    }
  }
  const contextTransition = await prepareMemoryBootstrapTransition(
    projectRoot,
    previousEnvironment
      ? { targets: previousEnvironment.environment.spec.targets, hasMemoryPackage: previousEnvironment.names.includes(PROJECT_MEMORY_PACKAGE) }
      : undefined,
    { targets: desired.environment.spec.targets, hasMemoryPackage: desired.names.includes(PROJECT_MEMORY_PACKAGE) },
    {
      requirePrevious: state.activeEnvironment?.memoryBootstrapVersion === 1,
    },
  );
  actions.push(...contextTransition.actions);

  const removed: { pkg: InstalledPackage; targets: Platform[] }[] = [];
  const added: string[] = [];
  let rollbackContext: (() => Promise<void>) | undefined;
  try {
    for (const packageName of removals) {
      const active = state.activations[packageName]!;
      const pkg = previousEnvironment?.packages.get(packageName);
      if (!pkg) throw new Error(`Cannot load active package ${packageName} for rollback`);
      removed.push({ pkg, targets: active.targets });
      await deactivatePackage(packageName, projectRoot);
    }
    for (const packageName of additions) {
      if (state.activations[packageName]) {
        actions.push(...(await activatePackage(desired.packages.get(packageName)!, projectRoot, desired.environment.spec.targets, true)));
      }
      await activatePackage(desired.packages.get(packageName)!, projectRoot, desired.environment.spec.targets);
      added.push(packageName);
    }
    rollbackContext = await contextTransition.apply();
    await putActiveEnvironment(projectRoot, {
      name,
      packages: desired.names,
      targets: desired.environment.spec.targets,
      activatedAt: new Date().toISOString(),
      memoryBootstrapVersion: desired.names.includes(PROJECT_MEMORY_PACKAGE) ? 1 : undefined,
    });
    return { name, packages: desired.names, targets: desired.environment.spec.targets, actions };
  } catch (error) {
    let contextRollbackError: unknown;
    if (rollbackContext) {
      try {
        await rollbackContext();
      } catch (rollbackError) {
        contextRollbackError = rollbackError;
      }
    }
    for (const packageName of [...added].reverse()) await deactivatePackage(packageName, projectRoot).catch(() => undefined);
    for (const item of [...removed].reverse()) await activatePackage(item.pkg, projectRoot, item.targets).catch(() => undefined);
    if (contextRollbackError) {
      throw new AggregateError([error, contextRollbackError], "Environment transition failed and Agent context rollback could not restore the project");
    }
    throw error;
  }
}

export async function activateEnvironment(projectRoot: string, name: string): Promise<EnvironmentActivationResult> {
  await ensureLocalGitExcludes(projectRoot);
  await initializeProjectMemory(projectRoot);
  const desired = await loadOrderedPackages(projectRoot, name);
  const state = await readState(projectRoot);
  const previous = state.activeEnvironment ? await loadOrderedPackages(projectRoot, state.activeEnvironment.name) : undefined;
  return transitionEnvironment(projectRoot, name, desired, previous);
}

export async function deactivateEnvironment(projectRoot: string): Promise<EnvironmentActivationResult> {
  const state = await readState(projectRoot);
  const active = state.activeEnvironment;
  if (!active && (state.profile || Object.keys(state.activations).length > 0)) {
    const lock = await readLock(projectRoot);
    const names = Object.keys(state.activations).reverse();
    const packages = new Map<string, InstalledPackage>();
    const actions: Action[] = [];
    for (const packageName of names) {
      const locked = lock.packages[packageName];
      if (!locked) throw new Error(`Cannot clean legacy activation ${packageName}: package is missing from .harness/lock.json`);
      packages.set(packageName, await loadCachedPackage(locked));
      const plan = await deactivatePackage(packageName, projectRoot, true);
      if (plan.some((action) => action.verb === "keep" && !action.detail.startsWith("still used by "))) {
        throw new Error(`${packageName} has modified or missing managed files; resolve drift before deactivating`);
      }
      actions.push(...plan);
    }
    const instructions = await Promise.all(
      (state.profile?.instructions ?? []).map(async (instruction) => {
        const absolute = path.join(projectRoot, instruction.path);
        const original = await readFile(absolute, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (original === null || !original.includes(instruction.block)) {
          throw new Error(`${instruction.path} legacy profile block was modified or removed; resolve it before deactivating`);
        }
        let content = original.replace(instruction.block, "").replace(/^\n+|\n+$/g, "");
        if (content) content += "\n";
        actions.push({ verb: "remove", path: instruction.path, detail: "legacy profile routing signal" });
        return { absolute, original, content };
      }),
    );
    const removed: { pkg: InstalledPackage; targets: Platform[] }[] = [];
    const written: typeof instructions = [];
    try {
      for (const packageName of names) {
        removed.push({ pkg: packages.get(packageName)!, targets: state.activations[packageName]!.targets });
        await deactivatePackage(packageName, projectRoot);
      }
      for (const instruction of instructions) {
        if (instruction.content) await writeTextAtomic(instruction.absolute, instruction.content);
        else await rm(instruction.absolute, { force: true });
        written.push(instruction);
      }
      if (state.profile) await deleteActiveProfile(projectRoot);
      return { packages: [], targets: [], actions };
    } catch (error) {
      for (const instruction of [...written].reverse()) await writeTextAtomic(instruction.absolute, instruction.original).catch(() => undefined);
      for (const item of [...removed].reverse()) await activatePackage(item.pkg, projectRoot, item.targets).catch(() => undefined);
      throw error;
    }
  }
  if (!active) throw new Error("No active environment");
  const current = await loadOrderedPackages(projectRoot, active.name);
  const names = [...active.packages].reverse();
  const actions: Action[] = [];
  for (const packageName of names) {
    const plan = await deactivatePackage(packageName, projectRoot, true);
    if (plan.some((action) => action.verb === "keep" && !action.detail.startsWith("still used by "))) {
      throw new Error(`${packageName} has modified or missing managed files; resolve drift before deactivating`);
    }
    actions.push(...plan);
  }
  const contextTransition = await prepareMemoryBootstrapTransition(
    projectRoot,
    { targets: current.environment.spec.targets, hasMemoryPackage: current.names.includes(PROJECT_MEMORY_PACKAGE) },
    undefined,
    { requirePrevious: active.memoryBootstrapVersion === 1 },
  );
  actions.push(...contextTransition.actions);
  const removed: { pkg: InstalledPackage; targets: Platform[] }[] = [];
  let rollbackContext: (() => Promise<void>) | undefined;
  try {
    for (const packageName of names) {
      removed.push({ pkg: current.packages.get(packageName)!, targets: state.activations[packageName]!.targets });
      await deactivatePackage(packageName, projectRoot);
    }
    rollbackContext = await contextTransition.apply();
    await deleteActiveEnvironment(projectRoot);
    return { packages: [], targets: [], actions };
  } catch (error) {
    let contextRollbackError: unknown;
    if (rollbackContext) {
      try {
        await rollbackContext();
      } catch (rollbackError) {
        contextRollbackError = rollbackError;
      }
    }
    for (const item of [...removed].reverse()) await activatePackage(item.pkg, projectRoot, item.targets).catch(() => undefined);
    if (contextRollbackError) {
      throw new AggregateError([error, contextRollbackError], "Environment deactivation failed and Agent context rollback could not restore the project");
    }
    throw error;
  }
}

export async function syncEnvironment(projectRoot: string, name: string): Promise<LockedPackage[]> {
  const environment = await readEnvironment(projectRoot, name);
  const lock = await readEnvironmentLock(projectRoot, name);
  const names = validateEnvironmentLockGraph(environment, lock);
  for (const packageName of names) await syncLockedPackage(lock.packages[packageName]!);
  await validateLock(lock);
  return Object.values(lock.packages);
}

async function findCommand(command: string): Promise<boolean> {
  if (command.includes(path.sep)) {
    return access(command, constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (
      await access(path.join(directory, command), constants.X_OK).then(
        () => true,
        () => false,
      )
    ) return true;
  }
  return false;
}

export async function doctorEnvironment(projectRoot: string, name: string): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];
  const environment = await readEnvironment(projectRoot, name);
  let lock: LockFile;
  let names: string[];
  try {
    lock = await readEnvironmentLock(projectRoot, name);
    names = await validateEnvironmentLock(environment, lock);
    checks.push({ status: "ok", label: "lock", detail: `${Object.keys(lock.packages).length} packages` });
  } catch (error) {
    checks.push({ status: "fail", label: "lock", detail: (error as Error).message });
    return checks;
  }
  const state = await readState(projectRoot);
  checks.push({ status: "ok", label: "roots", detail: environment.spec.roots.map((root) => root.name).join(", ") || "none" });
  for (const packageName of names) {
    const pkg = await loadCachedPackage(lock.packages[packageName]!);
    checks.push({ status: "ok", label: `package:${packageName}`, detail: pkg.lock.version });
    const unsupportedTargets = environment.spec.targets.filter((target) => !pkg.manifest.spec.platforms.includes(target));
    checks.push({
      status: unsupportedTargets.length === 0 ? "ok" : "fail",
      label: `platforms:${packageName}`,
      detail: unsupportedTargets.length === 0
        ? environment.spec.targets.join(", ")
        : `does not support ${unsupportedTargets.join(", ")}`,
    });
    const commands = new Set(pkg.manifest.spec.requirements.commands);
    for (const server of pkg.manifest.spec.mcpServers) {
      const appliesToEnvironment = environment.spec.targets.some(
        (target) => !server.platforms || server.platforms.includes(target),
      );
      if (server.transport === "stdio" && appliesToEnvironment) commands.add(server.command);
    }
    for (const command of commands) {
      const found = await findCommand(command);
      checks.push({ status: found ? "ok" : "fail", label: `command:${command}`, detail: found ? "found" : "not found on PATH" });
    }
    for (const requirement of pkg.manifest.spec.requirements.env) {
      const present = Boolean(process.env[requirement.name]);
      checks.push({
        status: present ? "ok" : requirement.optional ? "warn" : "fail",
        label: `env:${requirement.name}`,
        detail: present ? "set" : requirement.optional ? "optional and not set" : "required and not set",
      });
    }
  }
  const active = state.activeEnvironment?.name === name;
  checks.push({ status: active ? "ok" : "warn", label: "activation", detail: active ? environment.spec.targets.join(", ") : "inactive" });
  if (active) {
    const activeEnvironment = state.activeEnvironment!;
    const closureMatches = JSON.stringify(activeEnvironment.packages) === JSON.stringify(names);
    checks.push({
      status: closureMatches ? "ok" : "fail",
      label: "active-environment",
      detail: closureMatches
        ? `${name}: ${names.join(", ") || "no packages"}`
        : `recorded packages ${activeEnvironment.packages.join(", ") || "none"} do not match lock closure ${names.join(", ") || "none"}`,
    });
    const targetsMatch = JSON.stringify(activeEnvironment.targets) === JSON.stringify(environment.spec.targets);
    checks.push({
      status: targetsMatch ? "ok" : "fail",
      label: "active-targets",
      detail: targetsMatch
        ? environment.spec.targets.join(", ")
        : `recorded targets ${activeEnvironment.targets.join(", ")} do not match recipe ${environment.spec.targets.join(", ")}`,
    });
    try {
      const hasMemoryPackage = names.includes(PROJECT_MEMORY_PACKAGE);
      const contextCheck = await prepareMemoryBootstrapTransition(
        projectRoot,
        { targets: environment.spec.targets, hasMemoryPackage },
        { targets: environment.spec.targets, hasMemoryPackage },
        { requirePrevious: activeEnvironment.memoryBootstrapVersion === 1 },
      );
      checks.push({
        status: contextCheck.actions.length === 0 ? "ok" : "fail",
        label: "memory-bootstrap",
        detail: contextCheck.actions.length === 0
          ? hasMemoryPackage
            ? "Agent discovery pointers match the active Memory package"
            : "Project Memory package is not active"
          : `unexpected changes required: ${contextCheck.actions.map((action) => action.path).join(", ")}`,
      });
    } catch (error) {
      checks.push({ status: "fail", label: "memory-bootstrap", detail: (error as Error).message });
    }
    for (const packageName of names) {
      const activation = state.activations[packageName];
      const locked = lock.packages[packageName]!;
      const identityMatches =
        activation !== undefined &&
        activation.packageVersion === locked.version &&
        activation.packageIntegrity === locked.integrity &&
        activation.packageCacheKey === locked.cacheKey &&
        JSON.stringify(activation.targets) === JSON.stringify(environment.spec.targets);
      checks.push({
        status: identityMatches ? "ok" : "fail",
        label: `active:${packageName}`,
        detail: !activation
          ? "activation record missing"
          : identityMatches
            ? activation.targets.join(", ")
            : `activation ${activation.packageVersion}/${activation.packageCacheKey} [${activation.targets.join(", ")}] does not match lock ${locked.version}/${locked.cacheKey} [${environment.spec.targets.join(", ")}]`,
      });
      for (const artifact of activation?.artifacts ?? []) {
        if (!artifact.managed || artifact.kind !== "directory") continue;
        const absolute = path.join(projectRoot, artifact.path);
        if (!(await pathExists(absolute))) {
          checks.push({ status: "fail", label: artifact.path, detail: "managed Skill is missing" });
        } else if ((await hashDirectory(absolute)) !== artifact.integrity) {
          checks.push({ status: "warn", label: artifact.path, detail: "managed Skill was modified after activation" });
        } else {
          checks.push({ status: "ok", label: artifact.path, detail: "managed Skill matches activation" });
        }
      }
    }
    for (const packageName of Object.keys(state.activations)) {
      if (!names.includes(packageName)) {
        checks.push({ status: "fail", label: `foreign:${packageName}`, detail: "active outside the selected environment" });
      }
    }
  }
  return checks;
}
