#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { activatePackage, deactivatePackage } from "./activation.js";
import { captureHarness } from "./capture.js";
import { doctorPackage, doctorProject, type Check } from "./doctor.js";
import { recordOutcome, workflowStats, type OutcomeStatus } from "./events.js";
import { createHandoff } from "./handoff.js";
import { installPackageSource, loadCachedPackage, syncLockedPackage } from "./package.js";
import { onboardProject } from "./onboard.js";
import { enterProfile, leaveProfile, switchProfile, type ProfileSwitchResult } from "./profile.js";
import {
  addPackageToProject,
  initProject,
  projectConfigPath,
  readProjectConfig,
  setBinding,
} from "./project.js";
import { scaffoldHarness } from "./scaffold.js";
import { readLock, putLock, readState } from "./store.js";
import { pathExists } from "./fs.js";
import type { Action, LockFile, Platform } from "./types.js";

const program = new Command();

function projectRoot(command: Command): string {
  const options = command.optsWithGlobals<{ project: string }>();
  return path.resolve(options.project);
}

function targets(input: string): Platform[] {
  const normalized = input === "both" ? ["codex", "claude"] : input.split(",");
  const result: Platform[] = [];
  for (const item of normalized) {
    const value = item.trim();
    if (value !== "codex" && value !== "claude") throw new Error(`Unknown target: ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function resolveName(lock: LockFile, requested?: string): string {
  if (requested) {
    if (!lock.packages[requested]) throw new Error(`${requested} is not installed; run harness install <source>`);
    return requested;
  }
  const names = Object.keys(lock.packages);
  if (names.length === 1 && names[0]) return names[0];
  if (names.length === 0) throw new Error("No harnesses installed in this project");
  throw new Error(`Choose a harness: ${names.join(", ")}`);
}

function printActions(actions: Action[], dryRun: boolean): void {
  if (actions.length === 0) {
    console.log("No changes.");
    return;
  }
  if (dryRun) console.log("Plan:");
  for (const action of actions) console.log(`  ${action.verb.padEnd(6)} ${action.path}  ${action.detail}`);
}

function printChecks(checks: Check[]): void {
  for (const check of checks) console.log(`  [${check.status}] ${check.label}: ${check.detail}`);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${(milliseconds / 60_000).toFixed(1)}m`;
}

function printSwitch(result: ProfileSwitchResult, dryRun: boolean): void {
  printActions(result.actions, dryRun);
  if (dryRun) return;
  if (result.name) {
    console.log(`Profile: ${result.name}`);
    console.log(`  packages  ${result.packages.join(", ") || "none"}`);
    console.log(`  targets   ${result.targets.join(", ")}`);
    if (result.handoff) console.log(`  handoff   ${result.handoff}`);
  } else {
    console.log("Profile environment is off.");
  }
}

async function ensureProject(project: string): Promise<void> {
  if (!(await pathExists(projectConfigPath(project)))) await initProject(project);
}

program
  .name("harness")
  .description("Switch reproducible workflow profiles across Codex and Claude Code")
  .version("0.3.1")
  .enablePositionalOptions()
  .option("-p, --project <directory>", "project to configure", process.cwd());

program
  .command("init [directory]")
  .description("scaffold a new harness package")
  .option("--name <name>", "package name")
  .action(async (directory: string | undefined, options: { name?: string }) => {
    const result = await scaffoldHarness(directory ?? ".", options.name);
    console.log(`Created ${result.name} in ${result.root}`);
  });

program
  .command("install <source>")
  .description("resolve and lock a local or Git harness (for example gh:org/repo#v1.0.0)")
  .option("--profile <profile>", "add the installed package to a workflow profile")
  .option("--base", "add the installed package to every profile", false)
  .action(async (source: string, options: { profile?: string; base: boolean }, command: Command) => {
    if (options.profile && options.base) throw new Error("Choose --profile or --base, not both");
    const project = projectRoot(command);
    const pkg = await installPackageSource(source, process.cwd());
    await putLock(project, pkg.lock);
    if (options.profile || options.base) {
      await ensureProject(project);
      await addPackageToProject(project, pkg.manifest.metadata.name, options.base ? { base: true } : { profile: options.profile! });
    }
    console.log(`Installed ${pkg.manifest.metadata.name}@${pkg.manifest.metadata.version}`);
    console.log(`  source     ${pkg.lock.source}`);
    console.log(`  integrity  ${pkg.lock.integrity}`);
    if (options.base) console.log("  profile    base");
    if (options.profile) console.log(`  profile    ${options.profile}`);
  });

program
  .command("onboard")
  .description("detect this repository and activate a ready-to-use research workflow")
  .option("--name <name>", "project name")
  .option("--agent <agent>", "default agent: auto, codex, or claude", "auto")
  .option("--target <target>", "auto, codex, claude, both, or a comma-separated list", "auto")
  .option("--no-switch", "configure profiles without activating research")
  .action(
    async (
      options: { name?: string; agent: string; target: string; switch: boolean },
      command: Command,
    ) => {
      if (options.agent !== "auto" && options.agent !== "codex" && options.agent !== "claude") {
        throw new Error("--agent must be auto, codex, or claude");
      }
      const result = await onboardProject(projectRoot(command), {
        ...(options.name ? { name: options.name } : {}),
        ...(options.agent === "auto" ? {} : { agent: options.agent }),
        ...(options.target === "auto" ? {} : { targets: targets(options.target) }),
        switchToResearch: options.switch,
      });
      console.log("Harness project is ready.");
      console.log(`  stack     ${result.detection.stacks.join(", ") || "unclassified"}`);
      console.log(`  targets   ${result.detection.targets.join(", ")}`);
      console.log(`  agent     ${result.detection.agent}`);
      for (const [name, value] of Object.entries(result.detection.bindings)) console.log(`  ${name.padEnd(9)} ${value}`);
      console.log(`  packages  ${result.packages.join(", ")}`);
      if (result.active) console.log("  profile   research");
      console.log(`Next: harness enter --agent ${result.detection.agent} research`);
    },
  );

program
  .command("sync")
  .description("restore every locked Harness package into the local cache")
  .action(async (_options: unknown, command: Command) => {
    const lock = await readLock(projectRoot(command));
    const packages = Object.values(lock.packages);
    if (packages.length === 0) throw new Error("No packages in .harness/lock.json");
    for (const locked of packages) {
      await syncLockedPackage(locked);
      console.log(`  [ok] ${locked.name}@${locked.version}  ${locked.resolved}`);
    }
    console.log(`Synced ${packages.length} package${packages.length === 1 ? "" : "s"}.`);
  });

const projectCommand = program.command("project").description("configure this project's workflow environment");

projectCommand
  .command("init")
  .description("create .harness/project.yaml with research and experiment profiles")
  .option("--name <name>", "project name")
  .option("--agent <agent>", "default agent: codex or claude", "codex")
  .option("--target <target>", "codex, claude, both, or a comma-separated list", "both")
  .action(async (options: { name?: string; agent: string; target: string }, command: Command) => {
    if (options.agent !== "codex" && options.agent !== "claude") throw new Error("--agent must be codex or claude");
    const project = projectRoot(command);
    const config = await initProject(project, {
      ...(options.name ? { name: options.name } : {}),
      agent: options.agent,
      targets: targets(options.target),
    });
    console.log(`Created Harness project ${config.metadata.name}`);
    console.log(`  config    ${projectConfigPath(project)}`);
    console.log(`  profiles  ${Object.keys(config.spec.profiles).join(", ")}`);
  });

const profileCommand = program.command("profile").description("compose packages into task profiles");

profileCommand
  .command("add <profile> <package>")
  .description("add an installed package to a profile; use profile name 'base' for every profile")
  .action(async (profile: string, packageName: string, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const config = await addPackageToProject(project, packageName, profile === "base" ? { base: true } : { profile });
    console.log(`Added ${packageName} to ${profile}`);
    if ((await readState(project)).profile) console.log("Run harness switch <profile> to apply the updated composition.");
    console.log(`  base      ${config.spec.base.join(", ") || "none"}`);
  });

profileCommand
  .command("list")
  .alias("ls")
  .description("show profile composition and the active phase")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [config, state] = await Promise.all([readProjectConfig(project), readState(project)]);
    console.log(`base: ${config.spec.base.join(", ") || "none"}`);
    for (const [name, profile] of Object.entries(config.spec.profiles)) {
      console.log(`${state.profile?.name === name ? "*" : " "} ${name}: ${profile.packages.join(", ") || "no packages"}`);
      console.log(`    ${profile.description}`);
    }
  });

