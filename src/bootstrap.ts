import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createEnvironment,
  DEFAULT_ENVIRONMENT,
  ensureBaseEnvironment,
  environmentPath,
  removeEnvironment,
  renameEnvironment,
  validateEnvironmentState,
} from "./environment.js";
import { withEnvironmentLock } from "./environment-lock.js";
import { pathExists, womaHome, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { existingSkillNames, migrateExistingSkills } from "./migrate-skills.js";
import { sourceAgentHome, validateCodexSourceConfiguration } from "./view.js";
import type { Action, WomaEnvironment } from "./types.js";

export const IMPORTED_CODEX_ENVIRONMENT = "codex";
const initializedEnvironmentName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const pendingStateSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("pending"),
    initializationId: z.string().uuid(),
    importExistingCodex: z.boolean(),
  })
  .strict();
const completeStateSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("complete"),
    defaultEnvironment: initializedEnvironmentName,
  })
  .strict();
const initializationStateSchema = z.discriminatedUnion("status", [pendingStateSchema, completeStateSchema]);
const importedEnvironmentMarkerSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("WomaImportedCodexEnvironment"),
    initializationId: z.string().uuid(),
  })
  .strict();

type InitializationState = z.infer<typeof initializationStateSchema>;

export interface BootstrapResult {
  actions: Action[];
  defaultEnvironment: string;
  importedSkills: string[];
}

interface InitializedEnvironmentMutationHooks {
  onInitializationStateWritten?: () => Promise<void> | void;
  onReferencesUpdated?: () => Promise<void> | void;
}

interface BootstrapDecision {
  importExistingCodex: boolean;
  importedSkills: string[];
}

export function initializationStatePath(): string {
  return path.join(womaHome(), "initialization.json");
}

export function defaultEnvironmentPath(): string {
  return path.join(womaHome(), "default-environment");
}

function importedEnvironmentMarkerPath(projectRoot: string): string {
  return path.join(importedEnvironmentRoot(projectRoot), ".woma-import.json");
}

function importedEnvironmentRoot(projectRoot: string): string {
  return path.dirname(environmentPath(projectRoot, IMPORTED_CODEX_ENVIRONMENT));
}

async function reserveImportedEnvironment(projectRoot: string, initializationId: string): Promise<void> {
  const root = importedEnvironmentRoot(projectRoot);
  const staging = path.join(path.dirname(root), `.${IMPORTED_CODEX_ENVIRONMENT}.import-${initializationId}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeJsonAtomic(path.join(staging, ".woma-import.json"), {
      version: 1,
      kind: "WomaImportedCodexEnvironment",
      initializationId,
    });
    await rename(staging, root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readInitializationState(): Promise<InitializationState | undefined> {
  const filePath = initializationStatePath();
  const input = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (input === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
  const parsed = initializationStateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${filePath}: invalid Woma initialization state`);
  return parsed.data;
}

