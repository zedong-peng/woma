import path from "node:path";
import { satisfies } from "semver";
import { readJson, writeJsonAtomic } from "./fs.js";
import { loadCachedPackage } from "./package.js";
import type { ActivationRecord, ActiveProfileState, LockFile, LockedPackage, StateFile } from "./types.js";

function emptyLock(): LockFile {
  return { lockfileVersion: 1, packages: {} };
}

function emptyState(): StateFile {
  return { stateVersion: 1, activations: {} };
}

export function lockPath(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "lock.json");
}

export function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "state.json");
}

export async function readLock(projectRoot: string): Promise<LockFile> {
  const lock = await readJson<LockFile>(lockPath(projectRoot), emptyLock());
  if (lock.lockfileVersion !== 1 || typeof lock.packages !== "object") {
    throw new Error(`Unsupported lock file at ${lockPath(projectRoot)}`);
  }
  return lock;
}

export async function putLocks(projectRoot: string, packages: LockedPackage[]): Promise<void> {
  const [lock, state] = await Promise.all([readLock(projectRoot), readState(projectRoot)]);
  for (const pkg of packages) {
    const activation = state.activations[pkg.name];
    if (activation) {
      const current = lock.packages[pkg.name];
      const matchesActivation =
        activation.packageVersion === pkg.version &&
        (activation.packageIntegrity === undefined || activation.packageIntegrity === pkg.integrity) &&
        (activation.packageCacheKey === undefined || activation.packageCacheKey === pkg.cacheKey);
      const legacyIdentityUnchanged =
        activation.packageIntegrity === undefined &&
        activation.packageCacheKey === undefined &&
        current?.version === pkg.version &&
        current.integrity === pkg.integrity &&
        current.cacheKey === pkg.cacheKey;
      if (!matchesActivation || (!activation.packageIntegrity && !legacyIdentityUnchanged)) {
        throw new Error(
          `Cannot update ${pkg.name} lock while ${activation.packageVersion} is active; deactivate it before installing a new version`,
        );
      }
    }
  }
  const next: LockFile = { lockfileVersion: 1, packages: { ...lock.packages } };
  for (const pkg of packages) next.packages[pkg.name] = pkg;
  for (const locked of Object.values(next.packages)) {
    const pkg = await loadCachedPackage(locked);
    const declaredNames = pkg.manifest.spec.dependencies.map((dependency) => dependency.name);
    if (JSON.stringify(locked.dependencies ?? []) !== JSON.stringify(declaredNames)) {
      throw new Error(`Lock dependency edges for ${locked.name} do not match its manifest`);
    }
    for (const dependency of pkg.manifest.spec.dependencies) {
      const resolved = next.packages[dependency.name];
      if (!resolved) throw new Error(`Package ${locked.name} requires ${dependency.name}, which is missing from the lock`);
      if (!satisfies(resolved.version, dependency.version, { includePrerelease: true })) {
        throw new Error(
          `Package ${locked.name} requires ${dependency.name}@${dependency.version}, but the lock resolves ${resolved.version}`,
        );
      }
    }
  }
  await writeJsonAtomic(lockPath(projectRoot), next);
}

export async function putLock(projectRoot: string, pkg: LockedPackage): Promise<void> {
  await putLocks(projectRoot, [pkg]);
}

export async function readState(projectRoot: string): Promise<StateFile> {
  const state = await readJson<StateFile>(statePath(projectRoot), emptyState());
  if (state.stateVersion !== 1 || typeof state.activations !== "object") {
    throw new Error(`Unsupported state file at ${statePath(projectRoot)}`);
  }
  return state;
}

export async function putActivation(projectRoot: string, activation: ActivationRecord): Promise<void> {
  const state = await readState(projectRoot);
  state.activations[activation.packageName] = activation;
  await writeJsonAtomic(statePath(projectRoot), state);
}

export async function deleteActivation(projectRoot: string, packageName: string): Promise<void> {
  const state = await readState(projectRoot);
  delete state.activations[packageName];
  await writeJsonAtomic(statePath(projectRoot), state);
}

export async function putActiveProfile(projectRoot: string, profile: ActiveProfileState): Promise<void> {
  const state = await readState(projectRoot);
  state.profile = profile;
  await writeJsonAtomic(statePath(projectRoot), state);
}

export async function deleteActiveProfile(projectRoot: string): Promise<void> {
  const state = await readState(projectRoot);
  delete state.profile;
  await writeJsonAtomic(statePath(projectRoot), state);
}
