import { lstat, readlink, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { satisfies } from "semver";
import { z } from "zod";
import { AGENT_SESSION_ENTRIES, AGENT_SKILLS_DIRECTORY } from "./agent-state-paths.js";
import { detectAgentCli, detectAgentClis, findExecutable, type AgentCliStatus } from "./agent-cli.js";
import { womaHome, pathExists, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { withEnvironmentLock, withProjectLock } from "./environment-lock.js";
import { installPackageTree, loadCachedPackage, repairLockedPackage, type PackageInstallPlan, type PackageSourceOptions } from "./package.js";
import { prepareLegacyMemoryCleanup } from "./legacy-memory-cleanup.js";
import {
  inspectEnvironmentLocalSkills,
  type EnvironmentLocalSkill,
  type EnvironmentLocalSkillIssue,
} from "./environment-skills.js";
import {
  environmentViewNeedsUpgrade,
  environmentViewPath,
  materializeEnvironmentView,
  sourceAgentHome,
  validateEnvironmentView,
} from "./view.js";
import type { Action, CodexClaudePlatform, WomaEnvironment, InstalledPackage, LockFile, LockedPackage, Platform } from "./types.js";

const environmentName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");
const platform = z.enum(["codex", "claude", "pi", "qoder"]);

export const DEFAULT_ENVIRONMENT = "base";
const CURRENT_ENVIRONMENT_API_VERSION = "woma.dev/environment-v2" as const;
const LEGACY_IMPLICIT_PACKAGES = new Map([
  ["woma-project-memory", "builtin:woma-project-memory"],
  ["woma-package-builder", "builtin:woma-package-builder"],
]);
const baseInitializations = new Map<string, Promise<WomaEnvironment>>();

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
    apiVersion: z.enum(["woma.dev/environment-v1", CURRENT_ENVIRONMENT_API_VERSION]),
    kind: z.literal("WomaEnvironment"),
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
  agentClis: Record<Platform, AgentCliStatus>;
  packages: {
    name: string;
    version: string;
    source: string;
    skills: string[];
    entrypoints: { name: string; skill: string; description: string }[];
  }[];
  environmentSkills: EnvironmentLocalSkill[];
  environmentSkillIssues: EnvironmentLocalSkillIssue[];
}

export interface EnvironmentSnapshot {
  environment: WomaEnvironment;
  lock: LockFile;
}

interface LoadedEnvironment {
  environment: WomaEnvironment;
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
  environment: WomaEnvironment;
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
  return path.join(womaHome(), "environments");
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

export function parseEnvironment(input: string, source = "environment.yaml"): WomaEnvironment {
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

async function readEnvironmentFile(projectRoot: string, name: string): Promise<WomaEnvironment> {
  const filePath = environmentPath(projectRoot, name);
  const input = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`Unknown environment: ${name}; run woma create --name ${name}`);
    }
    throw error;
  });
  const environment = parseEnvironment(input, filePath);
  if (environment.metadata.name !== name) {
    throw new Error(`${filePath}: metadata.name must match filename ${name}`);
  }
  return environment;
}

export async function readEnvironment(projectRoot: string, name: string): Promise<WomaEnvironment> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(projectRoot);
  return readEnvironmentFile(projectRoot, name);
}

async function writeEnvironment(projectRoot: string, environment: WomaEnvironment): Promise<void> {
  const validated = environmentSchema.parse(environment);
  await writeTextAtomic(environmentPath(projectRoot, validated.metadata.name), stringifyYaml(validated, { lineWidth: 120 }));
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
    if (environment.apiVersion === CURRENT_ENVIRONMENT_API_VERSION) {
      validateEnvironmentLockGraph(environment, lock);
      return { environment, lock };
    }
    const loaded = await upgradeLegacyEnvironmentUnlocked(projectRoot, name, environment, lock);
    return { environment: loaded.environment, lock: loaded.lock };
  });
}

