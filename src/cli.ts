#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { activatePackage, deactivatePackage } from "./activation.js";
import { captureHarness } from "./capture.js";
import { doctorPackage, type Check } from "./doctor.js";
import { installPackageSource, loadCachedPackage } from "./package.js";
import { scaffoldHarness } from "./scaffold.js";
import { readLock, putLock, readState } from "./store.js";
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

program
  .name("harness")
  .description("Reproducible, cross-agent environments for skills, MCP servers, and hooks")
  .version("0.1.0")
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
  .action(async (source: string, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const pkg = await installPackageSource(source, process.cwd());
    await putLock(project, pkg.lock);
    console.log(`Installed ${pkg.manifest.metadata.name}@${pkg.manifest.metadata.version}`);
    console.log(`  source     ${pkg.lock.source}`);
    console.log(`  integrity  ${pkg.lock.integrity}`);
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
      if (!active) {
        console.log(`  ${name}@${pkg.version}`);
        continue;
      }
      const mismatch = active.packageVersion === pkg.version ? "" : `  [locked: ${pkg.version}]`;
      console.log(`* ${name}@${active.packageVersion}  active: ${active.targets.join(",")}${mismatch}`);
    }
  });

program
  .command("doctor [name]")
  .description("verify dependencies, credentials, cache integrity, and active skills")
  .action(async (name: string | undefined, _options: unknown, command: Command) => {
    const project = projectRoot(command);
    const lock = await readLock(project);
    const names = name ? [resolveName(lock, name)] : Object.keys(lock.packages).sort();
    if (names.length === 0) throw new Error("No harnesses installed in this project");
    let failed = false;
    for (const selected of names) {
      const pkg = await loadCachedPackage(lock.packages[selected]!);
      console.log(`${selected}@${pkg.manifest.metadata.version}`);
      const checks = await doctorPackage(pkg, project);
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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