program
  .command("bind <name> <command...>")
  .description("bind a reusable workflow to this project's build, test, benchmark, or other command")
  .action(async (name: string, commandParts: string[], _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const config = await setBinding(project, name, commandParts.join(" "));
    const active = (await readState(project)).profile;
    if (active) await switchProfile(project, active.name);
    console.log(`Bound ${name}: ${commandParts.join(" ")}`);
  });

program
  .command("switch <profile>")
  .description("atomically replace the active workflow profile while keeping base packages")
  .option("--dry-run", "show the profile transition without writing", false)
  .option("--repair", "replace a modified managed active-profile instruction block", false)
  .action(async (profile: string, options: { dryRun: boolean; repair: boolean }, command: Command) => {
    const result = await switchProfile(projectRoot(command), profile, options);
    printSwitch(result, options.dryRun);
  });

program
  .command("leave")
  .description("deactivate the current profile and remove its routing signal")
  .option("--dry-run", "show the profile transition without writing", false)
  .option("--repair", "remove a modified managed active-profile instruction block", false)
  .action(async (options: { dryRun: boolean; repair: boolean }, command: Command) => {
    const result = await leaveProfile(projectRoot(command), options);
    printSwitch(result, options.dryRun);
  });

program
  .command("current")
  .description("show the active workflow phase, composition, bindings, and handoff")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [config, state] = await Promise.all([readProjectConfig(project), readState(project)]);
    if (!state.profile) {
      console.log("No active profile.");
      return;
    }
    console.log(`Profile: ${state.profile.name}`);
    console.log(`  packages  ${state.profile.packages.join(", ") || "none"}`);
    console.log(`  targets   ${state.profile.targets.join(", ")}`);
    console.log(`  agent     ${config.spec.agent}`);
    if (state.profile.handoff) console.log(`  handoff   ${state.profile.handoff}`);
    for (const [name, value] of Object.entries(config.spec.bindings)) console.log(`  ${name.padEnd(9)} ${value}`);
  });