async function supportedCodexConfigurationExists(): Promise<boolean> {
  const home = sourceAgentHome("codex");
  for (const name of ["config.toml", "hooks.json"]) {
    const info = await stat(path.join(home, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isFile()) return true;
  }
  return false;
}

async function decideBootstrap(state: InitializationState | undefined): Promise<BootstrapDecision> {
  if (state?.status === "pending") {
    return {
      importExistingCodex: state.importExistingCodex,
      importedSkills: state.importExistingCodex ? await existingSkillNames("codex") : [],
    };
  }
  if (state?.status === "complete") {
    return { importExistingCodex: false, importedSkills: [] };
  }
  const importedSkills = await existingSkillNames("codex");
  return {
    importExistingCodex: importedSkills.length > 0 || (await supportedCodexConfigurationExists()),
    importedSkills,
  };
}

async function assertImportedEnvironmentAvailable(
  projectRoot: string,
  state: InitializationState | undefined,
  decision: BootstrapDecision,
): Promise<void> {
  if (
    decision.importExistingCodex &&
    state === undefined &&
    (await pathExists(importedEnvironmentRoot(projectRoot)))
  ) {
    throw new Error(
      `Cannot import existing Codex state because Environment ${IMPORTED_CODEX_ENVIRONMENT} already exists; ` +
        `rename or remove it, then rerun woma init`,
    );
  }
  if (
    decision.importExistingCodex &&
    state?.status === "pending" &&
    (await pathExists(importedEnvironmentRoot(projectRoot))) &&
    !(await importedEnvironmentBelongsTo(projectRoot, state.initializationId))
  ) {
    throw new Error(
      `Cannot resume Codex import because Environment ${IMPORTED_CODEX_ENVIRONMENT} does not belong to this initialization; ` +
        `rename or remove it, then rerun woma init`,
    );
  }
}

async function importedEnvironmentBelongsTo(projectRoot: string, initializationId: string): Promise<boolean> {
  const input = await readFile(importedEnvironmentMarkerPath(projectRoot), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (input === undefined) return false;
  try {
    const marker = importedEnvironmentMarkerSchema.safeParse(JSON.parse(input));
    return marker.success && marker.data.initializationId === initializationId;
  } catch {
    return false;
  }
}

async function preflightImport(projectRoot: string, decision: BootstrapDecision): Promise<void> {
  if (decision.importExistingCodex) await validateCodexSourceConfiguration();
  if (decision.importedSkills.length === 0) return;
  await migrateExistingSkills({
    projectRoot,
    environment: IMPORTED_CODEX_ENVIRONMENT,
    from: "codex",
    dryRun: true,
    allowMissingEnvironment: true,
  });
}

async function optionalText(filePath: string): Promise<string | undefined> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function bootstrapActions(
  projectRoot: string,
  state: InitializationState | undefined,
  decision: BootstrapDecision,
  defaultEnvironment: string,
): Promise<Action[]> {
  const actions: Action[] = [];
  if (!(await pathExists(environmentPath(projectRoot, DEFAULT_ENVIRONMENT)))) {
    actions.push({
      verb: "create",
      path: environmentPath(projectRoot, DEFAULT_ENVIRONMENT),
      detail: "clean base Environment",
    });
  }
  if (decision.importExistingCodex && !(await pathExists(environmentPath(projectRoot, IMPORTED_CODEX_ENVIRONMENT)))) {
    actions.push({
      verb: "create",
      path: environmentPath(projectRoot, IMPORTED_CODEX_ENVIRONMENT),
      detail: "one-time import of the existing Codex harness",
    });
  }
  if (state?.status !== "complete" || state.defaultEnvironment !== defaultEnvironment) {
    actions.push({
      verb: state ? "merge" : "create",
      path: initializationStatePath(),
      detail: "one-time Woma initialization state",
    });
  }
  const desiredDefault = `${defaultEnvironment}\n`;
  const currentDefault = await optionalText(defaultEnvironmentPath());
  if (currentDefault !== desiredDefault) {
    actions.push({
      verb: currentDefault === undefined ? "create" : "merge",
      path: defaultEnvironmentPath(),
      detail: `default Environment ${defaultEnvironment}`,
    });
  }
  return actions;
}

interface InitializedReferenceRollback {
  rollback: () => Promise<void>;
}

async function restoreInitializedReferences(
  state: Extract<InitializationState, { status: "complete" }>,
  defaultText: string | undefined,
): Promise<void> {
  await writeJsonAtomic(initializationStatePath(), state);
  if (defaultText === undefined) await rm(defaultEnvironmentPath(), { force: true });
  else await writeTextAtomic(defaultEnvironmentPath(), defaultText);
}

async function replaceInitializedDefault(
  current: string,
  replacement: string,
  hooks: InitializedEnvironmentMutationHooks = {},
): Promise<InitializedReferenceRollback | undefined> {
  initializedEnvironmentName.parse(replacement);
  const state = await readInitializationState();
  if (state?.status !== "complete" || state.defaultEnvironment !== current) return undefined;
  const previousDefault = await optionalText(defaultEnvironmentPath());
  const updatedState = {
    version: 1 as const,
    status: "complete" as const,
    defaultEnvironment: replacement,
  };
  try {
    await writeJsonAtomic(initializationStatePath(), updatedState);
    await hooks.onInitializationStateWritten?.();
    await writeTextAtomic(defaultEnvironmentPath(), `${replacement}\n`);
    await hooks.onReferencesUpdated?.();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await restoreInitializedReferences(state, previousDefault).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Environment reference update failed and rollback was incomplete");
    }
    throw error;
  }
  return { rollback: () => restoreInitializedReferences(state, previousDefault) };
}

async function rollbackInitializedMutation(
  error: unknown,
  references: InitializedReferenceRollback | undefined,
): Promise<never> {
  if (!references) throw error;
  try {
    await references.rollback();
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], "Environment mutation failed and default rollback was incomplete");
  }
  throw error;
}

