#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { describeAgents, findAgent, missingAgent } from "./agents.js";
import { addMcpServer, agentSpec, authStatus, createEnvironment, doctorEnvironment, exportEnvironment, installPackages, listEnvironments, packEnvironment, readEnvironment, removeEnvironment, removeMcpServers, removePackages, selectPrefix, updatePackages, type Target } from "./environment.js";
import { writeTextAtomic } from "./fs.js";
import { presentAgents } from "./native.js";
import { searchSkills } from "./registry.js";
import { runInEnvironment } from "./run.js";
import { formatIssues, mcpNameSchema, parseMcpServer } from "./schema.js";
import { originalEnvironment, renderSelection, selectedEnvironment } from "./selection.js";
import { initializeShell } from "./shell-init.js";
import { renderShellHook, resolveShell } from "./shell.js";
import { gitIntent, gitLocator } from "./source.js";
import type { Agent, EnvironmentState, McpServer, PackageRecord } from "./types.js";

const program = new Command().name("woma").description("Conda-like environments for AI coding agents: give your Claude Code and Codex named, isolated sets of Skills, plugins and MCP servers, and recreate them anywhere.").enablePositionalOptions();
const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
program.version(metadata.version);
function target(command: Command): Command { return command.option("-n, --name <name>", "Environment name").option("-p, --prefix <path>", "Environment directory"); }
const collect = (value: string, previous: string[] = []) => [...previous, value];
function activationTarget(environment: string | undefined, options: Target): Target {
  if (environment && (options.name || options.prefix)) throw new Error("Specify the environment once");
  return environment ? environment.includes(path.sep) || environment.startsWith(".") ? { prefix: environment } : { name: environment } : options;
}
function splitSpecs(specs: string[]): { agents: Agent[]; sources: string[] } {
  const agents: Agent[] = [];
  const sources: string[] = [];
  for (const spec of specs) {
    const agent = agentSpec(spec);
    if (!agent) sources.push(spec);
    else if (agents.includes(agent)) throw new Error(`${agent} is listed twice`);
    else agents.push(agent);
  }
  return { agents, sources };
}
/** Woma uses the installed agents; say so when one is missing instead of failing. */
async function warnMissingAgents(agents: readonly Agent[]) {
  for (const agent of agents) if (!(await findAgent(agent))) console.error(`Warning: ${missingAgent(agent)}`);
}
function sourceLabel(record: PackageRecord, intent?: string): string {
  if (record.source.type === "git") return `${intent ?? gitIntent({ url: record.source.url, subdirectory: record.source.subdirectory })} @ ${record.source.commit.slice(0, 7)}`;
  return `${record.source.path}${record.origin ? ` (= ${gitIntent({ url: record.origin.url, subdirectory: record.origin.subdirectory })} @ ${record.origin.commit.slice(0, 7)})` : " (local)"}`;
}
/** A short version: the declared version, else the Git commit or content digest. */
function versionLabel(record: PackageRecord): string {
  if (!record.version.startsWith("0.0.0+")) return record.version;
  return record.source.type === "git" ? record.source.commit.slice(0, 7) : `local ${record.integrity.slice(7, 14)}`;
}
function packageAgents(state: EnvironmentState, record: PackageRecord): string {
  if (record.plugin) return record.plugin.harness;
  return presentAgents(state.lock).filter((agent) => record.harnesses[agent] !== undefined).join(",");
}
async function printAuth(prefix: string, state: EnvironmentState) {
  for (const item of await authStatus(prefix, state.lock)) console.log(`  ${item.agent.padEnd(8)} ${item.detail}`);
}
function reportPortability(result: { converted: string[]; local: string[] }, pack = false) {
  if (result.converted.length) console.error(`Recorded as Git sources (pushed, unmodified commits): ${result.converted.join(", ")}`);
  if (result.local.length && !pack) console.error(`Local only, not portable: ${result.local.join(", ")}. Share them with woma export --pack FILE, or push them to Git and run woma update.`);
}

program.command("init [shell]").description("Install shell integration for woma activate (Bash or Zsh)").option("--reverse", "Remove shell integration").option("--dry-run", "Show changes without writing").action(async (shell: string | undefined, options: { reverse?: boolean; dryRun?: boolean }) => {
  const result = await initializeShell(resolveShell(shell), options);
  console.log(`${options.reverse ? "Reversed" : "Initialized"} ${result.shell} shell ${options.reverse ? "initialization" : "integration"}${options.dryRun ? " (dry run)" : ""}.`);
  for (const action of result.actions) console.log(`${action.verb} ${action.path}`);
  if (!options.reverse && !options.dryRun) console.log("Open a new shell, then: woma create -n NAME claude codex");
});