program
  .command("handoff <profile>")
  .description("create a structured phase handoff for the next profile")
  .action(async (profile: string, _options: unknown, command: Command) => {
    const filePath = await createHandoff(projectRoot(command), profile);
    console.log(`Created handoff: ${filePath}`);
    console.log(`Fill the evidence and acceptance criteria, then run: harness switch ${profile}`);
  });

program
  .command("outcome <status>")
  .description("record a local-only result for the active profile")
  .option("--artifact <path>", "result, report, benchmark, or other evidence path")
  .option("--note <text>", "short private note stored only in .harness/local")
  .action(
    async (
      status: string,
      options: { artifact?: string; note?: string },
      command: Command,
    ) => {
      if (status !== "success" && status !== "failure" && status !== "inconclusive") {
        throw new Error("status must be success, failure, or inconclusive");
      }
      const event = await recordOutcome(projectRoot(command), status as OutcomeStatus, options);
      console.log(`Recorded ${status} for ${event.profile}.`);
      if (event.artifact) console.log(`  artifact  ${event.artifact}`);
      console.log("  privacy   local only; no data uploaded");
    },
  );

program
  .command("stats")
  .description("summarize local workflow transitions, sessions, handoffs, and outcomes")
  .action(async (_options: unknown, command: Command) => {
    const stats = await workflowStats(projectRoot(command));
    console.log("Local workflow evidence");
    console.log(`  switches   ${stats.transitions.success} succeeded, ${stats.transitions.failure} failed`);
    console.log(`  handoffs   ${stats.handoffs}`);
    console.log(
      `  sessions   ${stats.sessions.completed}/${stats.sessions.started} completed, ${stats.sessions.nonzeroExit} nonzero${
        stats.sessions.medianDurationMs === undefined ? "" : `, median ${formatDuration(stats.sessions.medianDurationMs)}`
      }`,
    );
    console.log(
      `  outcomes   ${stats.outcomes.success} success, ${stats.outcomes.failure} failure, ${stats.outcomes.inconclusive} inconclusive`,
    );
    for (const [profile, outcomes] of Object.entries(stats.profiles)) {
      console.log(`  ${profile.padEnd(10)} ${outcomes.success} success, ${outcomes.failure} failure, ${outcomes.inconclusive} inconclusive`);
    }
    console.log("  privacy    read from .harness/local; no data uploaded");
  });