async function initializeEnvironment(projectRoot: string, name: string, targets: Platform[]): Promise<WomaEnvironment> {
  environmentName.parse(name);
  if (await pathExists(environmentPath(projectRoot, name))) throw new Error(`Environment already exists: ${name}`);
  const environment: WomaEnvironment = {
    apiVersion: CURRENT_ENVIRONMENT_API_VERSION,
    kind: "WomaEnvironment",
    metadata: { name },
    spec: { targets: [...new Set(targets)], roots: [] },
  };
  environmentSchema.parse(environment);
  try {
    await materializeEnvironmentView(environment, [], {
      beforeSwap: async () => {
        await writeJsonAtomic(environmentLockPath(projectRoot, name), emptyLock());
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
): Promise<WomaEnvironment> {
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
      if (!(await pathExists(environmentLockPath(projectRoot, DEFAULT_ENVIRONMENT)))) {
        throw new Error(`Missing ${environmentLockPath(projectRoot, DEFAULT_ENVIRONMENT)}`);
      }
      const legacyEnvironment = await readEnvironmentFile(projectRoot, DEFAULT_ENVIRONMENT);
      const legacyLock = await readEnvironmentLockFile(projectRoot, DEFAULT_ENVIRONMENT);
      const loaded = await upgradeLegacyEnvironmentUnlocked(
        projectRoot,
        DEFAULT_ENVIRONMENT,
        legacyEnvironment,
        legacyLock,
      );
      const environment = loaded.environment;
      const packages = loaded.names.map((name) => loaded.packages.get(name)!);
      if (await environmentViewNeedsUpgrade(DEFAULT_ENVIRONMENT)) {
        await materializeEnvironmentView(environment, packages, { previousPackages: packages });
      } else {
        try {
          await validateEnvironmentView(environment, packages);
        } catch {
          await materializeEnvironmentView(environment, packages, { previousPackages: packages });
        }
      }
      await validateEnvironmentView(environment, packages);
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

export async function createEnvironment(projectRoot: string, name: string, targets: Platform[]): Promise<WomaEnvironment> {
  if (name === DEFAULT_ENVIRONMENT) {
    await ensureBaseEnvironment(projectRoot);
    throw new Error("The base environment exists implicitly and cannot be created");
  }
  return withEnvironmentLock(name, () => initializeEnvironment(projectRoot, name, targets));
}

export async function importEnvironmentSnapshot(
  projectRoot: string,
  sourceEnvironment: WomaEnvironment,
  lock: LockFile,
  requestedName = sourceEnvironment.metadata.name,
): Promise<EnvironmentSnapshot> {
  environmentName.parse(requestedName);
  if (requestedName === DEFAULT_ENVIRONMENT) {
    throw new Error("The base environment exists implicitly and cannot be imported; pass --name <name>");
  }
  const candidate: WomaEnvironment = {
    ...sourceEnvironment,
    metadata: { name: requestedName },
    spec: {
      targets: [...sourceEnvironment.spec.targets],
      roots: sourceEnvironment.spec.roots.map((root) => ({ ...root })),
    },
  };
  environmentSchema.parse(candidate);
  const normalized = normalizeLegacyEnvironmentSnapshot(candidate, lock);
  const environment = normalized.environment;
  const normalizedLock = normalized.lock;
  return withEnvironmentLock(requestedName, async () => {
    const root = path.dirname(environmentPath(projectRoot, requestedName));
    if (await pathExists(root)) throw new Error(`Environment already exists: ${requestedName}`);
    const loaded = await loadEnvironmentSnapshot(environment, normalizedLock);
    try {
      await materializeEnvironmentView(environment, loaded.names.map((name) => loaded.packages.get(name)!), {
        beforeSwap: async () => {
          await writeJsonAtomic(environmentLockPath(projectRoot, requestedName), normalizedLock);
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
      return { environment, lock: normalizedLock };
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
  if (process.env.WOMA_ENV === name) throw new Error(`Environment ${name} is active in this shell; run woma deactivate first`);
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
      const replacementInfo = process.platform === "win32" ? await lstat(replacement).catch(() => undefined) : undefined;
      await symlink(
        replacement,
        temporary,
        process.platform === "win32" ? (replacementInfo?.isDirectory() ? "junction" : "file") : undefined,
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

export async function renameEnvironment(projectRoot: string, source: string, destination: string): Promise<WomaEnvironment> {
  environmentName.parse(source);
  environmentName.parse(destination);
  if (source === DEFAULT_ENVIRONMENT || destination === DEFAULT_ENVIRONMENT) {
    throw new Error("The base environment cannot be renamed or replaced");
  }
  if (source === destination) throw new Error("Source and destination environment names must differ");
  if (process.env.WOMA_ENV === source) {
    throw new Error(`Environment ${source} is active in this shell; run woma deactivate first`);
  }
  return withEnvironmentPairLock(source, destination, async () => {
    const sourceRoot = path.dirname(environmentPath(projectRoot, source));
    const destinationRoot = path.dirname(environmentPath(projectRoot, destination));
    const legacyEnvironment = await readEnvironmentFile(projectRoot, source);
    const legacyLock = await readEnvironmentLockFile(projectRoot, source);
    const loaded = await upgradeLegacyEnvironmentUnlocked(projectRoot, source, legacyEnvironment, legacyLock);
    const environment = loaded.environment;
    const packages = loaded.names.map((name) => loaded.packages.get(name)!);
    if (await environmentViewNeedsUpgrade(source)) {
      await materializeEnvironmentView(environment, packages, { previousPackages: packages });
    }
    if (await pathExists(destinationRoot)) throw new Error(`Environment already exists: ${destination}`);
    const renamed: WomaEnvironment = { ...environment, metadata: { name: destination } };
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
      await validateEnvironmentView(renamed, packages);
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

function validateEnvironmentLockGraph(environment: WomaEnvironment, lock: LockFile): string[] {
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

async function validateEnvironmentLock(environment: WomaEnvironment, lock: LockFile): Promise<string[]> {
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

export function normalizeLegacyEnvironmentSnapshot(
  environment: WomaEnvironment,
  lock: LockFile,
): EnvironmentSnapshot & { migrated: boolean } {
  if (environment.apiVersion === CURRENT_ENVIRONMENT_API_VERSION) {
    return { environment, lock, migrated: false };
  }
  const roots = environment.spec.roots.filter(
    (root) => LEGACY_IMPLICIT_PACKAGES.get(root.name) !== root.source,
  );
  const normalized: WomaEnvironment = {
    ...environment,
    apiVersion: CURRENT_ENVIRONMENT_API_VERSION,
    spec: { ...environment.spec, roots },
  };
  const normalizedLock = reachableLock(lock, roots.map((root) => root.name));
  const retainedMemory = normalizedLock.packages["woma-project-memory"];
  if (retainedMemory?.source === "builtin:woma-project-memory") {
    throw new Error("A retained Package depends on the legacy implicit woma-project-memory; update that Package before migrating");
  }
  return { environment: normalized, lock: normalizedLock, migrated: true };
}

async function writeEnvironmentInstall(
  projectRoot: string,
  environmentNameValue: string,
  environment: WomaEnvironment,
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
  previousEnvironment: WomaEnvironment,
  previousLock: LockFile,
  previous: LoadedEnvironment,
  updatedEnvironment: WomaEnvironment,
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

async function upgradeLegacyEnvironmentUnlocked(
  projectRoot: string,
  environmentNameValue: string,
  environment: WomaEnvironment,
  lock: LockFile,
): Promise<LoadedEnvironment> {
  const normalized = normalizeLegacyEnvironmentSnapshot(environment, lock);
  if (!normalized.migrated) return loadEnvironmentSnapshot(environment, lock);

  const desired = await loadEnvironmentSnapshot(normalized.environment, normalized.lock);
  // Removed implicit helpers may no longer exist in the Store. View ownership metadata is enough to remove their Skill links.
  const previous: LoadedEnvironment = { ...desired, environment, lock };
  await publishEnvironmentUpdate(
    projectRoot,
    environmentNameValue,
    environment,
    lock,
    previous,
    normalized.environment,
    normalized.lock,
    desired,
    {},
  );
  return desired;
}

export async function installIntoEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  source: string,
  cwd = process.cwd(),
  hooks: EnvironmentInstallHooks = {},
): Promise<{ environment: WomaEnvironment; root: InstalledPackage; packages: InstalledPackage[] }> {
  const result = await installPackagesIntoEnvironment(projectRoot, environmentNameValue, [source], cwd, hooks);
  return { environment: result.environment, root: result.roots[0]!, packages: result.packages };
}

export async function installPackagesIntoEnvironment(
  projectRoot: string,
  environmentNameValue: string,
  sources: string[],
  cwd = process.cwd(),
  hooks: EnvironmentInstallHooks = {},
): Promise<{ environment: WomaEnvironment; roots: InstalledPackage[]; packages: InstalledPackage[] }> {
  if (sources.length === 0) throw new Error("Install at least one Package source");
  if (environmentNameValue === DEFAULT_ENVIRONMENT && !(await pathExists(environmentPath(projectRoot, environmentNameValue)))) {
    await ensureBaseEnvironment(projectRoot);
  }
  return withEnvironmentLock(environmentNameValue, async () => {
    const [legacyEnvironment, legacyLock] = await Promise.all([
      readEnvironmentFile(projectRoot, environmentNameValue),
      readEnvironmentLockFile(projectRoot, environmentNameValue),
    ]);
    let environment = legacyEnvironment;
    let currentLock = legacyLock;
    if (environment.apiVersion !== CURRENT_ENVIRONMENT_API_VERSION) {
      const migrated = await upgradeLegacyEnvironmentUnlocked(projectRoot, environmentNameValue, environment, currentLock);
      environment = migrated.environment;
      currentLock = migrated.lock;
    }
    const currentNames = validateEnvironmentLockGraph(environment, currentLock);
    for (const packageName of currentNames) await repairLockedPackage(currentLock.packages[packageName]!);
    const previous = await loadEnvironmentSnapshot(environment, currentLock);
    const installations: PackageInstallPlan[] = [];
    for (const source of sources) {
      installations.push(await installPackageTree(source, cwd, sources.length === 1 ? hooks.sourceOptions : {}));
    }
    const resolved = new Map<string, InstalledPackage>();
    for (const installation of installations) {
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
    const updated: WomaEnvironment = { ...environment, spec: { ...environment.spec, roots } };
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

function requiringRoots(environment: WomaEnvironment, lock: LockFile, packageName: string): string[] {
  return environment.spec.roots
    .map((root) => root.name)
    .filter((root) => dependencyOrder(lock, [root]).includes(packageName));
}

function effectivePlatforms(
  environment: WomaEnvironment,
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

function environmentResourceKeys(environment: WomaEnvironment, packages: InstalledPackage[]): EnvironmentResourceKeys {
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
    const [legacyEnvironment, legacyLock] = await Promise.all([
      readEnvironmentFile(projectRoot, environmentNameValue),
      readEnvironmentLockFile(projectRoot, environmentNameValue),
    ]);
    let environment = legacyEnvironment;
    let currentLock = legacyLock;
    if (environment.apiVersion !== CURRENT_ENVIRONMENT_API_VERSION && !options.dryRun) {
      const migrated = await upgradeLegacyEnvironmentUnlocked(projectRoot, environmentNameValue, environment, currentLock);
      environment = migrated.environment;
      currentLock = migrated.lock;
    } else if (environment.apiVersion !== CURRENT_ENVIRONMENT_API_VERSION) {
      const normalized = normalizeLegacyEnvironmentSnapshot(environment, currentLock);
      environment = normalized.environment;
      currentLock = normalized.lock;
    }
    const currentNames = validateEnvironmentLockGraph(environment, currentLock);
    if (!options.dryRun) {
      for (const currentName of currentNames) await repairLockedPackage(currentLock.packages[currentName]!);
    }
    const previous = await loadEnvironmentSnapshot(environment, currentLock);
    if (!currentLock.packages[packageName]) {
      throw new Error(`Package ${packageName} is not installed in Environment ${environmentNameValue}`);
    }
    const root = environment.spec.roots.find((candidate) => candidate.name === packageName);
    if (!root) {
      const roots = requiringRoots(environment, currentLock, packageName);
      throw new Error(
        `Cannot uninstall ${packageName}: it is not a root Package in Environment ${environmentNameValue}; required by roots: ${roots.join(", ")}`,
      );
    }

    const roots = environment.spec.roots.filter((candidate) => candidate.name !== packageName);
    const updated: WomaEnvironment = { ...environment, spec: { ...environment.spec, roots } };
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

async function loadEnvironmentSnapshot(environment: WomaEnvironment, lock: LockFile): Promise<LoadedEnvironment> {
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
  const [environment, lock] = await Promise.all([readEnvironmentFile(projectRoot, name), readEnvironmentLockFile(projectRoot, name)]);
  return upgradeLegacyEnvironmentUnlocked(projectRoot, name, environment, lock);
}

export async function environmentInfo(projectRoot: string): Promise<CurrentEnvironmentContext> {
  const project = path.resolve(projectRoot);
  const agentsPromise = detectAgentClis();
  const selected = process.env.WOMA_ENV || DEFAULT_ENVIRONMENT;
  if (selected === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(project);
  const agentClis = await agentsPromise;
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
      agentClis,
      packages: loaded.names.map((name) => {
        const pkg = loaded.packages.get(name)!;
        return {
          name,
          version: pkg.manifest.metadata.version,
          source: pkg.lock.source,
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
  const cleanup = await prepareLegacyMemoryCleanup(projectRoot);
  return {
    actions: cleanup.actions,
    apply: async () => {
      const rollback = await cleanup.apply();
      return {
        result: { name, packages: desired.names, targets: desired.environment.spec.targets, actions: cleanup.actions },
        rollback,
      };
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
    const packages = loaded.names.map((packageName) => loaded.packages.get(packageName)!);
    if (await environmentViewNeedsUpgrade(name)) {
      await materializeEnvironmentView(loaded.environment, packages, { previousPackages: packages });
    }
    await validateEnvironmentView(loaded.environment, packages);
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

async function doctorEnvironmentUnlocked(projectRoot: string, name: string): Promise<EnvironmentCheck[]> {
  const checks: EnvironmentCheck[] = [];
  let environment: WomaEnvironment;
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
  const targetAgents = await Promise.all(
    environment.spec.targets.map(async (target) => ({ target, agent: await detectAgentCli(target) })),
  );
  for (const { target, agent } of targetAgents) {
    checks.push({
      status: agent.available ? "ok" : "warn",
      label: `agent-cli:${target}`,
      detail: agent.path ?? `${agent.command} not found on PATH`,
    });
  }
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
      const found = await findExecutable(command);
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
  const active = (process.env.WOMA_ENV || DEFAULT_ENVIRONMENT) === name;
  checks.push({ status: active ? "ok" : "warn", label: "activation", detail: active ? environment.spec.targets.join(", ") : "inactive" });
  if (active) {
    try {
      const cleanup = await prepareLegacyMemoryCleanup(projectRoot);
      checks.push({
        status: cleanup.actions.length === 0 ? "ok" : "fail",
        label: "legacy-project-memory",
        detail: cleanup.actions.length === 0
          ? "no Woma-managed Memory discovery blocks"
          : `legacy cleanup required: ${cleanup.actions.map((action) => action.path).join(", ")}`,
      });
    } catch (error) {
      checks.push({ status: "fail", label: "legacy-project-memory", detail: (error as Error).message });
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
