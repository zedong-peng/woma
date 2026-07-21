#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { captureHarness } from "./capture.js";
import { exportEnvironmentBundle, importEnvironmentBundle } from "./environment-bundle.js";
import {
  activateEnvironment,
  createEnvironment,
  environmentInfo,
  environmentSnapshot,
  deactivateEnvironment,
  doctorEnvironment,
  DEFAULT_ENVIRONMENT,
  environmentLockPath,
  environmentPath,
  ensureBaseEnvironment,
  FOUNDATIONAL_PACKAGES,
  installIntoEnvironment,
  listEnvironments,
  readEnvironmentLock,
  removeEnvironment,
  syncEnvironment,
  type EnvironmentCheck,
} from "./environment.js";
import { installPackageSource, loadCachedPackage } from "./package.js";
import { scaffoldHarness } from "./scaffold.js";
import { renderShellHook, resolveShell } from "./shell.js";
import { migrateExistingSkills, type SkillMigrationSource } from "./migrate-skills.js";
import { migrateExistingSessions } from "./migrate-sessions.js";
import type { Action, Platform } from "./types.js";

const program = new Command();

function projectRoot(command: Command): string {
  const configured = command.optsWithGlobals<{ project?: string }>().project;
  return path.resolve(configured ?? process.cwd());
}

function selectedEnvironment(requested?: string): string {
  if (requested) return requested;
  return process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT;
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
  .option("-p, --project <directory>", "project whose Memory is managed; defaults to the current directory");

program
  .command("init [directory]")
  .description("scaffold a new Harness package")
  .option("--name <name>", "package name")
  .action(async (directory: string | undefined, options: { name?: string }) => {
    const result = await scaffoldHarness(directory ?? ".", options.name);
    console.log(`Created ${result.name} in ${result.root}`);
  });

const envCommand = program.command("env").description("manage isolated Agent environments");

function migrationSource(input: string): SkillMigrationSource {
  if (input !== "codex" && input !== "claude" && input !== "both") {
    throw new Error("--from must be codex, claude, or both");
  }
  return input;
}

envCommand
  .command("create <name>")
  .description("create a global named environment with the foundational packages")
  .option("-t, --target <target>", "codex, claude, both, or a comma-separated list", "both")
  .action(async (name: string, options: { target: string }, command: Command) => {
    const project = projectRoot(command);
    const environment = await createEnvironment(project, name, targets(options.target));
    const lock = await readEnvironmentLock(project, name);
    console.log(`Created global environment ${name}`);
    console.log(`  recipe  ${environmentPath(project, name)}`);
    console.log(`  lock    ${environmentLockPath(project, name)}`);
    console.log(`  foundational ${FOUNDATIONAL_PACKAGES.map((packageName) => `${packageName}@${lock.packages[packageName]?.version}`).join(", ")}`);
    console.log(`  targets ${environment.spec.targets.join(", ")}`);
  });

const migrateCommand = program.command("migrate").description("explicitly migrate existing Agent configuration into an Environment");

migrateCommand
  .command("skills")
  .description("snapshot existing Codex or Claude Skills and install them as one Package")
  .option("--from <agent>", "codex, claude, or both", "both")
  .option("-n, --name <environment>", "destination environment; defaults to the active environment, then base")
  .option("--dry-run", "validate and print the migration plan without changing files", false)
  .action(async (options: { from: string; name?: string; dryRun: boolean }, command: Command) => {
    const environmentName = selectedEnvironment(options.name);
    const result = await migrateExistingSkills({
      projectRoot: projectRoot(command),
      environment: environmentName,
      from: migrationSource(options.from),
      dryRun: options.dryRun,
    });
    if (result.dryRun) console.log(`Skill migration plan for Environment ${environmentName}`);
    else if (result.unchanged) console.log(`No changes. Environment ${environmentName} already contains this migrated Skill snapshot.`);
    else console.log(`Migrated existing Agent Skills into ${environmentName}`);
    console.log(`  package   ${result.packageName}@${result.version}`);
    for (const skill of result.skills) console.log(`  ${skill.sources.length > 1 ? "dedupe" : "add"}     ${skill.name}  ${skill.sources.join(", ")}`);
    for (const skill of result.normalized) console.log(`  normalize ${skill}  legacy description frontmatter`);
    if (result.dryRun) console.log("No changes made.");
  });

migrateCommand
  .command("sessions")
  .description("copy existing Codex or Claude session state into an Environment-owned Agent home")
  .option("--from <agent>", "codex, claude, or both", "both")
  .option("-n, --name <environment>", "destination environment; defaults to the active environment, then base")
  .option("--dry-run", "validate and print the migration plan without changing files", false)
  .action(async (options: { from: string; name?: string; dryRun: boolean }, command: Command) => {
    const environmentName = selectedEnvironment(options.name);
    const result = await migrateExistingSessions({
      projectRoot: projectRoot(command),
      environment: environmentName,
      from: migrationSource(options.from),
      dryRun: options.dryRun,
    });
    if (result.dryRun) console.log(`Session migration plan for Environment ${environmentName}`);
    else if (result.unchanged) console.log(`No changes. Environment ${environmentName} already contains this session state.`);
    else console.log(`Migrated existing Agent sessions into ${environmentName}`);
    for (const entry of result.entries) {
      console.log(`  ${entry.platform.padEnd(6)} ${entry.name}  ${entry.files} files, ${entry.bytes} bytes`);
    }
    if (result.dryRun) console.log("No changes made.");
  });

envCommand
  .command("list")
  .alias("ls")
  .description("list named environments")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const names = await listEnvironments(project);
    const active = selectedEnvironment();
    for (const name of names) console.log(`${active === name ? "*" : " "} ${name}`);
  });

