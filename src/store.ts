import path from "node:path";
import { readJson, writeJsonAtomic } from "./fs.js";
import type { ActivationRecord, ActiveEnvironmentState, StateFile } from "./types.js";

function emptyState(): StateFile {
  return { stateVersion: 1, activations: {} };
}

export function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "state.json");
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

export async function putActiveEnvironment(projectRoot: string, environment: ActiveEnvironmentState): Promise<void> {
  const state = await readState(projectRoot);
  state.activeEnvironment = environment;
  await writeJsonAtomic(statePath(projectRoot), state);
}

export async function deleteActiveEnvironment(projectRoot: string): Promise<void> {
  const state = await readState(projectRoot);
  delete state.activeEnvironment;
  await writeJsonAtomic(statePath(projectRoot), state);
}
