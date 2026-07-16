#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { captureHarness } from "./capture.js";
import {
  activateEnvironment,
  bindEnvironment,
  createEnvironment,
  deactivateEnvironment,
  doctorEnvironment,
  environmentLockPath,
  environmentPath,
  installIntoEnvironment,
  listEnvironments,
  readEnvironment,
  readEnvironmentLock,
  removeEnvironment,
  syncEnvironment,
  type EnvironmentCheck,
} from "./environment.js";
import { installPackageSource, loadCachedPackage } from "./package.js";
import { scaffoldHarness } from "./scaffold.js";
import { readState } from "./store.js";
import type { Action, Platform } from "./types.js";

const program = new Command();

function projectRoot(command: Command): string {
  return path.resolve(command.optsWithGlobals<{ project: string }>().project);
}

function targets(input: string): Platform[] {
  const values = input === "both" ? ["codex", "claude"] : input.split(",");
  const result: Platform[] = [];
  for (const item of values) {
    const value = item.trim();
    if (value !== "codex" && value !== "claude") throw new Error(`Unknown target: ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  if (result.length === 0) throw new Error("Select at least one target");
  return result;
}

function printActions(actions: Action[]): void {
  if (actions.length === 0) {
    console.log("No file changes.");
    return;
  }
  for (const action of actions) console.log(`  ${action.verb.padEnd(6)} ${action.path}  ${action.detail}`);
}

function printChecks(checks: EnvironmentCheck[]): void {
  for (const check of checks) console.log(`  [${check.status}] ${check.label}: ${check.detail}`);
}

program
  .name("harness")
  .description("Create, reproduce, and switch isolated Agent environments")
  .version("0.6.0")
  .enablePositionalOptions()
  .option("-p, --project <directory>", "project whose Agent environment is managed", process.cwd());

program
  .command("init [directory]")
  .description("scaffold a new Harness package or meta-skill")
  .option("--name <name>", "package name")
  .action(async (directory: string | undefined, options: { name?: string }) => {
    const result = await scaffoldHarness(directory ?? ".", options.name);
    console.log(`Created ${result.name} in ${result.root}`);
  });

const envCommand = program.command("env").description("manage isolated Agent environments");

envCommand
  .command("create <name>")
  .description("create an empty named environment")
  .option("-t, --target <target>", "codex, claude, both, or a comma-separated list", "both")
  .action(async (name: string, options: { target: string }, command: Command) => {
    const project = projectRoot(command);
    const environment = await createEnvironment(project, name, targets(options.target));
    console.log(`Created environment ${name}`);
    console.log(`  recipe  ${environmentPath(project, name)}`);
    console.log(`  lock    ${environmentLockPath(project, name)}`);
    console.log(`  targets ${environment.spec.targets.join(", ")}`);
  });

envCommand
  .command("list")
  .alias("ls")
  .description("list named environments")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [names, state] = await Promise.all([listEnvironments(project), readState(project)]);
    if (names.length === 0) {
      console.log("No environments.");
      return;
    }
    for (const name of names) console.log(`${state.activeEnvironment?.name === name ? "*" : " "} ${name}`);
  });

envCommand
  .command("show <name>")
  .description("show an environment recipe and resolved package closure")
  .action(async (name: string, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [environment, lock, state] = await Promise.all([
      readEnvironment(project, name),
      readEnvironmentLock(project, name),
      readState(project),
    ]);
    console.log(`Environment: ${name}${state.activeEnvironment?.name === name ? " (active)" : ""}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${Object.values(lock.packages).map((pkg) => `${pkg.name}@${pkg.version}`).join(", ") || "none"}`);
    for (const [binding, value] of Object.entries(environment.spec.bindings)) console.log(`  ${binding.padEnd(9)} ${value}`);
  });

envCommand
  .command("remove <name>")
  .description("remove an inactive environment recipe and lock")
  .action(async (name: string, _options: unknown, command: Command) => {
    await removeEnvironment(projectRoot(command), name);
    console.log(`Removed environment ${name}`);
  });

program
  .command("install <source>")
  .description("install a package or meta-skill and its dependencies into an environment")
  .requiredOption("-n, --name <environment>", "destination environment")
  .action(async (source: string, options: { name: string }, command: Command) => {
    const result = await installIntoEnvironment(projectRoot(command), options.name, source, process.cwd());
    console.log(`Installed ${result.root.lock.name}@${result.root.lock.version} into ${options.name}`);
    console.log(`  source        ${result.root.lock.source}`);
    if (result.packages.length > 1) {
      console.log(`  dependencies  ${result.packages.slice(0, -1).map((pkg) => `${pkg.lock.name}@${pkg.lock.version}`).join(", ")}`);
    }
  });

program
  .command("bind <binding> <command...>")
  .description("bind a project command for Skills in an environment")
  .requiredOption("-n, --name <environment>", "environment to configure")
  .action(async (binding: string, commandParts: string[], options: { name: string }, command: Command) => {
    const value = commandParts.join(" ");
    await bindEnvironment(projectRoot(command), options.name, binding, value);
    console.log(`Bound ${binding} in ${options.name}: ${value}`);
  });

program
  .command("activate <environment>")
  .description("atomically activate or switch one complete environment")
  .action(async (name: string, _options: unknown, command: Command) => {
    const result = await activateEnvironment(projectRoot(command), name);
    printActions(result.actions);
    console.log(`Activated environment ${name}`);
    console.log(`  targets   ${result.targets.join(", ")}`);
    console.log(`  packages  ${result.packages.join(", ") || "none"}`);
  });

program
  .command("deactivate")
  .description("deactivate the complete active environment")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const state = await readState(project);
    const previous = state.activeEnvironment?.name ?? (state.profile ? `legacy profile ${state.profile.name}` : undefined);
    const result = await deactivateEnvironment(project);
    printActions(result.actions);
    console.log(`Deactivated environment ${previous}`);
  });

program
  .command("current")
  .description("show the active environment and its complete package closure")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const active = (await readState(project)).activeEnvironment;
    if (!active) {
      console.log("No active environment.");
      return;
    }
    const environment = await readEnvironment(project, active.name);
    console.log(`Environment: ${active.name}`);
    console.log(`  targets   ${active.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${active.packages.join(", ") || "none"}`);
    for (const [binding, value] of Object.entries(environment.spec.bindings)) console.log(`  ${binding.padEnd(9)} ${value}`);
  });

program
  .command("sync")
  .description("restore exact locked packages for one or every environment")
  .option("-n, --name <environment>", "environment to restore")
  .action(async (options: { name?: string }, command: Command) => {
    const project = projectRoot(command);
    const names = options.name ? [options.name] : await listEnvironments(project);
    if (names.length === 0) throw new Error("No environments to sync");
    for (const name of names) {
      const packages = await syncEnvironment(project, name);
      console.log(`Synced ${name}: ${packages.length} package${packages.length === 1 ? "" : "s"}`);
    }
  });

program
  .command("doctor")
  .description("verify environment recipes, locks, requirements, activation, and drift")
  .option("-n, --name <environment>", "environment to check")
  .action(async (options: { name?: string }, command: Command) => {
    const project = projectRoot(command);
    const state = await readState(project);
    const names = options.name ? [options.name] : state.activeEnvironment ? [state.activeEnvironment.name] : await listEnvironments(project);
    if (names.length === 0) throw new Error("No environments to check");
    let failed = false;
    for (const name of names) {
      console.log(name);
      const checks = await doctorEnvironment(project, name);
      printChecks(checks);
      failed ||= checks.some((check) => check.status === "fail");
    }
    if (failed) process.exitCode = 1;
  });

program
  .command("capture <directory>")
  .description("capture one Agent's Skills, MCP servers, and hooks as a Harness package")
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
  .command("inspect <source-or-name>")
  .description("show a package manifest from a source or environment lock")
  .option("-n, --name <environment>", "environment containing the locked package")
  .action(async (sourceOrName: string, options: { name?: string }, command: Command) => {
    let pkg;
    if (options.name) {
      const lock = await readEnvironmentLock(projectRoot(command), options.name);
      const locked = lock.packages[sourceOrName];
      if (!locked) throw new Error(`${sourceOrName} is not installed in environment ${options.name}`);
      pkg = await loadCachedPackage(locked);
    } else {
      pkg = await installPackageSource(sourceOrName, process.cwd());
    }
    const manifest = pkg.manifest;
    console.log(`${manifest.metadata.name}@${manifest.metadata.version}`);
    console.log(manifest.metadata.description);
    console.log(`  platforms     ${manifest.spec.platforms.join(", ")}`);
    console.log(`  dependencies  ${manifest.spec.dependencies.map((dependency) => `${dependency.name}@${dependency.version}`).join(", ") || "none"}`);
    console.log(`  entrypoints   ${manifest.spec.entrypoints.map((entrypoint) => entrypoint.name).join(", ") || "none"}`);
    console.log(`  skills        ${manifest.spec.skills.map((skill) => skill.name).join(", ") || "none"}`);
    console.log(`  MCP           ${manifest.spec.mcpServers.map((server) => server.name).join(", ") || "none"}`);
    console.log(`  hooks         ${manifest.spec.hooks.map((hook) => hook.event).join(", ") || "none"}`);
  });

program.configureOutput({ outputError: (message, write) => write(`harness: ${message}`) });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
