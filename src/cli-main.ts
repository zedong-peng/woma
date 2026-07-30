#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { requireAgentMigrationConfirmation } from "./agent-processes.js";
import { detectAgentClis } from "./agent-cli.js";
import {
  initializeBootstrap,
  removeInitializedEnvironment,
  renameInitializedEnvironment,
} from "./bootstrap.js";
import { captureWoma } from "./capture.js";
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
  installIntoEnvironment,
  listEnvironments,
  readEnvironmentLock,
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
import { runInEnvironment } from "./run.js";
import type { Action, LockedPackage, Platform } from "./types.js";

const EXISTING_AGENT_STATE_NOTICE = `Woma created a clean, isolated base Environment.

Existing Codex or Claude data remains unchanged in the original Agent homes.
Nothing was imported into base.

Run woma init to automatically create a codex Environment from supported existing
Codex configuration, Hooks, and ordinary Skills. Authentication, system Skills,
Plugins, sessions, history, caches, and Claude state are not imported automatically.

Use woma migrate for any later or manual imports.
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
  return process.env.WOMA_ENV || DEFAULT_ENVIRONMENT;
}

function targets(input: string): Platform[] {
  const values = input === "both"
    ? ["codex", "claude"]
    : input === "all"
      ? ["codex", "claude", "pi", "qoder"]
      : input.split(",");
  const result: Platform[] = [];
  for (const item of values) {
    const value = item.trim();
    if (value !== "codex" && value !== "claude" && value !== "pi" && value !== "qoder") throw new Error(`Unknown target: ${value}`);
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
  .name("woma")
  .description("Create, reproduce, and switch isolated Agent environments")
  .version("0.6.1")
  .enablePositionalOptions()
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => (cmd.aliases().length > 0 ? `${cmd.name()} (${cmd.aliases().join(", ")})` : cmd.name()),
  })
  .option("-p, --project <directory>", "project root; defaults to the current directory");

program
  .command("init [shell]")
  .description("initialize Woma for shell interaction")
  .option("--dry-run", "print the initialization plan without changing files", false)
  .option("--reverse", "undo shell initialization", false)
  .action(async (shell: string | undefined, options: { dryRun: boolean; reverse: boolean }, command: Command) => {
    const resolved = resolveShell(shell);
    if (!options.reverse && !options.dryRun) await initializeShell(resolved, { ...options, dryRun: true });
    const bootstrap = options.reverse
      ? undefined
      : await initializeBootstrap(projectRoot(command), options.dryRun);
    const result = await initializeShell(resolved, options);
    printActions([...(bootstrap?.actions ?? []), ...result.actions]);
    if (options.dryRun) {
      console.log("No changes made.");
      return;
    }
    if (options.reverse) console.log(`Reversed ${resolved} shell initialization`);
    else {
      console.log(`Initialized ${resolved} shell integration`);
      if (bootstrap) {
        console.log(`Default Environment: ${bootstrap.defaultEnvironment}`);
        if (bootstrap.importedSkills.length > 0) {
          const suffix = bootstrap.importedSkills.length === 1 ? "" : "s";
          console.log(`Imported ${bootstrap.importedSkills.length} existing Codex Skill${suffix}`);
        }
      }
      console.log(`Restart your shell or reload ${result.profilePath}`);
    }
  });

const skeletonCommand = program.command("skeleton").description("generate an editable Woma Package recipe");

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

interface CreateOptions {
  name: string;
  target?: string;
  file?: string;
}

async function createCommand(options: CreateOptions, command: Command): Promise<void> {
  const project = projectRoot(command);
  if (options.file) {
    if (options.target) throw new Error("--target cannot be combined with --file");
    const result = await importEnvironmentBundle(project, options.file, options.name);
    console.log(`Created environment ${result.snapshot.environment.metadata.name} from ${result.path}`);
    console.log(`  targets   ${result.snapshot.environment.spec.targets.join(", ")}`);
    console.log(`  packages  ${result.packages}`);
    return;
  }
  await ensureSelectedBase(project, options.name);
  const environment = await createEnvironment(project, options.name, targets(options.target ?? "both"));
  console.log(`Created global environment ${options.name}`);
  console.log(`  recipe  ${environmentPath(project, options.name)}`);
  console.log(`  lock    ${environmentLockPath(project, options.name)}`);
  console.log(`  targets ${environment.spec.targets.join(", ")}`);
}

program
  .command("create")
  .description("create a new Agent environment")
  .requiredOption("-n, --name <environment>", "environment name")
  .option("-t, --target <target>", "codex, claude, pi, qoder, both, all, or a comma-separated list")
  .option("-f, --file <bundle>", "create from a portable .woma-env bundle")
  .action(createCommand);

function migrationSource(input: string): SkillMigrationSource {
  if (input !== "codex" && input !== "claude" && input !== "both") {
    throw new Error("--from must be codex, claude, or both");
  }
  return input;
}

envCommand
  .command("create <name>")
  .description("create a global named environment")
  .option("-t, --target <target>", "codex, claude, pi, qoder, both, all, or a comma-separated list", "both")
  .action(async (name: string, options: { target: string }, command: Command) => {
    await createCommand({ name, target: options.target }, command);
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
      console.log(`    ${skill.name}  external  ${skill.platforms.join(", ")}`);
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
    await removeInitializedEnvironment(projectRoot(command), name);
    console.log(`Removed environment ${name}`);
  });

envCommand
  .command("export")
  .description("export a portable Environment bundle with its complete Package closure")
  .requiredOption("-n, --name <environment>", "environment to export")
  .requiredOption("-o, --output <file>", "destination .woma-env file")
  .action(async (options: { name: string; output: string }, command: Command) => {
    const project = projectRoot(command);
    await ensureSelectedBase(project, options.name);
    const result = await exportEnvironmentBundle(project, options.name, options.output);
    console.log(`Exported environment ${result.environment} to ${result.path}`);
    console.log(`  packages  ${result.packages}`);
    console.log(`  bytes     ${result.bytes}`);
  });

program
  .command("export")
  .description("export a portable Environment bundle with its complete Package closure")
  .option("-n, --name <environment>", "environment to export; defaults to the active environment, then base")
  .requiredOption("-f, --file <file>", "destination .woma-env file")
  .action(async (options: { name?: string; file: string }, command: Command) => {
    const project = projectRoot(command);
    const name = selectedEnvironment(options.name);
    await ensureSelectedBase(project, name);
    const result = await exportEnvironmentBundle(project, name, options.file);
    console.log(`Exported environment ${result.environment} to ${result.path}`);
    console.log(`  packages  ${result.packages}`);
    console.log(`  bytes     ${result.bytes}`);
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
  .command("remove <package>")
  .alias("uninstall")
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
        ? `Removal plan for ${packageName} from ${environmentName}`
        : `Removed ${packageName} from ${environmentName}`,
    );
    console.log(`  ${options.dryRun ? "remove" : "removed"} root       ${result.root.lock.name}`);
    console.log(`  ${options.dryRun ? "prune" : "pruned"} packages    ${result.packages.map((pkg) => pkg.lock.name).join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} Skills     ${result.skills.join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} MCP servers ${result.mcpServers.join(", ") || "none"}`);
    console.log(`  ${options.dryRun ? "remove" : "removed"} Hooks      ${result.hooks.join(", ") || "none"}`);
    if (options.dryRun) console.log("No changes made.");
  });

program
  .command("rename <destination>")
  .description("rename an existing Agent environment")
  .requiredOption("-n, --name <environment>", "environment to rename")
  .action(async (destination: string, options: { name: string }, command: Command) => {
    await renameInitializedEnvironment(projectRoot(command), options.name, destination);
    console.log(`Renamed environment ${options.name} to ${destination}`);
  });

program
  .command("run <executable> [args...]")
  .description("run a command in an Agent environment")
  .option("-n, --name <environment>", "environment to use; defaults to the active environment, then base")
  .option("--cwd <directory>", "working directory for the command")
  .passThroughOptions()
  .action(async (executable: string, args: string[], options: { name?: string; cwd?: string }, command: Command) => {
    const project = projectRoot(command);
    const name = selectedEnvironment(options.name);
    await ensureSelectedBase(project, name);
    process.exitCode = await runInEnvironment({
      projectRoot: project,
      environment: name,
      executable,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
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
  .description("leave the selected Woma environment and restore the original Agent homes")
  .action(() => {
    const previous = selectedEnvironment();
    console.log(`Deactivated environment ${previous}`);
  });

program
  .command("info")
  .description("show Environment and Agent CLI information")
  .option("--json", "print structured Environment, package, and Skill state", false)
  .action(async (options: { json: boolean }, command: Command) => {
    const project = projectRoot(command);
    const activeName = selectedEnvironment();
    await ensureSelectedBase(project, activeName);
    if (options.json) {
      console.log(JSON.stringify(await environmentInfo(project), null, 2));
      return;
    }
    const [{ environment, lock }, agents] = await Promise.all([
      environmentSnapshot(project, activeName),
      detectAgentClis(),
    ]);
    console.log(`Environment: ${activeName}`);
    console.log(`  targets   ${environment.spec.targets.join(", ")}`);
    console.log(`  roots     ${environment.spec.roots.map((root) => root.name).join(", ") || "none"}`);
    console.log(`  packages  ${Object.keys(lock.packages).join(", ") || "none"}`);
    console.log("  Agent CLIs");
    for (const [agent, status] of Object.entries(agents)) {
      console.log(`    ${agent.padEnd(7)} ${status.available ? status.path : `${status.command} not found on PATH`}`);
    }
  });

program
  .command("doctor")
  .description("verify environment recipes, locks, views, requirements, and activation")
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
  .description("capture one Agent's Skills, MCP servers, and hooks as a Woma package")
  .requiredOption("--from <platform>", "codex or claude")
  .option("--name <name>", "package name")
  .action(async (directory: string, options: { from: string; name?: string }, command: Command) => {
    if (options.from !== "codex" && options.from !== "claude") throw new Error("--from must be codex or claude");
    const result = await captureWoma({
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

program.configureOutput({ outputError: (message, write) => write(`woma: ${message}`) });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`woma: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