envCommand
  .command("show <name>")
  .description("show an environment recipe and resolved package closure")
  .action(async (name: string, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const [{ environment, lock }, active] = await Promise.all([environmentSnapshot(project, name), selectedEnvironment()]);
    console.log(`Environment: ${name}${active === name ? " (active)" : ""}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${Object.values(lock.packages).map((pkg) => `${pkg.name}@${pkg.version}`).join(", ") || "none"}`);
  });

envCommand
  .command("remove <name>")
  .description("remove an inactive environment recipe and lock")
  .action(async (name: string, _options: unknown, command: Command) => {
    await removeEnvironment(projectRoot(command), name);
    console.log(`Removed environment ${name}`);
  });

envCommand
  .command("export")
  .description("export a portable Environment bundle with its complete Package closure")
  .requiredOption("-n, --name <environment>", "environment to export")
  .requiredOption("-o, --output <file>", "destination .harness-env file")
  .action(async (options: { name: string; output: string }, command: Command) => {
    const result = await exportEnvironmentBundle(projectRoot(command), options.name, options.output);
    console.log(`Exported environment ${result.environment} to ${result.path}`);
    console.log(`  packages  ${result.packages}`);
    console.log(`  bytes     ${result.bytes}`);
  });

envCommand
  .command("import <bundle>")
  .description("atomically import a portable Environment bundle")
  .option("--name <environment>", "destination environment name; defaults to the exported name")
  .action(async (bundle: string, options: { name?: string }, command: Command) => {
    const result = await importEnvironmentBundle(projectRoot(command), bundle, options.name);
    console.log(`Imported environment ${result.snapshot.environment.metadata.name} from ${result.path}`);
    console.log(`  targets   ${result.snapshot.environment.spec.targets.join(", ")}`);
    console.log(`  packages  ${result.packages}`);
  });

program
  .command("install <source>")
  .description("install a package and its dependencies into an environment")
  .option("-n, --name <environment>", "destination environment; defaults to the active environment, then base")
  .action(async (source: string, options: { name?: string }, command: Command) => {
    const project = projectRoot(command);
    const environmentName = selectedEnvironment(options.name);
    const result = await installIntoEnvironment(project, environmentName, source, process.cwd());
    console.log(`Installed ${result.root.lock.name}@${result.root.lock.version} into ${environmentName}`);
    console.log(`  source        ${result.root.lock.source}`);
    if (result.packages.length > 1) {
      console.log(`  dependencies  ${result.packages.slice(0, -1).map((pkg) => `${pkg.lock.name}@${pkg.lock.version}`).join(", ")}`);
    }
  });

program
  .command("activate [environment]")
  .description("atomically activate or switch one complete environment; defaults to base")
  .action(async (name: string | undefined, _options: unknown, command: Command) => {
    const environmentName = name ?? DEFAULT_ENVIRONMENT;
    const result = await activateEnvironment(projectRoot(command), environmentName);
    printActions(result.actions);
    console.log(`Activated environment ${environmentName}`);
    console.log(`  targets   ${result.targets.join(", ")}`);
    console.log(`  packages  ${result.packages.join(", ") || "none"}`);
  });

program
  .command("deactivate")
  .description("leave the selected environment and return to base")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    const previous = selectedEnvironment();
    const result = await deactivateEnvironment(project);
    printActions(result.actions);
    console.log(`Deactivated environment ${previous ?? DEFAULT_ENVIRONMENT}; using ${DEFAULT_ENVIRONMENT}`);
  });

program
  .command("info")
  .description("show Environment information and machine-readable Agent context")
  .option("--json", "print structured Environment, package, Skill, and Memory context", false)
  .action(async (options: { json: boolean }, command: Command) => {
    const project = projectRoot(command);
    if (options.json) {
      console.log(JSON.stringify(await environmentInfo(project), null, 2));
      return;
    }
    const activeName = selectedEnvironment();
    const { environment, lock } = await environmentSnapshot(project, activeName);
    console.log(`Environment: ${activeName}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${Object.keys(lock.packages).join(", ") || "none"}`);
  });

const shellCommand = program.command("shell").description("print shell integration for Environment selection and the prompt");

shellCommand
  .command("hook [shell]")
  .description("print a bash or zsh hook for eval")
  .action(async (shell: string | undefined, _options: unknown, command: Command) => {
    await ensureBaseEnvironment(projectRoot(command));
    process.stdout.write(renderShellHook(resolveShell(shell)));
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
  .description("verify environment recipes, locks, views, requirements, activation, and Memory discovery")
  .option("-n, --name <environment>", "environment to check")
  .action(async (options: { name?: string }, command: Command) => {
    const project = projectRoot(command);
    const names = options.name ? [options.name] : [selectedEnvironment()];
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
