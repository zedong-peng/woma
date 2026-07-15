import path from "node:path";
import { readJson, writeJsonAtomic } from "./fs.js";
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

export async function putLock(projectRoot: string, pkg: LockedPackage): Promise<void> {
  const lock = await readLock(projectRoot);
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
