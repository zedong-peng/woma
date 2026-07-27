#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { requireAgentMigrationConfirmation } from "./agent-processes.js";
import { captureHarness } from "./capture.js";
import { exportEnvironmentBundle, importEnvironmentBundle } from "./environment-bundle.js";
import {
  activateEnvironment,
  createEnvironment,
  environmentInfo,
  environmentSnapshot,
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
  uninstallFromEnvironment,
  type BaseEnvironmentInitializationOptions,
  type EnvironmentCheck,
} from "./environment.js";
import { inspectEnvironmentLocalSkills } from "./environment-skills.js";
import { installPackageSource, loadCachedPackage } from "./package.js";
import { resolveShell } from "./shell.js";
import { initializeShell } from "./shell-init.js";
import { createWorkflowSkeleton } from "./skeleton.js";
import { migrateExistingSkills, type SkillMigrationSource } from "./migrate-skills.js";
import { migrateExistingSessions } from "./migrate-sessions.js";
import type { Action, LockedPackage, Platform } from "./types.js";

const EXISTING_AGENT_STATE_NOTICE = `Harness created an isolated base Environment.

Existing Codex or Claude data remains unchanged in the original Agent homes.
Supported configuration and credentials are seeded separately where supported.
Existing Agent Skills, sessions, and history were detected but were not imported.

Preview migration:
  harness migrate skills --dry-run
  harness migrate sessions --dry-run

Import Skills into base:
  harness migrate skills

After stopping all Codex and Claude processes, import sessions:
  harness migrate sessions
`;

const baseInitializationOptions: BaseEnvironmentInitializationOptions = {
  onExistingAgentStateDetected: () => process.stderr.write(`${EXISTING_AGENT_STATE_NOTICE}\n`),
};

const program = new Command();

function projectRoot(command: Command): string {
  const configured = command.optsWithGlobals<{ project?: string }>().project;
  return path.resolve(configured ?? process.cwd());
}

async function ensureSelectedBase(project: string, name: string): Promise<void> {
  if (name === DEFAULT_ENVIRONMENT) await ensureBaseEnvironment(project, baseInitializationOptions);
}

function selectedEnvironment(requested?: string): string {
  if (requested) return requested;
  return process.env.HARNESS_ENV || DEFAULT_ENVIRONMENT;
}