program
  .command("enter <profile> [agentArgs...]")
  .description("switch profile and launch a fresh Codex or Claude session")
  .option("-a, --agent <agent>", "codex or claude")
  .option("--repair", "replace a modified managed active-profile instruction block", false)
  .allowUnknownOption(true)
  .passThroughOptions()
  .action(async (profile: string, agentArgs: string[], options: { agent?: string; repair: boolean }, command: Command) => {
    if (options.agent !== undefined && options.agent !== "codex" && options.agent !== "claude") {
      throw new Error("--agent must be codex or claude");
    }
    const code = await enterProfile(projectRoot(command), profile, options.agent, agentArgs, { repair: options.repair });
    process.exitCode = code;
  });

program
  .command("capture <directory>")
  .description("capture an existing project's skills, MCP servers, and hooks as a secret-safe harness")
  .requiredOption("--from <platform>", "codex or claude")
  .option("--name <name>", "package name")
  .action(async (directory: string, options: { from: string; name?: string }, command: Command) => {
    if (options.from !== "codex" && options.from !== "claude") throw new Error("--from must be codex or claude");
    const result = await captureHarness({
      sourceRoot: projectRoot(command),
      outputRoot: directory,
      platform: options.from,
      ...(options.name ? { name: options.name } : {}),
    });
    console.log(`Captured ${result.manifest.metadata.name} in ${result.root}`);
    console.log(`  skills  ${result.manifest.spec.skills.length}`);
    console.log(`  MCP     ${result.manifest.spec.mcpServers.length}`);
    console.log(`  hooks   ${result.manifest.spec.hooks.length}`);
    for (const warning of result.warnings) console.log(`  [warn] ${warning}`);
  });

program
  .command("activate [name]")
  .description("activate an installed harness in a Codex or Claude Code project")
  .option("-t, --target <target>", "codex, claude, both, or a comma-separated list", "both")
  .option("--dry-run", "show changes without writing", false)
  .action(async (name: string | undefined, options: { target: string; dryRun: boolean }, command: Command) => {
    const project = projectRoot(command);
    if ((await readState(project)).profile) throw new Error("A workflow profile is active; use harness profile add and harness switch instead");
    const lock = await readLock(project);
    const selected = resolveName(lock, name);
    const pkg = await loadCachedPackage(lock.packages[selected]!);
    const actions = await activatePackage(pkg, project, targets(options.target), options.dryRun);
    printActions(actions, options.dryRun);
    if (!options.dryRun) console.log(`Activated ${selected} for ${targets(options.target).join(" + ")}`);
  });

