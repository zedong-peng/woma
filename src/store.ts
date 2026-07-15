import path from "node:path";
import { readJson, writeJsonAtomic } from "./fs.js";
import type { ActivationRecord, LockFile, LockedPackage, StateFile } from "./types.js";

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

export async function putLock(projectRoot: string, pkg: LockedPackage): Promise<void> {
  const [lock, state] = await Promise.all([readLock(projectRoot), readState(projectRoot)]);
  const activation = state.activations[pkg.name];
  const current = lock.packages[pkg.name];
  if (activation) {
    const unchanged =
      current !== undefined &&
      activation.packageVersion === pkg.version &&
      current.name === pkg.name &&
      current.version === pkg.version &&
      current.source === pkg.source &&
      current.resolved === pkg.resolved &&
      current.integrity === pkg.integrity &&
      current.cacheKey === pkg.cacheKey;
    if (!unchanged) {
      throw new Error(`${pkg.name}@${activation.packageVersion} is active; deactivate it before installing a different version`);
    }
    return;
  }
  lock.packages[pkg.name] = pkg;
  await writeJsonAtomic(lockPath(projectRoot), lock);
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