target(program.command("create [specs...]")).description("Create an environment: agents (claude, codex) and optional package sources, or -f FILE")
  .option("-f, --file <path>", "Environment file (environment.yaml), exact lock (woma.lock), or pack (.tgz)")
  .action(async (specs: string[], options: Target & { file?: string }) => {
    const { agents, sources } = splitSpecs(specs);
    const prefix = await createEnvironment(options, { agents, sources, ...(options.file ? { file: options.file } : {}) });
    const state = await readEnvironment(prefix);
    const packages = state.lock.recipe.packages.map((p) => p.name);
    console.log(`Created environment ${state.lock.recipe.name} at ${prefix}`);
    console.log(`  agents:   ${presentAgents(state.lock).join(", ")}`);
    if (packages.length) console.log(`  packages: ${packages.join(", ")}`);
    const servers = Object.keys(state.lock.recipe.mcp_servers);
    if (servers.length) console.log(`  mcp:      ${servers.join(", ")}`);
    console.log(`\nNext:\n  woma activate ${options.name ?? prefix}\n  ${presentAgents(state.lock).join("   # or: ")}\nSign-in:`);
    await printAuth(prefix, state);
    await warnMissingAgents(presentAgents(state.lock));
  });
target(program.command("activate [environment]")).description("Select an environment in this shell").action(() => { throw new Error("Shell integration is required. Run woma init and open a new shell, or use woma run."); });
program.command("deactivate").description("Leave the active environment").action(() => { throw new Error("Shell integration is required. Run woma init and open a new shell."); });

target(program.command("install <specs...>")).description("Install Skills/plugins (paths, gh:owner/repo[/path][#ref], NAME@owner/repo, Git URLs) or add an agent")
  .option("--subdir <path>", "Select a Git subdirectory (one source)").option("--commit <sha>", "Select an exact Git commit (one source)")
  .action(async (specs: string[], options: Target & { subdir?: string; commit?: string }) => {
    if (options.subdir || options.commit) {
      if (specs.length !== 1) throw new Error("--subdir and --commit require exactly one Git source");
      const git = gitLocator(specs[0]!);
      if (!git || git.select) throw new Error("--subdir and --commit require a Git repository source");
      if (options.commit && !/^[a-f0-9]{40,64}$/.test(options.commit)) throw new Error("--commit requires a full commit SHA");
      if (options.commit && git.ref && options.commit !== git.ref) throw new Error("Conflicting Git refs");
      specs = [gitIntent({ ...git, ...(options.subdir ? { subdirectory: options.subdir } : {}), ...(options.commit ? { ref: options.commit } : {}) })];
    }
    const prefix = await selectPrefix(options);
    const before = await readEnvironment(prefix);
    const state = await installPackages(prefix, specs);
    const agents = presentAgents(state.lock).filter((agent) => !before.lock.recipe.agents.includes(agent));
    const added = Object.values(state.lock.packages).filter((p) => !before.lock.packages[p.name] || before.lock.packages[p.name]!.integrity !== p.integrity);
    for (const agent of agents) console.log(`+ ${agent.padEnd(24)} ${"".padEnd(14)} agent`);
    for (const record of added) console.log(`+ ${record.name.padEnd(24)} ${versionLabel(record).padEnd(14)} ${record.kind.padEnd(8)} → ${packageAgents(state, record)}`);
    if (!added.length && !agents.length) console.log("Nothing to install; everything requested is already in this environment.");
    else console.log("Start a new agent session to load the changes.");
    await warnMissingAgents(agents);
  });