export function renameInitializedEnvironment(
  projectRoot: string,
  source: string,
  destination: string,
  hooks: InitializedEnvironmentMutationHooks = {},
): Promise<WomaEnvironment> {
  // References move first so an interruption preserves the old Environment; init can then fall back from an incomplete target.
  return withEnvironmentLock("bootstrap", async () => {
    const references = await replaceInitializedDefault(source, destination, hooks);
    try {
      return await renameEnvironment(projectRoot, source, destination);
    } catch (error) {
      return rollbackInitializedMutation(error, references);
    }
  });
}

export function removeInitializedEnvironment(
  projectRoot: string,
  name: string,
  hooks: InitializedEnvironmentMutationHooks = {},
): Promise<void> {
  return withEnvironmentLock("bootstrap", async () => {
    const references = await replaceInitializedDefault(name, DEFAULT_ENVIRONMENT, hooks);
    try {
      await removeEnvironment(projectRoot, name);
    } catch (error) {
      return rollbackInitializedMutation(error, references);
    }
  });
}

async function completedDefault(
  projectRoot: string,
  state: Extract<InitializationState, { status: "complete" }>,
): Promise<string> {
  if (state.defaultEnvironment === DEFAULT_ENVIRONMENT) return DEFAULT_ENVIRONMENT;
  return validateEnvironmentState(projectRoot, state.defaultEnvironment).then(
    () => state.defaultEnvironment,
    () => DEFAULT_ENVIRONMENT,
  );
}

async function planBootstrap(projectRoot: string): Promise<BootstrapResult> {
  const state = await readInitializationState();
  if (state?.status === "complete") {
    const defaultEnvironment = await completedDefault(projectRoot, state);
    return {
      actions: await bootstrapActions(projectRoot, state, { importExistingCodex: false, importedSkills: [] }, defaultEnvironment),
      defaultEnvironment,
      importedSkills: [],
    };
  }
  const decision = await decideBootstrap(state);
  await assertImportedEnvironmentAvailable(projectRoot, state, decision);
  const defaultEnvironment = decision.importExistingCodex ? IMPORTED_CODEX_ENVIRONMENT : DEFAULT_ENVIRONMENT;
  await preflightImport(projectRoot, decision);
  return {
    actions: await bootstrapActions(projectRoot, state, decision, defaultEnvironment),
    defaultEnvironment,
    importedSkills: decision.importedSkills,
  };
}

