import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { activatePackage, deactivatePackage } from "./activation.js";
import { appendWorkflowEvent, classifyFailure } from "./events.js";
import { handoffIssues, latestHandoff } from "./handoff.js";
import { relativeDisplay, writeTextAtomic } from "./fs.js";
import { loadCachedPackage } from "./package.js";
import { readProjectConfig } from "./project.js";
import { deleteActiveProfile, putActiveProfile, readLock, readState } from "./store.js";
import type { Action, ActiveInstruction, ActiveProfileState, InstalledPackage, Platform } from "./types.js";

export interface ProfileSwitchResult {
  name?: string;
  packages: string[];
  targets: Platform[];
  handoff?: string;
  actions: Action[];
}

interface InstructionUpdate {
  instructions: ActiveInstruction[];
  actions: Action[];
  rollback: () => Promise<void>;
}

const instructionMarker = "harness-conda:active-profile";

function markerPattern(): RegExp {
  return new RegExp(`(?:^|\\n)<!-- >>> ${instructionMarker} -->\\n[\\s\\S]*?\\n<!-- <<< ${instructionMarker} -->(?=\\n|$)`, "m");
}

async function readOptional(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function sameItems(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function activeBlock(
  projectName: string,
  profileName: string,
  description: string,
  packages: InstalledPackage[],
  bindings: Record<string, string>,
  handoff?: string,
): string {
  const packageLines = packages.flatMap((pkg) => {
    const skills = pkg.manifest.spec.skills.map((skill) => skill.name).join(", ") || "none";
    return [`- ${pkg.manifest.metadata.name}@${pkg.manifest.metadata.version}: ${pkg.manifest.metadata.description}`, `  Skills: ${skills}`];
  });
  const bindingLines = Object.entries(bindings).map(([name, command]) => `- ${name}: \`${command}\``);
  return `<!-- >>> ${instructionMarker} -->
## Active Harness Profile: ${profileName}

Project: ${projectName}

${description}

Treat this profile as a strong routing signal for the current phase. Use the relevant installed skills and project bindings. Do not apply assumptions from inactive profiles. Preserve reproducible evidence and explicit failure cases.

### Active packages

${packageLines.join("\n") || "- No packages; follow the profile description and bindings."}

### Project bindings

${bindingLines.join("\n") || "- No project-specific commands declared."}

### Phase input

${handoff ? `Read the latest handoff before acting: \`${handoff}\`` : "No handoff targets this profile. Establish inputs and assumptions before acting."}

Before ending a meaningful task, record its result with \`harness outcome success|failure|inconclusive\`. Before moving to another phase, create a structured handoff with \`harness handoff <next-profile>\`.
<!-- <<< ${instructionMarker} -->`;
}

async function assertInstructionOwnership(
  projectRoot: string,
  previous: ActiveProfileState | undefined,
  targets: Platform[],
  repair: boolean,
): Promise<void> {
  if (repair) return;
  const desiredPaths = targets.map((target) => (target === "codex" ? "AGENTS.md" : "CLAUDE.md"));
  const previousByPath = new Map(previous?.instructions.map((item) => [item.path, item]) ?? []);
  const paths = new Set([...desiredPaths, ...previousByPath.keys()]);
  for (const relative of paths) {
    const current = (await readOptional(path.join(projectRoot, relative))) ?? "";
    const match = current.match(markerPattern());
    const currentBlock = match?.[0].replace(/^\n/, "");
    const expected = previousByPath.get(relative)?.block;
    if ((expected && currentBlock !== expected) || (!expected && match)) {
      throw new Error(`${relative} active-profile block was modified or removed; review it and rerun with --repair`);
    }
  }
}

async function applyInstructions(
  projectRoot: string,
  previous: ActiveProfileState | undefined,
  targets: Platform[],
  block: string | undefined,
  repair: boolean,
): Promise<InstructionUpdate> {
  const desiredPaths = new Set<string>(
    targets.map((target) => (target === "codex" ? "AGENTS.md" : "CLAUDE.md")),
  );
  const previousByPath = new Map(previous?.instructions.map((item) => [item.path, item]) ?? []);
  const paths = new Set([...desiredPaths, ...previousByPath.keys()]);
  const prepared: { absolute: string; relative: string; original: string | null; content: string }[] = [];
  const instructions: ActiveInstruction[] = [];
  const actions: Action[] = [];

  for (const relative of paths) {
    const absolute = path.join(projectRoot, relative);
    const original = await readOptional(absolute);
    const current = original ?? "";
    const match = current.match(markerPattern());
    const currentBlock = match?.[0].replace(/^\n/, "");
    const expected = previousByPath.get(relative)?.block;
    if (!repair && ((expected && currentBlock !== expected) || (!expected && match))) {
      throw new Error(`${relative} active-profile block was modified or removed; review it and rerun with --repair`);
    }

    let content = current;
    if (desiredPaths.has(relative) && block) {
      if (match) content = current.replace(markerPattern(), `${match[0].startsWith("\n") ? "\n" : ""}${block}`);
      else content = `${current.trimEnd()}${current.trimEnd() ? "\n\n" : ""}${block}\n`;
      instructions.push({ path: relative, block });
      actions.push({ verb: match ? "merge" : "create", path: relative, detail: "active profile routing signal" });
    } else if (match) {
      content = current.replace(markerPattern(), "").replace(/^\n+|\n+$/g, "");
      if (content) content += "\n";
      actions.push({ verb: "remove", path: relative, detail: "active profile routing signal" });
    }
    if (content !== current) prepared.push({ absolute, relative, original, content });
  }

  const written: typeof prepared = [];
  try {
    for (const file of prepared) {
      if ((await readOptional(file.absolute)) !== file.original) throw new Error(`${file.relative} changed during profile switch; retry`);
      if (file.content) await writeTextAtomic(file.absolute, file.content);
      else await rm(file.absolute, { force: true });
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      if (file.original === null) await rm(file.absolute, { force: true });
      else await writeTextAtomic(file.absolute, file.original);
    }
    throw error;
  }

  return {
    instructions,
    actions,
    rollback: async () => {
      for (const file of [...written].reverse()) {
        if (file.original === null) await rm(file.absolute, { force: true });
        else await writeTextAtomic(file.absolute, file.original);
      }
    },
  };
}

async function loadProfilePackages(projectRoot: string, names: string[]): Promise<Map<string, InstalledPackage>> {
  const lock = await readLock(projectRoot);
  const packages = new Map<string, InstalledPackage>();
  for (const name of names) {
    const locked = lock.packages[name];
    if (!locked) throw new Error(`${name} is configured but not installed; run harness install <source> --profile <name>`);
    packages.set(name, await loadCachedPackage(locked));
  }
  return packages;
}

function packageTargets(pkg: InstalledPackage, targets: Platform[]): Platform[] {
  const selected = targets.filter((target) => pkg.manifest.spec.platforms.includes(target));
  if (selected.length === 0) throw new Error(`${pkg.manifest.metadata.name} supports none of the project's targets`);
  return selected;
}

async function switchInternal(
  projectRoot: string,
  profileName: string | undefined,
  options: { dryRun?: boolean; repair?: boolean } = {},
): Promise<ProfileSwitchResult> {
  const project = path.resolve(projectRoot);
  const [config, state] = await Promise.all([readProjectConfig(project), readState(project)]);
  const previous = state.profile;
  const profile = profileName ? config.spec.profiles[profileName] : undefined;
  if (profileName && !profile) throw new Error(`Unknown profile: ${profileName}`);
  if (!previous && !profileName) return { packages: [], targets: [], actions: [] };

  const desiredNames = profile ? [...new Set([...config.spec.base, ...profile.packages])] : [];
  const previousNames = previous?.packages ?? [];
  const allNames = [...new Set([...desiredNames, ...previousNames])];
  const packages = await loadProfilePackages(project, allNames);
  const desiredTargets = new Map(desiredNames.map((name) => [name, packageTargets(packages.get(name)!, config.spec.targets)]));
  const handoff = profileName ? await latestHandoff(project, profileName) : undefined;
  if (profile?.handoff === "required") {
    if (!handoff) throw new Error(`Profile ${profileName} requires a handoff; run harness handoff ${profileName} from the previous phase`);
    const issues = await handoffIssues(project, handoff);
    if (issues.length > 0) throw new Error(`Handoff ${handoff} is not ready: ${issues.join("; ")}`);
  }

  const previousSet = new Set(previousNames);
  const desiredSet = new Set(desiredNames);
  for (const activeName of Object.keys(state.activations)) {
    if (!previousSet.has(activeName)) {
      throw new Error(`${activeName} was activated outside the profile system; deactivate it before switching profiles`);
    }
  }
  for (const name of previousNames) {
    if (!state.activations[name]) throw new Error(`Active profile state is inconsistent: ${name} is missing; run harness doctor`);
  }

  const removals = previousNames.filter((name) => {
    if (!desiredSet.has(name)) return true;
    return !sameItems(state.activations[name]!.targets, desiredTargets.get(name)!);
  });
  const additions = desiredNames.filter((name) => {
    if (!previousSet.has(name)) return true;
    return removals.includes(name);
  });
  const actions: Action[] = [];
  for (const name of removals) actions.push({ verb: "remove", path: ".harness/profile", detail: `package ${name}` });
  for (const name of additions) actions.push({ verb: "create", path: ".harness/profile", detail: `package ${name}` });
  const predictedInstructionActions: Action[] = [];
  if (profileName) {
    for (const target of config.spec.targets) {
      predictedInstructionActions.push({
        verb: previous ? "merge" : "create",
        path: target === "codex" ? "AGENTS.md" : "CLAUDE.md",
        detail: `route Agent to ${profileName}`,
      });
    }
  } else if (previous) {
    for (const instruction of previous.instructions) {
      predictedInstructionActions.push({ verb: "remove", path: instruction.path, detail: "active profile routing signal" });
    }
  }
  if (options.dryRun) {
    return {
      ...(profileName ? { name: profileName } : {}),
      packages: desiredNames,
      targets: config.spec.targets,
      actions: [...actions, ...predictedInstructionActions],
    };
  }

  await assertInstructionOwnership(project, previous, profileName ? config.spec.targets : [], options.repair ?? false);

  for (const name of removals) {
    const plan = await deactivatePackage(name, project, true);
    if (plan.some((action) => action.verb === "keep")) {
      throw new Error(`${name} has modified or missing managed files; resolve drift before switching profiles`);
    }
  }

  const removed: { pkg: InstalledPackage; targets: Platform[] }[] = [];
  const added: string[] = [];
  let instructionUpdate: InstructionUpdate | undefined;
  try {
    for (const name of removals) {
      removed.push({ pkg: packages.get(name)!, targets: [...state.activations[name]!.targets] });
      await deactivatePackage(name, project);
    }
    for (const name of additions) {
      await activatePackage(packages.get(name)!, project, desiredTargets.get(name)!);
      added.push(name);
    }

    const block = profileName
      ? activeBlock(config.metadata.name, profileName, profile!.description, desiredNames.map((name) => packages.get(name)!), config.spec.bindings, handoff)
      : undefined;
    instructionUpdate = await applyInstructions(project, previous, profileName ? config.spec.targets : [], block, options.repair ?? false);
    if (profileName) {
      await putActiveProfile(project, {
        name: profileName,
        packages: desiredNames,
        targets: config.spec.targets,
        activatedAt: new Date().toISOString(),
        instructions: instructionUpdate.instructions,
        ...(handoff ? { handoff } : {}),
      });
    } else {
      await deleteActiveProfile(project);
    }
    return {
      ...(profileName ? { name: profileName } : {}),
      packages: desiredNames,
      targets: profileName ? config.spec.targets : [],
      ...(handoff ? { handoff } : {}),
      actions: [...actions, ...instructionUpdate.actions],
    };
  } catch (error) {
    await instructionUpdate?.rollback();
    for (const name of [...added].reverse()) {
      await deactivatePackage(name, project).catch(() => undefined);
    }
    for (const item of removed) {
      await activatePackage(item.pkg, project, item.targets).catch(() => undefined);
    }
    throw error;
  }
}

export async function switchProfile(
  projectRoot: string,
  profileName: string,
  options: { dryRun?: boolean; repair?: boolean } = {},
): Promise<ProfileSwitchResult> {
  if (options.dryRun) return switchInternal(projectRoot, profileName, options);
  const started = Date.now();
  const from = (await readState(projectRoot)).profile?.name;
  try {
    const result = await switchInternal(projectRoot, profileName, options);
    if (from !== profileName) {
      await appendWorkflowEvent(projectRoot, {
        type: "profile_transition",
        ...(from ? { from } : {}),
        to: profileName,
        status: "success",
        durationMs: Date.now() - started,
        packages: result.packages,
        ...(result.handoff ? { handoff: result.handoff } : {}),
      }).catch(() => undefined);
    }
    return result;
  } catch (error) {
    await appendWorkflowEvent(projectRoot, {
      type: "profile_transition",
      ...(from ? { from } : {}),
      to: profileName,
      status: "failure",
      reason: classifyFailure(error),
      durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  }
}

export async function leaveProfile(
  projectRoot: string,
  options: { dryRun?: boolean; repair?: boolean } = {},
): Promise<ProfileSwitchResult> {
  if (options.dryRun) return switchInternal(projectRoot, undefined, options);
  const started = Date.now();
  const from = (await readState(projectRoot)).profile?.name;
  try {
    const result = await switchInternal(projectRoot, undefined, options);
    if (from) {
      await appendWorkflowEvent(projectRoot, {
        type: "profile_transition",
        from,
        status: "success",
        durationMs: Date.now() - started,
        packages: [],
      }).catch(() => undefined);
    }
    return result;
  } catch (error) {
    await appendWorkflowEvent(projectRoot, {
      type: "profile_transition",
      ...(from ? { from } : {}),
      status: "failure",
      reason: classifyFailure(error),
      durationMs: Date.now() - started,
    }).catch(() => undefined);
    throw error;
  }
}

export async function enterProfile(
  projectRoot: string,
  profileName: string,
  agent: Platform | undefined,
  agentArgs: string[],
  options: { repair?: boolean } = {},
): Promise<number> {
  const config = await readProjectConfig(projectRoot);
  const selectedAgent = agent ?? config.spec.agent;
  if (!config.spec.targets.includes(selectedAgent)) throw new Error(`${selectedAgent} is not configured as a project target`);
  await switchProfile(projectRoot, profileName, options);
  const started = Date.now();
  const sessionId = randomUUID();
  await appendWorkflowEvent(projectRoot, {
    type: "session_start",
    profile: profileName,
    agent: selectedAgent,
    sessionId,
  }).catch(() => undefined);
  return new Promise((resolve, reject) => {
    const child = spawn(selectedAgent, agentArgs, { cwd: projectRoot, stdio: "inherit", env: process.env });
    let settled = false;
    child.on("error", async (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      await appendWorkflowEvent(projectRoot, {
        type: "session_end",
        profile: profileName,
        agent: selectedAgent,
        sessionId,
        exitCode: 127,
        durationMs: Date.now() - started,
      }).catch(() => undefined);
      if (error.code === "ENOENT") reject(new Error(`${selectedAgent} is not installed or not on PATH`));
      else reject(error);
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      await appendWorkflowEvent(projectRoot, {
        type: "session_end",
        profile: profileName,
        agent: selectedAgent,
        sessionId,
        exitCode,
        durationMs: Date.now() - started,
      }).catch(() => undefined);
      resolve(exitCode);
    });
  });
}