function targets(input: string): Platform[] {
  const values = input === "both"
    ? ["codex", "claude"]
    : input === "all"
      ? ["codex", "claude", "pi"]
      : input.split(",");
  const result: Platform[] = [];
  for (const item of values) {
    const value = item.trim();
    if (value !== "codex" && value !== "claude" && value !== "pi") throw new Error(`Unknown target: ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  if (result.length === 0) throw new Error("Select at least one target");
  return result;
}

function visibleTargets(environmentTargets: Platform[], packagePlatforms: Platform[], resourcePlatforms?: Platform[]): Platform[] {
  const supported = new Set(resourcePlatforms ?? packagePlatforms);
  return environmentTargets.filter((target) => supported.has(target));
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

function packageSourceOptions(options: { commit?: string; subdir?: string }) {
  return {
    ...(options.commit ? { commit: options.commit } : {}),
    ...(options.subdir ? { subdirectory: options.subdir } : {}),
  };
}

function printPackageProvenance(lock: LockedPackage, indent = "  "): void {
  console.log(`${indent}source        ${lock.source}`);
  if (lock.subdirectory) console.log(`${indent}subdir        ${lock.subdirectory}`);
  if (lock.commit) console.log(`${indent}commit        ${lock.commit}`);
  console.log(`${indent}integrity     ${lock.integrity}`);
}

program
  .name("harness")
  .description("Create, reproduce, and switch isolated Agent environments")
  .version("0.6.0")
  .enablePositionalOptions()
  .configureHelp({ sortSubcommands: true })
  .option("-p, --project <directory>", "project whose Memory is managed; defaults to the current directory");

program
  .command("init [shell]")
  .description("initialize Harness for shell interaction")
  .option("--dry-run", "print the initialization plan without changing files", false)
  .option("--reverse", "undo shell initialization", false)
  .action(async (shell: string | undefined, options: { dryRun: boolean; reverse: boolean }) => {
    const resolved = resolveShell(shell);
    const result = await initializeShell(resolved, options);
    printActions(result.actions);
    if (options.dryRun) {
      console.log("No changes made.");
      return;
    }
    if (options.reverse) console.log(`Reversed ${resolved} shell initialization`);
    else {
      console.log(`Initialized ${resolved} shell integration`);
      console.log(`Restart your shell or reload ${result.profilePath}`);
    }
  });

const skeletonCommand = program.command("skeleton").description("generate an editable Harness Package recipe");

skeletonCommand
  .command("workflow <name>")
  .description("generate a Package with a coordinating workflow Skill")
  .option("-o, --output-dir <directory>", "directory in which to create the Package", ".")
  .option("--version <version>", "initial Package version", "0.1.0")
  .action(async (name: string, options: { outputDir: string; version: string }) => {
    const result = await createWorkflowSkeleton(name, {
      outputDirectory: options.outputDir,
      version: options.version,
    });
    console.log(`Created workflow skeleton ${result.name}@${result.version}`);
    console.log(`  recipe  ${result.root}`);
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
  .option("-t, --target <target>", "codex, claude, pi, both, all, or a comma-separated list", "both")
  .action(async (name: string, options: { target: string }, command: Command) => {
    const project = projectRoot(command);
    await ensureSelectedBase(project, name);
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
    const from = migrationSource(options.from);
    await requireAgentMigrationConfirmation();
    const environmentName = selectedEnvironment(options.name);
    const project = projectRoot(command);
    if (!options.dryRun) await ensureSelectedBase(project, environmentName);
    const result = await migrateExistingSkills({
      projectRoot: project,
      environment: environmentName,
      from,
      dryRun: options.dryRun,
    });
    if (result.dryRun) console.log(`Skill migration plan for Environment ${environmentName}`);
    else if (result.unchanged) console.log(`No changes. Environment ${environmentName} already contains these migrated Skills.`);
    else console.log(`Migrated existing Agent Skills into ${environmentName}`);
    for (const pkg of result.packages) {
      const action = pkg.sources.length > 1 ? "dedupe" : pkg.unchanged ? "keep" : "add";
      console.log(`  ${action.padEnd(8)} ${pkg.name}@${pkg.version}  ${pkg.sources.join(", ")}`);
    }
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
    const from = migrationSource(options.from);
    await requireAgentMigrationConfirmation();
    const environmentName = selectedEnvironment(options.name);
    const project = projectRoot(command);
    await ensureSelectedBase(project, environmentName);
    const result = await migrateExistingSessions({
      projectRoot: project,
      environment: environmentName,
      from,
      dryRun: options.dryRun,
    });
    if (result.dryRun) console.log(`Session migration plan for Environment ${environmentName}`);
    else if (result.unchanged) console.log(`No changes. Environment ${environmentName} already contains this session state.`);
    else console.log(`Migrated existing Agent sessions into ${environmentName}`);
    for (const entry of result.entries) {
      const records = entry.recordsAdded === undefined
        ? ""
        : `, ${entry.recordsAdded} records added, ${entry.recordsDeduplicated} records deduplicated`;
      console.log(`  ${entry.platform.padEnd(6)} ${entry.name}  ${entry.files} files, ${entry.bytes} bytes${records}`);
    }
    if (result.dryRun) console.log("No changes made.");
  });

envCommand
  .command("list")
  .alias("ls")
  .description("list named environments")
  .action(async (_options: unknown, command: Command) => {
    const project = projectRoot(command);
    await ensureBaseEnvironment(project, baseInitializationOptions);
    const names = await listEnvironments(project);
    const active = selectedEnvironment();
    for (const name of names) console.log(`${active === name ? "*" : " "} ${name}`);
  });

program
  .command("list")
  .description("list packages and installed resources in an environment")
  .option("-n, --name <environment>", "environment to list; defaults to the active environment, then base")
  .action(async (options: { name?: string }, command: Command) => {
    const project = projectRoot(command);
    const name = selectedEnvironment(options.name);
    await ensureSelectedBase(project, name);
    const [{ environment, lock }, active] = await Promise.all([environmentSnapshot(project, name), selectedEnvironment()]);
    const lockedPackages = Object.values(lock.packages);
    const packages = await Promise.all(lockedPackages.map(async (locked) => {
      try {
        return { status: "ok" as const, locked, pkg: await loadCachedPackage(locked) };
      } catch (error) {
        return { status: "error" as const, locked, error: error as Error };
      }
    }));
    const available = packages.filter((loaded) => loaded.status === "ok");
    const unavailable = packages.filter((loaded) => loaded.status === "error");
    const managedSkillNames = new Set<string>();
    for (const loaded of available) {
      for (const skill of loaded.pkg.manifest.spec.skills) managedSkillNames.add(skill.name);
    }
    const localSkills = await inspectEnvironmentLocalSkills(environment, managedSkillNames);
    console.log(`Environment: ${name}${active === name ? " (active)" : ""}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${lockedPackages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ") || "none"}`);
    for (const locked of lockedPackages) {
      console.log(`    ${locked.name}@${locked.version}`);
      printPackageProvenance(locked, "      ");
    }
    console.log("  skills");
    let resourceCount = 0;
    for (const loaded of available) {
      const platforms = visibleTargets(
        environment.spec.targets,
        loaded.pkg.manifest.spec.platforms,
      );
      for (const skill of loaded.pkg.manifest.spec.skills) {
        console.log(`    ${skill.name}  ${loaded.locked.name}@${loaded.locked.version}  ${platforms.join(", ") || "none"}`);
        resourceCount += 1;
      }
    }
    for (const skill of localSkills.skills) {
      console.log(`    ${skill.name}  external  codex`);
      resourceCount += 1;
    }
    if (resourceCount === 0) console.log("    none");
    if (localSkills.issues.length > 0) {
      console.log("  Environment-local Skill warnings");
      for (const issue of localSkills.issues) console.log(`    ${issue.entry}  ${issue.detail}`);
    }

    console.log("  mcp servers");
    resourceCount = 0;
    for (const loaded of available) {
      for (const server of loaded.pkg.manifest.spec.mcpServers) {
        const platforms = visibleTargets(
          environment.spec.targets,
          loaded.pkg.manifest.spec.platforms,
          server.platforms,
        );
        console.log(`    ${server.name}  ${server.transport}  ${loaded.locked.name}@${loaded.locked.version}  ${platforms.join(", ") || "none"}`);
        resourceCount += 1;
      }
    }
    if (resourceCount === 0) console.log("    none");

    console.log("  hooks");
    resourceCount = 0;
    for (const loaded of available) {
      for (const hook of loaded.pkg.manifest.spec.hooks) {
        const platforms = visibleTargets(
          environment.spec.targets,
          loaded.pkg.manifest.spec.platforms,
          hook.platforms,
        );
        console.log(`    ${hook.event}  ${hook.matcher ?? "*"}  ${loaded.locked.name}@${loaded.locked.version}  ${platforms.join(", ") || "none"}`);
        resourceCount += 1;
      }
    }
    if (resourceCount === 0) console.log("    none");

    if (unavailable.length > 0) {
      console.log("  unavailable packages");
      for (const loaded of unavailable) {
        console.log(`    ${loaded.locked.name}@${loaded.locked.version}  ${loaded.error.message}`);
      }
    }
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
    const project = projectRoot(command);
    await ensureSelectedBase(project, options.name);
    const result = await exportEnvironmentBundle(project, options.name, options.output);
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
  .option("--commit <sha>", "full Git commit SHA; defaults to the latest default-branch commit")
  .option("--subdir <path>", "Package subdirectory within the Git repository")
  .action(async (source: string, options: { name?: string; commit?: string; subdir?: string }, command: Command) => {
    const project = projectRoot(command);
    const environmentName = selectedEnvironment(options.name);
    const result = await installIntoEnvironment(project, environmentName, source, process.cwd(), {
      sourceOptions: packageSourceOptions(options),
    });
    console.log(`Installed ${result.root.lock.name}@${result.root.lock.version} into ${environmentName}`);
    printPackageProvenance(result.root.lock);
    if (result.packages.length > 1) {
      console.log(`  dependencies  ${result.packages.slice(0, -1).map((pkg) => `${pkg.lock.name}@${pkg.lock.version}`).join(", ")}`);
    }
  });

program
  .command("uninstall <package>")
  .description("remove a root Package and dependencies no longer required by an environment")
  .option("-n, --name <environment>", "environment to update; defaults to the active environment, then base")
  .option("-d, --dry-run", "show the removal plan without changing files", false)
  .action(async (packageName: string, options: { name?: string; dryRun: boolean }, command: Command) => {
    const project = projectRoot(command);
    const environmentName = selectedEnvironment(options.name);
    if (!options.dryRun) await ensureSelectedBase(project, environmentName);
    const result = await uninstallFromEnvironment(project, environmentName, packageName, { dryRun: options.dryRun });
    console.log(
      options.dryRun
        ? `Uninstall plan for ${packageName} from ${environmentName}`
        : `Uninstalled ${packageName} from ${environmentName}`,
    );
    console.log(`  ${options.dryRun ? "remove" : "removed"} root       ${result.root.lock.name}`);
    console.log(`  ${options.dryRun ? "prune" : "pruned"} packages    ${result.packages.map((pkg) => pkg.lock.name).join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} Skills     ${result.skills.join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} MCP servers ${result.mcpServers.join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} Hooks      ${result.hooks.join(", ") || "none"}`);
    if (options.dryRun) console.log("No changes made.");
  });

program
  .command("activate [environment]")
  .description("atomically activate or switch one complete environment; defaults to base")
  .action(async (name: string | undefined, _options: unknown, command: Command) => {
    const environmentName = name ?? DEFAULT_ENVIRONMENT;
    const project = projectRoot(command);
    await ensureSelectedBase(project, environmentName);
    const result = await activateEnvironment(project, environmentName);
    printActions(result.actions);
    console.log(`Activated environment ${environmentName}`);
    console.log(`  targets   ${result.targets.join(", ")}`);
    console.log(`  packages  ${result.packages.join(", ") || "none"}`);
  });

program
  .command("deactivate")
  .description("leave the selected Harness environment and restore the original Agent homes")
  .action(() => {
    const previous = selectedEnvironment();
    console.log(`Deactivated environment ${previous}`);
  });

program
  .command("info")
  .description("show Environment information and machine-readable Agent context")
  .option("--json", "print structured Environment, package, Skill, and Memory context", false)
  .action(async (options: { json: boolean }, command: Command) => {
    const project = projectRoot(command);
    const activeName = selectedEnvironment();
    await ensureSelectedBase(project, activeName);
    if (options.json) {
      console.log(JSON.stringify(await environmentInfo(project), null, 2));
      return;
    }
    const { environment, lock } = await environmentSnapshot(project, activeName);
    console.log(`Environment: ${activeName}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${Object.keys(lock.packages).join(", ") || "none"}`);
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
      await ensureSelectedBase(project, name);
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
  .option("--commit <sha>", "full Git commit SHA; defaults to the latest default-branch commit")
  .option("--subdir <path>", "Package subdirectory within the Git repository")
  .action(async (sourceOrName: string, options: { name?: string; commit?: string; subdir?: string }, command: Command) => {
    let pkg;
    if (options.name) {
      const lock = await readEnvironmentLock(projectRoot(command), options.name);
      const locked = lock.packages[sourceOrName];
      if (!locked) throw new Error(`${sourceOrName} is not installed in environment ${options.name}`);
      pkg = await loadCachedPackage(locked);
    } else {
      pkg = await installPackageSource(sourceOrName, process.cwd(), packageSourceOptions(options));
    }
    const manifest = pkg.manifest;
    console.log(`${manifest.metadata.name}@${manifest.metadata.version}`);
    console.log(manifest.metadata.description);
    printPackageProvenance(pkg.lock);
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