export async function initializeBootstrap(projectRoot: string, dryRun = false): Promise<BootstrapResult> {
  if (dryRun) return planBootstrap(projectRoot);
  return withEnvironmentLock("bootstrap", async () => {
    const state = await readInitializationState();
    if (state?.status === "complete") {
      const defaultEnvironment = await completedDefault(projectRoot, state);
      const result: BootstrapResult = {
        actions: await bootstrapActions(
          projectRoot,
          state,
          { importExistingCodex: false, importedSkills: [] },
          defaultEnvironment,
        ),
        defaultEnvironment,
        importedSkills: [],
      };
      await ensureBaseEnvironment(projectRoot);
      if (defaultEnvironment === state.defaultEnvironment) {
        await writeTextAtomic(defaultEnvironmentPath(), `${defaultEnvironment}\n`);
      } else {
        await replaceInitializedDefault(state.defaultEnvironment, defaultEnvironment);
      }
      return result;
    }

    const decision = await decideBootstrap(state);
    await assertImportedEnvironmentAvailable(projectRoot, state, decision);
    await preflightImport(projectRoot, decision);
    const initializationId = state?.status === "pending" ? state.initializationId : randomUUID();
    const defaultEnvironment = decision.importExistingCodex ? IMPORTED_CODEX_ENVIRONMENT : DEFAULT_ENVIRONMENT;
    const actions = await bootstrapActions(projectRoot, state, decision, defaultEnvironment);
    const previousDefault = await optionalText(defaultEnvironmentPath());
    if (!state) {
      await writeJsonAtomic(initializationStatePath(), {
        version: 1,
        status: "pending",
        initializationId,
        importExistingCodex: decision.importExistingCodex,
      });
    }

    await ensureBaseEnvironment(projectRoot);
    const publish = async (): Promise<BootstrapResult> => {
      await assertImportedEnvironmentAvailable(projectRoot, state, decision);
      let importedEnvironmentOwned =
        state?.status === "pending" && (await importedEnvironmentBelongsTo(projectRoot, initializationId));
      let defaultWritten = false;
      try {
        if (decision.importExistingCodex) {
          if (
            state?.status === "pending" &&
            (await pathExists(environmentPath(projectRoot, IMPORTED_CODEX_ENVIRONMENT)))
          ) {
            const complete = await validateEnvironmentState(projectRoot, IMPORTED_CODEX_ENVIRONMENT).then(
              () => true,
              () => false,
            );
            if (!complete) await rm(importedEnvironmentRoot(projectRoot), { recursive: true, force: true });
          }
          if (!(await pathExists(environmentPath(projectRoot, IMPORTED_CODEX_ENVIRONMENT)))) {
            if (!(await pathExists(importedEnvironmentRoot(projectRoot)))) {
              await reserveImportedEnvironment(projectRoot, initializationId);
            }
            importedEnvironmentOwned = true;
            await createEnvironment(projectRoot, IMPORTED_CODEX_ENVIRONMENT, ["codex"]);
          }
          if (decision.importedSkills.length > 0) {
            await migrateExistingSkills({
              projectRoot,
              environment: IMPORTED_CODEX_ENVIRONMENT,
              from: "codex",
            });
          }
        }

        await writeTextAtomic(defaultEnvironmentPath(), `${defaultEnvironment}\n`);
        defaultWritten = true;
        await writeJsonAtomic(initializationStatePath(), {
          version: 1,
          status: "complete",
          defaultEnvironment,
        });
        return { actions, defaultEnvironment, importedSkills: decision.importedSkills };
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (importedEnvironmentOwned) {
          if (await pathExists(importedEnvironmentRoot(projectRoot))) {
            const ownershipMatches = await importedEnvironmentBelongsTo(projectRoot, initializationId);
            if (!ownershipMatches) {
              rollbackErrors.push(
                new Error(`Refusing to roll back Environment ${IMPORTED_CODEX_ENVIRONMENT}: import ownership changed`),
              );
            } else {
              await rm(importedEnvironmentRoot(projectRoot), { recursive: true, force: true }).catch((rollbackError) =>
                rollbackErrors.push(rollbackError),
              );
            }
          }
        }
        if (defaultWritten) {
          const restoreDefault = previousDefault === undefined
            ? rm(defaultEnvironmentPath(), { force: true })
            : writeTextAtomic(defaultEnvironmentPath(), previousDefault);
          await restoreDefault.catch((rollbackError) => rollbackErrors.push(rollbackError));
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "Woma initialization failed and rollback was incomplete");
        }
        throw error;
      }
    };

    return decision.importExistingCodex
      ? withEnvironmentLock(IMPORTED_CODEX_ENVIRONMENT, publish)
      : publish();
  });
}
