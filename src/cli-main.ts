#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { createEnvironment, doctorEnvironment, exportEnvironment, installPackages, listEnvironments, readEnvironment, removeEnvironment, removePackages, selectPrefix, updatePackages, type Target } from "./environment.js";
import { writeTextAtomic } from "./fs.js";
import { runInEnvironment } from "./run.js";
import { originalEnvironment, renderSelection, selectedEnvironment } from "./selection.js";
import { initializeShell } from "./shell-init.js";
import { renderShellHook, resolveShell } from "./shell.js";
import { gitIntent, gitLocator } from "./source.js";
import type { Harness } from "./types.js";

const program = new Command().name("woma").description("Manage isolated, versioned harness environments").enablePositionalOptions();
const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
program.version(metadata.version);
function target(command: Command): Command { return command.option("-n, --name <name>", "Environment name").option("-p, --prefix <path>", "Environment prefix"); }
function harnessSpec(spec: string): { harness: Harness; version?: string } {
  const match = /^(codex|claude)(?:@(.+))?$/.exec(spec);
  if (!match) throw new Error("Select codex or claude, optionally followed by @version");
  return { harness: match[1] as Harness, ...(match[2] ? { version: match[2] } : {}) };
}
function activationTarget(environment: string | undefined, options: Target): Target {
  if (environment && (options.name || options.prefix)) throw new Error("Specify the environment once");
  return environment ? environment.includes(path.sep) || environment.startsWith(".") ? { prefix: environment } : { name: environment } : options;
}

program.command("init [shell]").option("--reverse").option("--dry-run").action(async (shell: string | undefined, options: { reverse?: boolean; dryRun?: boolean }) => {
  const result = await initializeShell(resolveShell(shell), options);
  console.log(`${options.reverse ? "Reversed" : "Initialized"} ${result.shell} shell ${options.reverse ? "initialization" : "integration"}${options.dryRun ? " (dry run)" : ""}.`);
  for (const action of result.actions) console.log(`${action.verb} ${action.path}`);
});
target(program.command("create [harness]")).option("-f, --file <path>", "Environment recipe or explicit lock").action(async (spec: string | undefined, options: Target & { file?: string }) => {
  const prefix = await createEnvironment(options, { ...(spec ? harnessSpec(spec) : {}), ...(options.file ? { file: options.file } : {}) });
  console.log(`Created environment: ${prefix}`);
});
target(program.command("activate [environment]")).action(() => { throw new Error("Shell integration is required. Run woma init and open a new shell, or use woma run."); });
program.command("deactivate").action(() => { throw new Error("Shell integration is required. Run woma init and open a new shell."); });

target(program.command("install <sources...>")).option("--subdir <path>", "Select a Git subdirectory (one source)").option("--commit <sha>", "Select an exact Git commit (one source)").action(async (sources: string[], options: Target & { subdir?: string; commit?: string }) => {
  if (options.subdir || options.commit) {
    if (sources.length !== 1) throw new Error("--subdir and --commit require exactly one Git source");
    const git = gitLocator(sources[0]!);
    if (!git) throw new Error("--subdir and --commit require a Git source");
    if (options.commit && !/^[a-f0-9]{40,64}$/.test(options.commit)) throw new Error("--commit requires a full commit SHA");
    if (options.commit && git.ref && options.commit !== git.ref) throw new Error("Conflicting Git refs");
    sources = [gitIntent({ ...git, ...(options.subdir ? { subdirectory: options.subdir } : {}), ...(options.commit ? { ref: options.commit } : {}) })];
  }
  const prefix = await selectPrefix(options);
  if (sources.length === 1 && /^(codex|claude)(?:@.+)?$/.test(sources[0]!)) await updatePackages(prefix, sources);
  else await installPackages(prefix, sources);
  console.log(`Installed into ${prefix}. Start a new harness process. New plugins are disabled until enabled in the native tool.`);
});
target(program.command("update [packages...]")).action(async (names: string[], options: Target) => {
  const prefix = await selectPrefix(options); await updatePackages(prefix, names); console.log(`Updated ${prefix}. Start a new harness process.`);
});
target(program.command("remove <packages...>")).action(async (names: string[], options: Target) => {
  const prefix = await selectPrefix(options); await removePackages(prefix, names); console.log(`Removed packages from ${prefix}.`);
});
target(program.command("list")).option("--json").action(async (options: Target & { json?: boolean }) => {
  const state = await readEnvironment(await selectPrefix(options));
  const records = Object.values(state.lock.packages);
  if (options.json) console.log(JSON.stringify(records, null, 2));
  else for (const record of records) console.log(`${record.name.padEnd(28)} ${record.version.padEnd(18)} ${record.kind}`);
});
target(program.command("doctor")).action(async (options: Target) => {
  const issues = await doctorEnvironment(await selectPrefix(options));
  for (const issue of issues) console.log(`ERROR ${issue}`);
  if (issues.length) process.exitCode = 1; else console.log("Managed environment is consistent.");
});
target(program.command("export")).option("--explicit", "Export exact versions, sources and content digests").option("-f, --file <path>").action(async (options: Target & { explicit?: boolean; file?: string }) => {
  const output = await exportEnvironment(await selectPrefix(options), options.explicit);
  if (options.file) await writeTextAtomic(path.resolve(options.file), output); else process.stdout.write(output);
});
target(program.command("run <executable> [args...]")).passThroughOptions().action(async (executable: string, args: string[], options: Target) => {
  const result = await runInEnvironment(await selectPrefix(options), executable, args);
  if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code ?? 1;
});

const env = program.command("env");
env.command("list").option("--json").action(async (options: { json?: boolean }) => {
  const environments = await listEnvironments();
  if (options.json) console.log(JSON.stringify(environments, null, 2));
  else for (const item of environments) console.log(`${item.name.padEnd(24)} ${item.format.padEnd(8)} ${item.prefix}`);
});
target(env.command("remove")).option("-y, --yes", "Confirm deletion of the entire environment, including local native state").action(async (options: Target & { yes?: boolean }) => {
  const prefix = await selectPrefix(options);
  await readEnvironment(prefix);
  console.log(`Delete environment ${prefix}\nThis permanently deletes its credentials, sessions, caches, Memory, native installations, configuration, and all other local state. Exports cannot restore that state.`);
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error("Environment deletion requires --yes in a non-interactive shell");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { if (!/^y(?:es)?$/i.test((await prompt.question("Delete this environment? [y/N] ")).trim())) return; }
    finally { prompt.close(); }
  }
  await removeEnvironment(prefix); console.log(`Removed ${prefix}`);
});

const shell = program.command("shell").description("Shell integration internals");
shell.command("hook [shell]").action((value?: string) => { process.stdout.write(renderShellHook(resolveShell(value))); });
target(shell.command("activate [environment]")).action(async (environment: string | undefined, options: Target) => {
  const prefix = await selectPrefix(activationTarget(environment, options));
  const state = await readEnvironment(prefix);
  await access(path.join(prefix, "bin", state.lock.recipe.harness), constants.X_OK);
  process.stdout.write(renderSelection(selectedEnvironment(prefix, state)));
});
shell.command("deactivate").action(() => { process.stdout.write(renderSelection(originalEnvironment(process.env))); });

try { await program.parseAsync(process.argv); }
catch (error) { console.error(`woma: ${(error as Error).message}`); process.exitCode = 1; }
