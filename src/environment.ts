import { access, lstat, readlink, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { satisfies } from "semver";
import { z } from "zod";
import { AGENT_SESSION_ENTRIES, AGENT_SKILLS_DIRECTORY } from "./agent-state-paths.js";
import { harnessHome, pathExists, writeJsonAtomic, writeTextAtomic, writeTextPreservingFile } from "./fs.js";
import { withEnvironmentLock, withProjectLock } from "./environment-lock.js";
import { installPackageTree, loadCachedPackage, repairLockedPackage, type PackageInstallPlan, type PackageSourceOptions } from "./package.js";
import {
  prepareProjectMemoryInitialization,
  localMemoryPath,
  packageMemoryPath,
  PROJECT_MEMORY_PACKAGE,
  projectMemoryPath,
} from "./memory.js";
import { prepareMemoryBootstrapTransition } from "./memory-bootstrap.js";
import {
  inspectEnvironmentLocalSkills,
  type EnvironmentLocalSkill,
  type EnvironmentLocalSkillIssue,
} from "./environment-skills.js";
import { environmentViewPath, materializeEnvironmentView, sourceAgentHome, validateEnvironmentView } from "./view.js";
import type { Action, CodexClaudePlatform, HarnessEnvironment, InstalledPackage, LockFile, LockedPackage, Platform } from "./types.js";

const environmentName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");
const platform = z.enum(["codex", "claude", "pi"]);

export const DEFAULT_ENVIRONMENT = "base";
export const FOUNDATIONAL_PACKAGES = ["harness-project-memory", "harness-package-builder"] as const;
const FOUNDATIONAL_SOURCES = new Map(FOUNDATIONAL_PACKAGES.map((name) => [name, `builtin:${name}`]));
const baseInitializations = new Map<string, Promise<HarnessEnvironment>>();

const lockedPackageSchema = z
  .object({
    name: environmentName,
    version: z.string().min(1),
    source: z.string().min(1),
    resolved: z.string().min(1).optional(),
    requestedRef: z.string().min(1).optional(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/, "must be a full lowercase hexadecimal commit SHA").optional(),
    subdirectory: z.string().min(1).optional(),
    integrity: z.string().min(1),
    cacheKey: z.string().regex(/^[a-f0-9]{20}$/, "must be a 20-character lowercase hexadecimal cache key"),
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

export interface BaseEnvironmentInitializationOptions {
  onExistingAgentStateDetected?: () => void;
}

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
  environmentSkills: EnvironmentLocalSkill[];
  environmentSkillIssues: EnvironmentLocalSkillIssue[];
}

export interface EnvironmentSnapshot {
  environment: HarnessEnvironment;
  lock: LockFile;
}

interface LoadedEnvironment {
  environment: HarnessEnvironment;
  lock: LockFile;
  names: string[];
  packages: Map<string, InstalledPackage>;
}

interface EnvironmentMutationHooks {
  onResourcesApplied?: () => Promise<void> | void;
  onViewPrepared?: () => Promise<void> | void;
  onMetadataPrepared?: () => Promise<void> | void;
}

interface EnvironmentInstallHooks extends EnvironmentMutationHooks {
  sourceOptions?: PackageSourceOptions;
}

interface EnvironmentUninstallOptions extends EnvironmentMutationHooks {
  dryRun?: boolean;
}

export interface EnvironmentUninstallResult {
  environment: HarnessEnvironment;
  root: InstalledPackage;
  packages: InstalledPackage[];
  dependencies: InstalledPackage[];
  skills: string[];
  mcpServers: string[];
  hooks: string[];
  dryRun: boolean;
}

interface EnvironmentActivationHooks {
  onProjectApplied?: () => Promise<void> | void;
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

async function readEnvironmentFile(projectRoot: string, name: string): Promise<HarnessEnvironment> {
  const filePath = environmentPath(projectRoot, name);
  const input = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`Unknown environment: ${name}; run harness create --name ${name}`);
    }
    throw error;
  });
  const environment = parseEnvironment(input, filePath);
  if (environment.metadata.name !== name) {
    throw new Error(`${filePath}: metadata.name must match filename ${name}`);
  }
  for (const foundational of FOUNDATIONAL_PACKAGES) {
    const root = environment.spec.roots.find((candidate) => candidate.name === foundational);
    if (!root) {
      throw new Error(`${filePath}: missing foundational root package ${foundational}`);
    }
    if (root.source !== FOUNDATIONAL_SOURCES.get(foundational)) {
      throw new Error(`${filePath}: foundational package ${foundational} must use builtin:${foundational}`);
    }
  }
  return environment;
}