target(program.command("update [names...]")).description("Update packages (and their dependencies); with no names, update every package. Agents update the way you installed them").action(async (names: string[], options: Target) => {
  const prefix = await selectPrefix(options);
  const before = await readEnvironment(prefix);
  const state = await updatePackages(prefix, names);
  let changed = 0;
  for (const record of Object.values(state.lock.packages)) {
    const old = before.lock.packages[record.name];
    if (old && old.integrity !== record.integrity) { changed++; console.log(`~ ${record.name.padEnd(28)} ${versionLabel(old)} → ${versionLabel(record)}`); }
  }
  console.log(changed ? "Start a new agent session to load the changes." : "Already up to date.");
});
target(program.command("remove <names...>")).description("Remove direct packages, or an agent (its sign-in and sessions stay on disk)").action(async (names: string[], options: Target) => {
  const prefix = await selectPrefix(options); await removePackages(prefix, names); console.log(`Removed ${names.join(", ")}.`);
});
target(program.command("list")).description("Show agents, packages and MCP servers in an environment").option("--json").action(async (options: Target & { json?: boolean }) => {
  const prefix = await selectPrefix(options);
  const state = await readEnvironment(prefix);
  const recipe = state.lock.recipe;
  if (options.json) { console.log(JSON.stringify({ name: recipe.name, prefix, agents: recipe.agents, packages: Object.values(state.lock.packages), mcp_servers: recipe.mcp_servers }, null, 2)); return; }
  console.log(`${recipe.name}  (${prefix})\n\nAgents (your installation)`);
  for (const item of await describeAgents(presentAgents(state.lock))) console.log(`  ${item.agent.padEnd(10)} ${item.detail}`);
  const records = Object.values(state.lock.packages);
  if (records.length) {
    console.log("\nPackages");
    for (const record of records) {
      const root = recipe.packages.find((p) => p.name === record.name);
      console.log(`  ${record.name.padEnd(24)} ${record.kind.padEnd(10)} ${packageAgents(state, record).padEnd(13)} ${sourceLabel(record, root?.source.startsWith("file:") ? undefined : root?.source)}${root ? "" : "  (dependency)"}`);
    }
  }
  const servers = Object.entries(recipe.mcp_servers);
  if (servers.length) {
    console.log("\nMCP servers");
    for (const [name, server] of servers) console.log(`  ${name.padEnd(24)} ${server.url ?? [server.command, ...(server.args ?? [])].join(" ")}${server.agents ? `  (${server.agents.join(",")})` : ""}`);
  }
});
program.command("search <query...>").description("Search the skills.sh directory; install results with woma install NAME@owner/repo").option("--limit <n>", "Number of results", "10").action(async (query: string[], options: { limit: string }) => {
  const results = await searchSkills(query.join(" "), Number(options.limit) || 10);
  if (!results.length) { console.log("No Skills found."); return; }
  const width = Math.max(...results.map((r) => r.install.length));
  for (const result of results) console.log(`${result.install.padEnd(width)}  ${result.installs.toLocaleString("en-US")} installs`);
  console.log(`\nInstall: woma install ${results[0]!.install}`);
});