program
  .command("use <source>")
  .description("install and activate a harness in one command")
  .option("-t, --target <target>", "codex, claude, both, or a comma-separated list", "both")
  .option("--dry-run", "resolve and show activation changes without writing target configs", false)
  .action(async (source: string, options: { target: string; dryRun: boolean }, command: Command) => {
    const project = projectRoot(command);
    if ((await readState(project)).profile) throw new Error("A workflow profile is active; install with --profile and run harness switch instead");
    const pkg = await installPackageSource(source, process.cwd());
    if (!options.dryRun) await putLock(project, pkg.lock);
    const actions = await activatePackage(pkg, project, targets(options.target), options.dryRun);
    printActions(actions, options.dryRun);
    if (!options.dryRun) console.log(`Installed and activated ${pkg.manifest.metadata.name}@${pkg.manifest.metadata.version}`);
  });

program
  .command("deactivate <name>")
  .description("remove only the configuration owned by an active harness")
  .option("--dry-run", "show changes without writing", false)
  .action(async (name: string, options: { dryRun: boolean }, command: Command) => {
    const project = projectRoot(command);
    if ((await readState(project)).profile?.packages.includes(name)) {
      throw new Error(`${name} belongs to the active profile; run harness leave or switch profiles`);
    }
    const actions = await deactivatePackage(name, project, options.dryRun);
    printActions(actions, options.dryRun);
    if (!options.dryRun) console.log(`Deactivated ${name}`);
  });

program
  .command("list")
  .alias("ls")
  .description("list installed and active harnesses")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [lock, state] = await Promise.all([readLock(project), readState(project)]);
    const names = Object.keys(lock.packages).sort();
    if (names.length === 0) {
      console.log("No harnesses installed.");
      return;
    }
    for (const name of names) {
      const pkg = lock.packages[name]!;
      const active = state.activations[name];
      console.log(`${active ? "*" : " "} ${name}@${pkg.version}${active ? `  active: ${active.targets.join(",")}` : ""}`);
    }
  });

program
  .command("doctor [name]")
  .description("verify workflow composition, dependencies, integrity, routing, and drift")
  .action(async (name: string | undefined, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [lock, state] = await Promise.all([readLock(project), readState(project)]);
    const names = name ? [resolveName(lock, name)] : Object.keys(lock.packages).sort();
    let failed = false;
    console.log("project");
    const projectChecks = await doctorProject(project);
    printChecks(projectChecks);
    failed ||= projectChecks.some((check) => check.status === "fail");
    if (names.length === 0 && !(await pathExists(projectConfigPath(project)))) {
      throw new Error("No Harness project or installed packages found");
    }
    for (const selected of names) {
      const pkg = await loadCachedPackage(lock.packages[selected]!);
      console.log(`${selected}@${pkg.manifest.metadata.version}`);
      const checks = await doctorPackage(pkg, project, {
        ...(name === undefined && state.profile ? { activationExpected: state.profile.packages.includes(selected) } : {}),
      });
      printChecks(checks);
      failed ||= checks.some((check) => check.status === "fail");
    }
    if (failed) process.exitCode = 1;
  });

program
  .command("inspect <source-or-name>")
  .description("show the contents and requirements of a harness")
  .action(async (sourceOrName: string, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const lock = await readLock(project);
    const pkg = lock.packages[sourceOrName]
      ? await loadCachedPackage(lock.packages[sourceOrName]!)
      : await installPackageSource(sourceOrName, process.cwd());
    const manifest = pkg.manifest;
    console.log(`${manifest.metadata.name}@${manifest.metadata.version}`);
    console.log(manifest.metadata.description);
    console.log(`  platforms  ${manifest.spec.platforms.join(", ")}`);
    console.log(`  skills     ${manifest.spec.skills.map((skill) => skill.name).join(", ") || "none"}`);
    console.log(`  MCP        ${manifest.spec.mcpServers.map((server) => server.name).join(", ") || "none"}`);
    console.log(`  hooks      ${manifest.spec.hooks.map((hook) => hook.event).join(", ") || "none"}`);
    console.log(`  env        ${manifest.spec.requirements.env.map((item) => item.name).join(", ") || "none"}`);
  });

program.configureOutput({
  outputError: (message, write) => write(`harness: ${message}`),
});

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`harness: ${error.message}`);
  process.exitCode = 1;
});