export async function readEnvironment(projectRoot: string, name: string): Promise<HarnessEnvironment> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  return readEnvironmentFile(projectRoot, name);
}

async function writeEnvironment(projectRoot: string, environment: HarnessEnvironment): Promise<void> {
  const validated = environmentSchema.parse(environment);
  await writeTextAtomic(environmentPath(projectRoot, validated.metadata.name), stringifyYaml(validated, { lineWidth: 120 }));
}

interface PreparedProjectFileChange {
  apply: () => Promise<() => Promise<void>>;
}

async function prepareLocalGitExcludes(projectRoot: string): Promise<PreparedProjectFileChange> {
  const filePath = path.join(projectRoot, ".gitignore");
  const original = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const required = "/.harness/local/";
  const lines = (original ?? "").split(/\r?\n/);
  const desired = lines.includes(required)
    ? original
    : `${original ?? ""}${original && !original.endsWith("\n") ? "\n" : ""}${required}\n`;
  return {
    apply: async () => {
      if (desired === original) return async () => undefined;
      const current = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current !== original) throw new Error(".gitignore changed while activation was in progress; retry");
      await writeTextPreservingFile(filePath, desired ?? "");
      return async () => {
        if (original === null) await rm(filePath, { force: true });
        else await writeTextPreservingFile(filePath, original);
      };
    },
  };
}

async function rollbackProjectChanges(rollbacks: (() => Promise<void>)[], cause: unknown): Promise<never> {
  const errors: unknown[] = [];
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError([cause, ...errors], "Activation failed and project rollback was incomplete");
  throw cause;
}

function emptyLock(): LockFile {
  return { lockfileVersion: 1, packages: {} };
}

export function parseEnvironmentLock(input: string, source = "lock.json"): LockFile {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch (error) {
    throw new Error(`Cannot parse ${source}: ${(error as Error).message}`);
  }
  const parsed = lockSchema.safeParse(document);
  if (!parsed.success) throw new Error(`${source}: invalid environment lock\n${formatIssues(parsed.error)}`);
  for (const [packageName, locked] of Object.entries(parsed.data.packages)) {
    if (packageName !== locked.name) {
      throw new Error(`${source}: lock key ${packageName} does not match package identity ${locked.name}`);
    }
  }
  return parsed.data;
}

async function readEnvironmentLockFile(projectRoot: string, name: string): Promise<LockFile> {
  const filePath = environmentLockPath(projectRoot, name);
  if (!(await pathExists(filePath))) return emptyLock();
  return parseEnvironmentLock(await readFile(filePath, "utf8"), filePath);
}

export async function readEnvironmentLock(projectRoot: string, name: string): Promise<LockFile> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  return readEnvironmentLockFile(projectRoot, name);
}

export async function environmentSnapshot(projectRoot: string, name: string): Promise<EnvironmentSnapshot> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  return withEnvironmentLock(name, async () => {
    const [environment, lock] = await Promise.all([
      readEnvironmentFile(projectRoot, name),
      readEnvironmentLockFile(projectRoot, name),
    ]);
    validateEnvironmentLockGraph(environment, lock);
    return { environment, lock };
  });
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
      beforeSwap: async () => {
        await writeJsonAtomic(environmentLockPath(projectRoot, name), { lockfileVersion: 1, packages });
        try {
          await writeEnvironment(projectRoot, environment);
        } catch (error) {
          await rm(environmentLockPath(projectRoot, name), { force: true });
          throw error;
        }
        return async () => {
          await rm(environmentPath(projectRoot, name), { force: true });
          await rm(environmentLockPath(projectRoot, name), { force: true });
        };
      },
    });
  } catch (error) {
    await rm(path.dirname(environmentPath(projectRoot, name)), { recursive: true, force: true });
    throw error;
  }
  return environment;
}