const mcp = program.command("mcp").description("Manage MCP servers shared by the environment's agents");
target(mcp.command("add <name> [command...]")).description("Add or replace an MCP server: woma mcp add NAME -- COMMAND [ARGS...], or --url URL")
  .option("--url <url>", "Streamable HTTP server URL")
  .option("--env <KEY=VALUE>", "Literal, non-secret environment value for a command server (repeatable)", collect)
  .option("--env-var <NAME>", "Pass this variable from your shell to the server; its value is never stored (repeatable)", collect)
  .option("--bearer-token-env-var <NAME>", "Read an HTTP bearer token from this shell variable")
  .option("--agent <agent>", "Only register for this agent (repeatable)", collect)
  .action(async (name: string, command: string[], options: Target & { url?: string; env?: string[]; envVar?: string[]; bearerTokenEnvVar?: string; agent?: string[] }) => {
    mcpNameSchema.parse(name);
    const env = Object.fromEntries((options.env ?? []).map((entry) => {
      const index = entry.indexOf("=");
      if (index < 1) throw new Error(`--env expects KEY=VALUE: ${entry}`);
      return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    let server: McpServer;
    try {
      server = parseMcpServer({
        ...(command.length ? { command: command[0], ...(command.length > 1 ? { args: command.slice(1) } : {}) } : {}),
        ...(options.url ? { url: options.url } : {}), ...(Object.keys(env).length ? { env } : {}),
        ...(options.envVar?.length ? { env_vars: options.envVar } : {}), ...(options.bearerTokenEnvVar ? { bearer_token_env_var: options.bearerTokenEnvVar } : {}),
        ...(options.agent?.length ? { agents: options.agent } : {}),
      });
    } catch (error) { throw new Error(formatIssues(error)); }
    const prefix = await selectPrefix(options);
    const state = await addMcpServer(prefix, name, server);
    console.log(`Added MCP server ${name} for ${(server.agents ?? presentAgents(state.lock)).join(", ")}. Start a new agent session to load it.`);
  });
target(mcp.command("remove <names...>")).description("Remove MCP servers").action(async (names: string[], options: Target) => {
  const prefix = await selectPrefix(options); await removeMcpServers(prefix, names); console.log(`Removed MCP server ${names.join(", ")}.`);
});
target(mcp.command("list")).description("List MCP servers").option("--json").action(async (options: Target & { json?: boolean }) => {
  const state = await readEnvironment(await selectPrefix(options));
  if (options.json) { console.log(JSON.stringify(state.lock.recipe.mcp_servers, null, 2)); return; }
  for (const [name, server] of Object.entries(state.lock.recipe.mcp_servers)) {
    const passed = [...(server.env_vars ?? []), ...(server.bearer_token_env_var ? [server.bearer_token_env_var] : [])];
    console.log(`${name.padEnd(24)} ${server.url ?? [server.command, ...(server.args ?? [])].join(" ")}${passed.length ? `  (from your shell: ${passed.join(", ")})` : ""}`);
  }
});

target(program.command("doctor")).description("Check managed files, native registrations and sign-in").action(async (options: Target) => {
  const prefix = await selectPrefix(options);
  const issues = await doctorEnvironment(prefix);
  for (const issue of issues) console.log(`ERROR ${issue}`);
  if (!issues.length) console.log("Managed environment is consistent.");
  console.log("Sign-in:");
  await printAuth(prefix, await readEnvironment(prefix));
  if (issues.length) process.exitCode = 1;
});
target(program.command("export")).description("Write the environment file others can create from (-f environment.yaml); --explicit for the exact lock; --pack for a single file including local Skills")
  .option("--explicit", "Exact Git commits and content digests").option("-f, --file <path>", "Output file").option("--pack <file>", "Write a .tgz pack with every package snapshot")
  .action(async (options: Target & { explicit?: boolean; file?: string; pack?: string }) => {
    const prefix = await selectPrefix(options);
    if (options.pack) {
      if (options.explicit || options.file) throw new Error("--pack writes its own file; do not combine it with --explicit or -f");
      const result = await packEnvironment(prefix, path.resolve(options.pack));
      reportPortability(result, true);
      console.error(`Wrote ${options.pack}. Recreate with: woma create -n NAME -f ${path.basename(options.pack)}`);
      return;
    }
    const result = await exportEnvironment(prefix, { ...(options.explicit ? { explicit: true } : {}), ...(options.file ? { file: options.file } : {}) });
    reportPortability(result);
    if (options.file) await writeTextAtomic(path.resolve(options.file), result.content); else process.stdout.write(result.content);
  });
target(program.command("run <executable> [args...]")).description("Run a command (e.g. claude, codex) inside an environment without activating it").passThroughOptions().action(async (executable: string, args: string[], options: Target) => {
  const result = await runInEnvironment(await selectPrefix(options), executable, args);
  if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code ?? 1;
});

const env = program.command("env").description("Manage environments");
env.command("list").option("--json").action(async (options: { json?: boolean }) => {
  const environments = await listEnvironments();
  const active = process.env.WOMA_PREFIX;
  if (options.json) console.log(JSON.stringify(environments, null, 2));
  else for (const item of environments) {
    const status = item.format === "v3" ? item.agents.join(",") : item.format === "v2" ? `${item.agents.join(",")} (Woma 0.7: recreate)` : item.format;
    console.log(`${item.prefix === active ? "*" : " "} ${item.name.padEnd(24)} ${status.padEnd(20)} ${item.prefix}`);
  }
});
target(env.command("remove")).description("Delete an environment and all its local state").option("-y, --yes", "Confirm deletion of the entire environment, including local native state").action(async (options: Target & { yes?: boolean }) => {
  const prefix = await selectPrefix(options);
  console.log(`Delete environment ${prefix}\nThis permanently deletes its sign-in, sessions, caches, Memory, native installations, configuration, and all other local state. Exports cannot restore that state.`);
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error("Environment deletion requires --yes in a non-interactive shell");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { if (!/^y(?:es)?$/i.test((await prompt.question("Delete this environment? [y/N] ")).trim())) return; }
    finally { prompt.close(); }
  }
  await removeEnvironment(prefix); console.log(`Removed ${prefix}`);
});

const shell = program.command("shell", { hidden: true }).description("Shell integration internals");
shell.command("hook [shell]").action((value?: string) => { process.stdout.write(renderShellHook(resolveShell(value))); });
target(shell.command("activate [environment]")).action(async (environment: string | undefined, options: Target) => {
  const prefix = await selectPrefix(activationTarget(environment, options));
  const state = await readEnvironment(prefix);
  await warnMissingAgents(presentAgents(state.lock));
  process.stdout.write(renderSelection(selectedEnvironment(prefix, state)));
});
shell.command("deactivate").action(() => { process.stdout.write(renderSelection(originalEnvironment(process.env))); });

try { await program.parseAsync(process.argv); }
catch (error) { console.error(`woma: ${formatIssues(error)}`); process.exitCode = 1; }

