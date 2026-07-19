import { access, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { satisfies } from "semver";
import { z } from "zod";
import { harnessHome, pathExists, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { installPackageTree, loadCachedPackage, syncLockedPackage } from "./package.js";
import {
  initializeProjectMemory,
  localMemoryPath,
  packageMemoryPath,
  PROJECT_MEMORY_PACKAGE,
  projectMemoryPath,
} from "./memory.js";
import { prepareMemoryBootstrapTransition } from "./memory-bootstrap.js";
import { environmentViewPath, materializeEnvironmentView, validateEnvironmentView } from "./view.js";
import type { Action, HarnessEnvironment, InstalledPackage, LockFile, LockedPackage, Platform } from "./types.js";

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
  const input = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
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
  for (const required of ["/.harness/local/"]) {
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
  const installed = new Map(
    installations.flatMap((installation) => installation.packages).map((pkg) => [pkg.lock.name, pkg]),
  );
  const packages = Object.fromEntries([...installed].map(([packageName, pkg]) => [packageName, pkg.lock]));
  const environment: HarnessEnvironment = {
    apiVersion: "harness.conda/environment-v1",
    kind: "HarnessEnvironment",
    metadata: { name },
    spec: { targets: [...new Set(targets)], roots },
  };
  environmentSchema.parse(environment);
  try {
    await materializeEnvironmentView(environment, [...installed.values()], {
      afterSwap: async () => {
        await writeJsonAtomic(environmentLockPath(projectRoot, name), { lockfileVersion: 1, packages });
        await writeEnvironment(projectRoot, environment);
      },
    });
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
  if (process.env.HARNESS_ENV === name) throw new Error(`Environment ${name} is active in this shell; run harness deactivate first`);
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
  const [environment, currentLock] = await Promise.all([
    readEnvironment(projectRoot, environmentNameValue),
    readEnvironmentLock(projectRoot, environmentNameValue),
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
  const desired = await loadEnvironmentSnapshot(updated, pruned);
  await materializeEnvironmentView(updated, desired.names.map((name) => desired.packages.get(name)!), {
    afterSwap: async () => {
      await hooks.onResourcesApplied?.();
      await writeEnvironmentInstall(projectRoot, environmentNameValue, updated, pruned, currentLock);
    },
  });
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

export async function environmentInfo(projectRoot: string): Promise<CurrentEnvironmentContext> {
  const project = path.resolve(projectRoot);
  const memory = { project: projectMemoryPath(project), local: localMemoryPath(project) };
  const selected = process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT;
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

async function transitionEnvironment(
  projectRoot: string,
  name: string,
  desired: LoadedEnvironment,
): Promise<EnvironmentActivationResult> {
  const contextTransition = await prepareMemoryBootstrapTransition(
    projectRoot,
    undefined,
    { targets: desired.environment.spec.targets, hasMemoryPackage: desired.names.includes(PROJECT_MEMORY_PACKAGE) },
  );
  let rollbackContext: (() => Promise<void>) | undefined;
  try {
    rollbackContext = await contextTransition.apply();
    return { name, packages: desired.names, targets: desired.environment.spec.targets, actions: contextTransition.actions };
  } catch (error) {
    let contextRollbackError: unknown;
    if (rollbackContext) {
      try {
        await rollbackContext();
      } catch (rollbackError) {
        contextRollbackError = rollbackError;
      }
    }
    if (contextRollbackError) {
      throw new AggregateError([error, contextRollbackError], "Environment transition failed and Agent context rollback could not restore the project");
    }
    throw error;
  }
}

export async function activateEnvironment(projectRoot: string, name: string): Promise<EnvironmentActivationResult> {
  const desired = await loadOrderedPackages(projectRoot, name);
  await validateEnvironmentView(desired.environment, desired.names.map((packageName) => desired.packages.get(packageName)!));
  await ensureLocalGitExcludes(projectRoot);
  await initializeProjectMemory(projectRoot);
  return transitionEnvironment(projectRoot, name, desired);
}

export async function deactivateEnvironment(projectRoot: string): Promise<EnvironmentActivationResult> {
  return activateEnvironment(projectRoot, DEFAULT_ENVIRONMENT);
}

export async function syncEnvironment(projectRoot: string, name: string): Promise<LockedPackage[]> {
  const environment = await readEnvironment(projectRoot, name);
  const lock = await readEnvironmentLock(projectRoot, name);
  const names = validateEnvironmentLockGraph(environment, lock);
  for (const packageName of names) await syncLockedPackage(lock.packages[packageName]!);
  await validateLock(lock);
  const loaded = await loadEnvironmentSnapshot(environment, lock);
  await materializeEnvironmentView(environment, loaded.names.map((packageName) => loaded.packages.get(packageName)!));
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
  const active = (process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT) === name;
  checks.push({ status: active ? "ok" : "warn", label: "activation", detail: active ? environment.spec.targets.join(", ") : "inactive" });
  if (active) {
    try {
      const hasMemoryPackage = names.includes(PROJECT_MEMORY_PACKAGE);
      const contextCheck = await prepareMemoryBootstrapTransition(
        projectRoot,
        { targets: environment.spec.targets, hasMemoryPackage },
        { targets: environment.spec.targets, hasMemoryPackage },
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
  }
  try {
    const loaded = await loadEnvironmentSnapshot(environment, lock);
    await validateEnvironmentView(environment, loaded.names.map((packageName) => loaded.packages.get(packageName)!));
    checks.push({ status: "ok", label: "view", detail: environmentViewPath(name) });
  } catch (error) {
    checks.push({ status: "fail", label: "view", detail: (error as Error).message });
  }
  return checks;
}