async function existingAgentStateDetected(): Promise<boolean> {
  const platforms: CodexClaudePlatform[] = ["codex", "claude"];
  for (const platform of platforms) {
    const home = sourceAgentHome(platform);
    const skills = await lstat(path.join(home, AGENT_SKILLS_DIRECTORY)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (skills?.isDirectory() && !skills.isSymbolicLink()) return true;
    for (const name of AGENT_SESSION_ENTRIES[platform]) {
      const info = await lstat(path.join(home, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info && !info.isSymbolicLink() && (info.isFile() || info.isDirectory())) return true;
    }
  }
  return false;
}

export function ensureBaseEnvironment(
  projectRoot = process.cwd(),
  options: BaseEnvironmentInitializationOptions = {},
): Promise<HarnessEnvironment> {
  const filePath = environmentPath(projectRoot, DEFAULT_ENVIRONMENT);
  const existing = baseInitializations.get(filePath);
  if (existing) return existing;
  const initialization = withEnvironmentLock(DEFAULT_ENVIRONMENT, async () => {
    if (!(await pathExists(filePath))) {
      const detected = await existingAgentStateDetected();
      const environment = await initializeEnvironment(projectRoot, DEFAULT_ENVIRONMENT, ["codex", "claude"]);
      if (detected) options.onExistingAgentStateDetected?.();
      return environment;
    }
    try {
      const environment = await readEnvironmentFile(projectRoot, DEFAULT_ENVIRONMENT);
      const lock = await readEnvironmentLockFile(projectRoot, DEFAULT_ENVIRONMENT);
      const loaded = await loadEnvironmentSnapshot(environment, lock);
      const packages = loaded.names.map((name) => loaded.packages.get(name)!);
      try {
        await validateEnvironmentView(environment, packages);
      } catch {
        await materializeEnvironmentView(environment, packages, { previousPackages: packages });
        await validateEnvironmentView(environment, packages);
      }
      return environment;
    } catch (error) {
      throw new Error(`The base Environment is incomplete or corrupt: ${(error as Error).message}`);
    }
  });
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
  return withEnvironmentLock(name, () => initializeEnvironment(projectRoot, name, targets));
}

export async function importEnvironmentSnapshot(
  projectRoot: string,
  sourceEnvironment: HarnessEnvironment,
  lock: LockFile,
  requestedName = sourceEnvironment.metadata.name,
): Promise<EnvironmentSnapshot> {
  environmentName.parse(requestedName);
  if (requestedName === DEFAULT_ENVIRONMENT) {
    throw new Error("The base environment exists implicitly and cannot be imported; pass --name <name>");
  }
  const environment: HarnessEnvironment = {
    ...sourceEnvironment,
    metadata: { name: requestedName },
    spec: {
      targets: [...sourceEnvironment.spec.targets],
      roots: sourceEnvironment.spec.roots.map((root) => ({ ...root })),
    },
  };
  environmentSchema.parse(environment);
  return withEnvironmentLock(requestedName, async () => {
    const root = path.dirname(environmentPath(projectRoot, requestedName));
    if (await pathExists(root)) throw new Error(`Environment already exists: ${requestedName}`);
    const loaded = await loadEnvironmentSnapshot(environment, lock);
    try {
      await materializeEnvironmentView(environment, loaded.names.map((name) => loaded.packages.get(name)!), {
        beforeSwap: async () => {
          await writeJsonAtomic(environmentLockPath(projectRoot, requestedName), lock);
          try {
            await writeEnvironment(projectRoot, environment);
          } catch (error) {
            await rm(environmentLockPath(projectRoot, requestedName), { force: true });
            throw error;
          }
          return async () => {
            await rm(environmentPath(projectRoot, requestedName), { force: true });
            await rm(environmentLockPath(projectRoot, requestedName), { force: true });
          };
        },
      });
      return { environment, lock };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function listEnvironments(projectRoot: string): Promise<string[]> {
  if (!(await pathExists(environmentPath(projectRoot, DEFAULT_ENVIRONMENT)))) await ensureBaseEnvironment(projectRoot);
  return (await readdir(environmentsRoot(projectRoot), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function removeEnvironment(projectRoot: string, name: string): Promise<void> {
  if (name === DEFAULT_ENVIRONMENT) throw new Error("The base environment cannot be removed");
  if (process.env.HARNESS_ENV === name) throw new Error(`Environment ${name} is active in this shell; run harness deactivate first`);
  await withEnvironmentLock(name, async () => {
    await readEnvironmentFile(projectRoot, name);
    await rm(path.dirname(environmentPath(projectRoot, name)), { recursive: true, force: true });
  });
}

async function rewriteRenamedEnvironmentLinks(root: string, previousRoot: string, nextRoot: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = await readlink(entryPath);
      if (!path.isAbsolute(target)) continue;
      const relative = path.relative(previousRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const replacement = path.join(nextRoot, relative);
      const temporary = `${entryPath}.rename-${process.pid}-${randomUUID()}`;
      const replacementInfo = await lstat(replacement);
      await symlink(
        replacement,
        temporary,
        process.platform === "win32" ? (replacementInfo.isDirectory() ? "junction" : "file") : undefined,
      );
      try {
        await rename(temporary, entryPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  await visit(root);
}

async function withEnvironmentPairLock<T>(left: string, right: string, operation: () => Promise<T>): Promise<T> {
  const [first, second] = [left, right].sort((a, b) => a.localeCompare(b));
  return withEnvironmentLock(first!, () => withEnvironmentLock(second!, operation));
}

export async function renameEnvironment(projectRoot: string, source: string, destination: string): Promise<HarnessEnvironment> {
  environmentName.parse(source);
  environmentName.parse(destination);
  if (source === DEFAULT_ENVIRONMENT || destination === DEFAULT_ENVIRONMENT) {
    throw new Error("The base environment cannot be renamed or replaced");
  }
  if (source === destination) throw new Error("Source and destination environment names must differ");
  if (process.env.HARNESS_ENV === source) {
    throw new Error(`Environment ${source} is active in this shell; run harness deactivate first`);
  }
  return withEnvironmentPairLock(source, destination, async () => {
    const sourceRoot = path.dirname(environmentPath(projectRoot, source));
    const destinationRoot = path.dirname(environmentPath(projectRoot, destination));
    const environment = await readEnvironmentFile(projectRoot, source);
    const lock = await readEnvironmentLockFile(projectRoot, source);
    const loaded = await loadEnvironmentSnapshot(environment, lock);
    if (await pathExists(destinationRoot)) throw new Error(`Environment already exists: ${destination}`);
    const renamed: HarnessEnvironment = { ...environment, metadata: { name: destination } };
    let moved = false;
    try {
      await rename(sourceRoot, destinationRoot);
      moved = true;
      await rewriteRenamedEnvironmentLinks(destinationRoot, sourceRoot, destinationRoot);
      await writeEnvironment(projectRoot, renamed);
      const metadataPath = path.join(environmentViewPath(destination), "view.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      metadata.environment = destination;
      await writeJsonAtomic(metadataPath, metadata);
      await validateEnvironmentView(renamed, loaded.names.map((name) => loaded.packages.get(name)!));
      return renamed;
    } catch (error) {
      if (moved) {
        const rollbackErrors: unknown[] = [];
        await rewriteRenamedEnvironmentLinks(destinationRoot, destinationRoot, sourceRoot).catch((rollbackError) => {
          rollbackErrors.push(rollbackError);
        });
        let restored = false;
        try {
          await rename(destinationRoot, sourceRoot);
          restored = true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (restored) {
          await writeEnvironment(projectRoot, environment).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
          const metadataPath = path.join(environmentViewPath(source), "view.json");
          const metadata = await readFile(metadataPath, "utf8")
            .then((input) => JSON.parse(input) as Record<string, unknown>)
            .catch((rollbackError) => {
              rollbackErrors.push(rollbackError);
              return undefined;
            });
          if (metadata) {
            metadata.environment = source;
            await writeJsonAtomic(metadataPath, metadata).catch((rollbackError) => {
              rollbackErrors.push(rollbackError);
            });
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "Environment rename failed and rollback was incomplete");
        }
      }
      throw error;
    }
  });
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

async function publishEnvironmentUpdate(
  projectRoot: string,
  environmentNameValue: string,
  previousEnvironment: HarnessEnvironment,
  previousLock: LockFile,
  previous: LoadedEnvironment,
  updatedEnvironment: HarnessEnvironment,
  updatedLock: LockFile,
  desired: LoadedEnvironment,
  hooks: EnvironmentMutationHooks,
): Promise<void> {
  await materializeEnvironmentView(
    updatedEnvironment,
    desired.names.map((name) => desired.packages.get(name)!),
    {
      previousPackages: previous.names.map((name) => previous.packages.get(name)!),
      ...(hooks.onViewPrepared ? { beforePublish: hooks.onViewPrepared } : {}),
      beforeSwap: async () => {
        await hooks.onResourcesApplied?.();
        await writeEnvironmentInstall(
          projectRoot,
          environmentNameValue,
          updatedEnvironment,
          updatedLock,
          previousLock,
        );
        try {
          await hooks.onMetadataPrepared?.();
        } catch (error) {
          await writeJsonAtomic(environmentLockPath(projectRoot, environmentNameValue), previousLock);
          await writeEnvironment(projectRoot, previousEnvironment);
          throw error;
        }
        return async () => {
          await writeJsonAtomic(environmentLockPath(projectRoot, environmentNameValue), previousLock);
          await writeEnvironment(projectRoot, previousEnvironment);
        };
      },
    },
  );
}

export async function installIntoEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  source: string,
  cwd = process.cwd(),
  hooks: EnvironmentInstallHooks = {},
): Promise<{ environment: HarnessEnvironment; root: InstalledPackage; packages: InstalledPackage[] }> {
  const result = await installPackagesIntoEnvironment(projectRoot, environmentNameValue, [source], cwd, hooks);
  return { environment: result.environment, root: result.roots[0]!, packages: result.packages };
}

export async function installPackagesIntoEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  sources: string[],
  cwd = process.cwd(),
  hooks: EnvironmentInstallHooks = {},
): Promise<{ environment: HarnessEnvironment; roots: InstalledPackage[]; packages: InstalledPackage[] }> {
  if (sources.length === 0) throw new Error("Install at least one Package source");
  if (environmentNameValue === DEFAULT_ENVIRONMENT && !(await pathExists(environmentPath(projectRoot, environmentNameValue)))) {
    await ensureBaseEnvironment(projectRoot);
  }
  return withEnvironmentLock(environmentNameValue, async () => {
    const [environment, currentLock] = await Promise.all([
      readEnvironmentFile(projectRoot, environmentNameValue),
      readEnvironmentLockFile(projectRoot, environmentNameValue),
    ]);
    const currentNames = validateEnvironmentLockGraph(environment, currentLock);
    for (const packageName of currentNames) await repairLockedPackage(currentLock.packages[packageName]!);
    const previous = await loadEnvironmentSnapshot(environment, currentLock);
    const installations: PackageInstallPlan[] = [];
    for (const source of sources) {
      installations.push(await installPackageTree(source, cwd, sources.length === 1 ? hooks.sourceOptions : {}));
    }
    const resolved = new Map<string, InstalledPackage>();
    for (const installation of installations) {
      const foundationalSource = FOUNDATIONAL_SOURCES.get(installation.root.lock.name as typeof FOUNDATIONAL_PACKAGES[number]);
      if (foundationalSource && installation.root.lock.source !== foundationalSource) {
        throw new Error(`Foundational package ${installation.root.lock.name} can only be installed from ${foundationalSource}`);
      }
      for (const pkg of installation.packages) {
        const existing = resolved.get(pkg.lock.name);
        if (
          existing &&
          (existing.lock.version !== pkg.lock.version ||
            existing.lock.source !== pkg.lock.source ||
            existing.lock.commit !== pkg.lock.commit ||
            existing.lock.integrity !== pkg.lock.integrity)
        ) {
          throw new Error(
            `Conflicting resolutions for ${pkg.lock.name}: ${existing.lock.source}@${existing.lock.version} and ${pkg.lock.source}@${pkg.lock.version}`,
          );
        }
        if (!existing) resolved.set(pkg.lock.name, pkg);
      }
    }
    const next: LockFile = { lockfileVersion: 1, packages: { ...currentLock.packages } };
    for (const pkg of resolved.values()) {
      const existing = currentLock.packages[pkg.lock.name];
      const unchanged =
        existing &&
        existing.version === pkg.lock.version &&
        existing.source === pkg.lock.source &&
        existing.commit === pkg.lock.commit &&
        existing.integrity === pkg.lock.integrity &&
        existing.cacheKey === pkg.lock.cacheKey;
      next.packages[pkg.lock.name] = unchanged ? existing : pkg.lock;
    }
    let roots = environment.spec.roots;
    for (const installation of installations) {
      roots = roots.some((root) => root.name === installation.root.lock.name)
        ? roots.map((root) =>
            root.name === installation.root.lock.name ? { name: root.name, source: installation.root.lock.source } : root,
          )
        : [...roots, { name: installation.root.lock.name, source: installation.root.lock.source }];
    }
    const pruned = reachableLock(next, roots.map((root) => root.name));
    const updated: HarnessEnvironment = { ...environment, spec: { ...environment.spec, roots } };
    const desired = await loadEnvironmentSnapshot(updated, pruned);
    await publishEnvironmentUpdate(
      projectRoot,
      environmentNameValue,
      environment,
      currentLock,
      previous,
      updated,
      pruned,
      desired,
      hooks,
    );
    return {
      environment: updated,
      roots: installations.map((installation) => installation.root),
      packages: [...resolved.values()],
    };
  });
}

function requiringRoots(environment: HarnessEnvironment, lock: LockFile, packageName: string): string[] {
  return environment.spec.roots
    .map((root) => root.name)
    .filter((root) => dependencyOrder(lock, [root]).includes(packageName));
}

function effectivePlatforms(
  environment: HarnessEnvironment,
  pkg: InstalledPackage,
  resourcePlatforms?: Platform[],
): Platform[] {
  const supported = new Set(resourcePlatforms ?? pkg.manifest.spec.platforms);
  return environment.spec.targets.filter((target) => supported.has(target));
}

interface EnvironmentResourceKeys {
  skills: Map<string, string>;
  mcpServers: Map<string, string>;
  hooks: Map<string, string>;
}

function environmentResourceKeys(environment: HarnessEnvironment, packages: InstalledPackage[]): EnvironmentResourceKeys {
  const result: EnvironmentResourceKeys = {
    skills: new Map(),
    mcpServers: new Map(),
    hooks: new Map(),
  };
  for (const pkg of packages) {
    for (const skill of pkg.manifest.spec.skills) {
      for (const target of effectivePlatforms(environment, pkg)) {
        result.skills.set(`${target}\0${skill.name}`, skill.name);
      }
    }
    for (const server of pkg.manifest.spec.mcpServers) {
      for (const target of effectivePlatforms(environment, pkg, server.platforms)) {
        result.mcpServers.set(`${target}\0${server.name}`, server.name);
      }
    }
    for (const hook of pkg.manifest.spec.hooks) {
      const label = `${hook.event}${hook.matcher ? ` (${hook.matcher})` : ""}: ${hook.command}`;
      const identity = JSON.stringify([hook.event, hook.matcher ?? null, hook.command, hook.timeout ?? null]);
      for (const target of effectivePlatforms(environment, pkg, hook.platforms)) {
        result.hooks.set(`${target}\0${identity}`, label);
      }
    }
  }
  return result;
}

function removedResourceLabels(previous: Map<string, string>, desired: Map<string, string>): string[] {
  return [...new Set([...previous].filter(([key]) => !desired.has(key)).map(([, label]) => label))].sort();
}

export async function uninstallFromEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  packageName: string,
  options: EnvironmentUninstallOptions = {},
): Promise<EnvironmentUninstallResult> {
  if (options.dryRun && !(await pathExists(environmentPath(projectRoot, environmentNameValue)))) {
    throw new Error(`Unknown environment: ${environmentNameValue}; create or initialize it before previewing uninstall`);
  }
  if (environmentNameValue === DEFAULT_ENVIRONMENT && !options.dryRun) await ensureBaseEnvironment(projectRoot);
  return withEnvironmentLock(environmentNameValue, async () => {
    const [environment, currentLock] = await Promise.all([
      readEnvironmentFile(projectRoot, environmentNameValue),
      readEnvironmentLockFile(projectRoot, environmentNameValue),
    ]);
    const currentNames = validateEnvironmentLockGraph(environment, currentLock);
    if (!options.dryRun) {
      for (const currentName of currentNames) await repairLockedPackage(currentLock.packages[currentName]!);
    }
    const previous = await loadEnvironmentSnapshot(environment, currentLock);
    if (!currentLock.packages[packageName]) {
      throw new Error(`Package ${packageName} is not installed in Environment ${environmentNameValue}`);
    }
    if (FOUNDATIONAL_PACKAGES.includes(packageName as typeof FOUNDATIONAL_PACKAGES[number])) {
      throw new Error(`Cannot uninstall foundational Package ${packageName}; every Environment requires it`);
    }
    const root = environment.spec.roots.find((candidate) => candidate.name === packageName);
    if (!root) {
      const roots = requiringRoots(environment, currentLock, packageName);
      throw new Error(
        `Cannot uninstall ${packageName}: it is not a root Package in Environment ${environmentNameValue}; required by roots: ${roots.join(", ")}`,
      );
    }

    const roots = environment.spec.roots.filter((candidate) => candidate.name !== packageName);
    const updated: HarnessEnvironment = { ...environment, spec: { ...environment.spec, roots } };
    const pruned = reachableLock(currentLock, roots.map((candidate) => candidate.name));
    const desired = await loadEnvironmentSnapshot(updated, pruned);
    const removedNames = previous.names.filter((name) => !desired.packages.has(name));
    const orderedRemovedNames = [packageName, ...removedNames.filter((name) => name !== packageName)];
    const packages = orderedRemovedNames
      .filter((name) => previous.packages.has(name))
      .map((name) => previous.packages.get(name)!);
    const rootPackage = previous.packages.get(packageName)!;
    const previousResources = environmentResourceKeys(
      environment,
      previous.names.map((name) => previous.packages.get(name)!),
    );
    const desiredResources = environmentResourceKeys(
      updated,
      desired.names.map((name) => desired.packages.get(name)!),
    );
    const result: EnvironmentUninstallResult = {
      environment: updated,
      root: rootPackage,
      packages,
      dependencies: packages.filter((pkg) => pkg.lock.name !== packageName),
      skills: removedResourceLabels(previousResources.skills, desiredResources.skills),
      mcpServers: removedResourceLabels(previousResources.mcpServers, desiredResources.mcpServers),
      hooks: removedResourceLabels(previousResources.hooks, desiredResources.hooks),
      dryRun: options.dryRun ?? false,
    };
    if (result.dryRun) return result;
    await publishEnvironmentUpdate(
      projectRoot,
      environmentNameValue,
      environment,
      currentLock,
      previous,
      updated,
      pruned,
      desired,
      options,
    );
    return result;
  });
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
  for (const foundational of FOUNDATIONAL_PACKAGES) {
    const pkg = packages.get(foundational);
    if (!pkg || pkg.lock.source !== FOUNDATIONAL_SOURCES.get(foundational)) {
      throw new Error(`Foundational package ${foundational} must resolve from builtin:${foundational}`);
    }
    if (!pkg.manifest.spec.skills.some((skill) => skill.name === foundational)) {
      throw new Error(`Foundational package ${foundational} must provide Skill ${foundational}`);
    }
  }
  return { environment, lock, names, packages };
}

async function loadOrderedPackages(projectRoot: string, name: string): Promise<LoadedEnvironment> {
  const [environment, lock] = await Promise.all([readEnvironmentFile(projectRoot, name), readEnvironmentLockFile(projectRoot, name)]);
  return loadEnvironmentSnapshot(environment, lock);
}

export async function environmentInfo(projectRoot: string): Promise<CurrentEnvironmentContext> {
  const project = path.resolve(projectRoot);
  const memory = { project: projectMemoryPath(project), local: localMemoryPath(project) };
  const selected = process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT;
  if (selected === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(project);
  return withEnvironmentLock(selected, async () => {
    const loaded = await loadOrderedPackages(project, selected);
    const managedSkillNames = new Set<string>();
    for (const pkg of loaded.packages.values()) {
      for (const skill of pkg.manifest.spec.skills) managedSkillNames.add(skill.name);
    }
    const localSkills = await inspectEnvironmentLocalSkills(loaded.environment, managedSkillNames);
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
      environmentSkills: localSkills.skills,
      environmentSkillIssues: localSkills.issues,
    };
  });
}

interface PreparedEnvironmentTransition {
  actions: Action[];
  apply: () => Promise<{ result: EnvironmentActivationResult; rollback: () => Promise<void> }>;
}

async function prepareEnvironmentTransition(
  projectRoot: string,
  name: string,
  desired: LoadedEnvironment,
): Promise<PreparedEnvironmentTransition> {
  const gitExclude = await prepareLocalGitExcludes(projectRoot);
  const memoryInitialization = await prepareProjectMemoryInitialization(projectRoot);
  const contextTransition = await prepareMemoryBootstrapTransition(
    projectRoot,
    undefined,
    { targets: ["codex", "claude", "pi"], hasMemoryPackage: desired.names.includes(PROJECT_MEMORY_PACKAGE) },
  );
  return {
    actions: contextTransition.actions,
    apply: async () => {
      const rollbacks: (() => Promise<void>)[] = [];
      try {
        rollbacks.push(await gitExclude.apply());
        rollbacks.push(await memoryInitialization.apply());
        rollbacks.push(await contextTransition.apply());
        return {
          result: { name, packages: desired.names, targets: desired.environment.spec.targets, actions: contextTransition.actions },
          rollback: async () => {
            const errors: unknown[] = [];
            for (const rollback of [...rollbacks].reverse()) {
              try {
                await rollback();
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length > 0) throw new AggregateError(errors, "Could not roll back the project Environment transition");
          },
        };
      } catch (error) {
        return rollbackProjectChanges(rollbacks, error);
      }
    },
  };
}

export async function activateEnvironment(
  projectRoot: string,
  name: string,
  hooks: EnvironmentActivationHooks = {},
): Promise<EnvironmentActivationResult> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  return withEnvironmentLock(name, async () => {
    const loaded = await loadOrderedPackages(projectRoot, name);
    await validateEnvironmentView(loaded.environment, loaded.names.map((packageName) => loaded.packages.get(packageName)!));
    return withProjectLock(projectRoot, async () => {
      const transition = await prepareEnvironmentTransition(projectRoot, name, loaded);
      const applied = await transition.apply();
      try {
        await hooks.onProjectApplied?.();
        return applied.result;
      } catch (error) {
        try {
          await applied.rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Activation failed and project rollback was incomplete");
        }
        throw error;
      }
    });
  });
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

async function doctorEnvironmentUnlocked(projectRoot: string, name: string): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];
  let environment: HarnessEnvironment;
  try {
    environment = await readEnvironmentFile(projectRoot, name);
    checks.push({ status: "ok", label: "recipe", detail: environmentPath(projectRoot, name) });
  } catch (error) {
    checks.push({ status: "fail", label: "recipe", detail: (error as Error).message });
    return checks;
  }
  let lock: LockFile;
  let names: string[];
  try {
    lock = await readEnvironmentLockFile(projectRoot, name);
    names = validateEnvironmentLockGraph(environment, lock);
    checks.push({ status: "ok", label: "lock", detail: `${Object.keys(lock.packages).length} packages` });
  } catch (error) {
    checks.push({ status: "fail", label: "lock", detail: (error as Error).message });
    return checks;
  }
  checks.push({ status: "ok", label: "roots", detail: environment.spec.roots.map((root) => root.name).join(", ") || "none" });
  const managedSkillNames = new Set<string>();
  for (const packageName of names) {
    let pkg: InstalledPackage;
    try {
      pkg = await loadCachedPackage(lock.packages[packageName]!);
    } catch (error) {
      checks.push({ status: "fail", label: `package:${packageName}`, detail: (error as Error).message });
      continue;
    }
    checks.push({ status: "ok", label: `package:${packageName}`, detail: pkg.lock.version });
    for (const skill of pkg.manifest.spec.skills) managedSkillNames.add(skill.name);
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
  const localSkills = await inspectEnvironmentLocalSkills(environment, managedSkillNames);
  for (const skill of localSkills.skills) {
    checks.push({ status: "ok", label: `environment-skill:${skill.name}`, detail: `external at ${skill.path}` });
  }
  for (const issue of localSkills.issues) {
    checks.push({
      status: issue.kind === "conflict" ? "fail" : "warn",
      label: `environment-skill:${issue.entry}`,
      detail: issue.detail,
    });
  }
  const active = (process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT) === name;
  checks.push({ status: active ? "ok" : "warn", label: "activation", detail: active ? environment.spec.targets.join(", ") : "inactive" });
  if (active) {
    try {
      const hasMemoryPackage = names.includes(PROJECT_MEMORY_PACKAGE);
      const contextCheck = await prepareMemoryBootstrapTransition(
        projectRoot,
        { targets: ["codex", "claude", "pi"], hasMemoryPackage },
        { targets: ["codex", "claude", "pi"], hasMemoryPackage },
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

export async function doctorEnvironment(projectRoot: string, name: string): Promise<EnvironmentCheck[]> {
  if (name === DEFAULT_ENVIRONMENT && !(await pathExists(environmentPath(projectRoot, name)))) await ensureBaseEnvironment(projectRoot);
  return withEnvironmentLock(name, () => doctorEnvironmentUnlocked(projectRoot, name));
}
