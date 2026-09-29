import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { removeTree } from "./content.js";
import { canonicalPrefix, withEnvironmentLock, withPrefixLock } from "./environment-lock.js";
import { pathExists, readJson, womaHome, writeJsonAtomic } from "./fs.js";
import { findAgent, installHint, missingAgent } from "./agents.js";
import { agentHome, configDrift, configFiles, presentAgents, reconcileConfigFile } from "./native.js";
import { dependencyOrder, loadPackage, packageTargets, resolveClosure, resolvePackage } from "./package.js";
import { isPack, portableLock, portableRecipe, readPack, writePack } from "./portable.js";
import { legacyStateSchema, nameSchema, parseLock, parseRecipeInput, parseState, upgradeLegacyLock } from "./schema.js";
import { canonicalSource } from "./source.js";
import { assertNoTransactions, assertOrdinaryAncestors, installationOwners, managedDrift, publishEnvironment, statePath, type PublicationHooks } from "./transaction.js";
import { AGENTS, type Agent, type EnvironmentLock, type EnvironmentRecipe, type EnvironmentState, type InstalledPackage, type McpServer, type PackageRecord, type RootRequirement } from "./types.js";

export interface Target { name?: string | undefined; prefix?: string | undefined }
export interface MutationOptions { hooks?: PublicationHooks }

/** `claude` or `codex`. Woma uses the installed agent, so a version (`codex@0.158.0`) is refused rather than ignored. */
export function agentSpec(spec: string): Agent | undefined {
  if ((AGENTS as readonly string[]).includes(spec)) return spec as Agent;
  const versioned = /^(claude|codex)@(latest|\d[\w.+-]*)$/.exec(spec);
  if (versioned) throw new Error(`Woma uses the ${versioned[1]} you installed and does not manage its version; write ${versioned[1]} without @${versioned[2]}`);
  return undefined;
}

export async function selectPrefix(target: Target, active = process.env.WOMA_PREFIX): Promise<string> {
  if (target.name && target.prefix) throw new Error("Select an environment with --name or --prefix, not both");
  if (target.name) return canonicalPrefix(path.join(womaHome(), "environments", nameSchema.parse(target.name)));
  if (target.prefix) return canonicalPrefix(target.prefix);
  if (active) return canonicalPrefix(active);
  throw new Error("No environment selected. Use -n NAME, -p PATH, or woma activate NAME first.");
}

export function validateLock(lock: EnvironmentLock): void {
  const agents = presentAgents(lock);
  if (!agents.length) throw new Error("An environment needs at least one agent");
  const roots = lock.recipe.packages.map((p) => p.name);
  if (new Set(roots).size !== roots.length || roots.some((r) => (AGENTS as readonly string[]).includes(r))) throw new Error("Duplicate or invalid direct package requirements");
  const order = dependencyOrder(lock);
  if (order.length !== Object.keys(lock.packages).length) throw new Error("Lock contains packages outside its dependency closure");
  for (const pkg of Object.values(lock.packages)) {
    if ((pkg.kind === "plugin") !== Boolean(pkg.plugin)) throw new Error(`Invalid plugin metadata: ${pkg.name}`);
    packageTargets(pkg, agents);
  }
}

async function readRawState(prefix: string): Promise<unknown> {
  await assertOrdinaryAncestors(prefix, statePath);
  const file = path.join(prefix, statePath);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!info) {
    if (await pathExists(path.join(prefix, "environment.yaml"))) throw new Error(`Legacy (v1) environment at ${prefix}. It is preserved; create a new environment. Automatic migration is not supported.`);
    throw new Error(`Environment does not exist: ${prefix}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Environment metadata must be an ordinary file: ${file}`);
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readEnvironment(prefix: string): Promise<EnvironmentState> {
  const raw = await readRawState(prefix);
  if ((raw as { format?: unknown })?.format === "woma.state/v2") {
    throw new Error(`${prefix} was created by Woma 0.7. Recreate it (sign-in and sessions are not carried over):\n  woma export -p ${prefix} --explicit -f old.lock\n  woma create -n NEW_NAME -f old.lock`);
  }
  const state = parseState(raw);
  validateLock(state.lock);
  const owners = installationOwners(state.lock);
  if (owners.size !== state.paths.length || new Set(state.paths.map((p) => p.path)).size !== state.paths.length || state.paths.some((p) => owners.get(p.path) !== p.package)) throw new Error("Environment ownership metadata does not match the managed package closure");
  return state;
}

/** The lock of a current or Woma 0.7 environment, for export. */
async function readLock(prefix: string): Promise<EnvironmentLock> {
  const raw = await readRawState(prefix);
  if ((raw as { format?: unknown })?.format === "woma.state/v2") return upgradeLegacyLock(legacyStateSchema.parse(raw).lock);
  return (await readEnvironment(prefix)).lock;
}

async function loadClosure(lock: EnvironmentLock, restore: boolean): Promise<InstalledPackage[]> {
  validateLock(lock);
  const packages: InstalledPackage[] = [];
  for (const name of dependencyOrder(lock)) packages.push(await loadPackage(lock.packages[name]!, restore));
  return packages;
}

async function registerPrefix(prefix: string, remove = false): Promise<void> {
  await withEnvironmentLock("prefix-registry", async () => {
    const file = path.join(womaHome(), "prefixes.json");
    const known = await readJson<string[]>(file, []);
    const next = known.filter((p) => p !== prefix);
    if (!remove) next.push(prefix);
    if (!isDeepStrictEqual(known, next)) await writeJsonAtomic(file, next);
  });
}

/** Add requirements in order (bare sources are resolved to learn their names), then resolve the complete dependency closure. */
async function resolveRequirements(recipe: EnvironmentRecipe, entries: (string | RootRequirement)[], cwd: string, previous?: EnvironmentLock): Promise<Record<string, PackageRecord>> {
  const additions: (InstalledPackage & { intent: string })[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      if (recipe.packages.some((r) => r.name === entry.name)) throw new Error(`Package ${entry.name} is listed twice`);
      recipe.packages.push({ name: entry.name, source: canonicalSource(entry.source, cwd) });
      continue;
    }
    const pkg = await resolvePackage(entry, cwd);
    const old = previous?.packages[pkg.record.name];
    if (old && (!isDeepStrictEqual(old.source, pkg.record.source) || old.integrity !== pkg.record.integrity)) throw new Error(`Package ${pkg.record.name} is already installed from a different source or content; use woma update ${pkg.record.name}`);
    const duplicate = additions.find((p) => p.record.name === pkg.record.name);
    if (duplicate && !isDeepStrictEqual(duplicate.record, pkg.record)) throw new Error(`Conflicting sources or content for ${pkg.record.name}`);
    if (!duplicate) additions.push(pkg);
    if (!recipe.packages.some((r) => r.name === pkg.record.name)) recipe.packages.push({ name: pkg.record.name, source: pkg.intent });
  }
  return resolveClosure({ roots: recipe.packages, ...(previous ? { previous } : {}), additions });
}

export async function createEnvironment(target: Target, options: MutationOptions & { agents?: Agent[]; sources?: string[]; file?: string }): Promise<string> {
  if (!target.name && !target.prefix) throw new Error("create requires -n NAME or -p PATH");
  const prefix = await selectPrefix(target);
  return withPrefixLock(prefix, async () => {
    if (await lstat(prefix).catch(() => undefined)) throw new Error(`Environment already exists: ${prefix}`);
    const name = target.name ?? nameSchema.parse(path.basename(prefix).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, ""));
    let lock: EnvironmentLock;
    let packages: InstalledPackage[];
    const exactLock = async (value: EnvironmentLock) => {
      lock = value; lock.recipe.name = name;
      packages = await loadClosure(lock, true);
    };
    if (options.file) {
      if (options.agents?.length || options.sources?.length) throw new Error("An environment file supplies the agents and packages; install more after creating it");
      const file = path.resolve(options.file);
      if (await isPack(file)) await exactLock(await readPack(file));
      else {
        const input: unknown = parseYaml(await readFile(file, "utf8"));
        const format = (input as { format?: unknown })?.format;
        if (format === "woma.lock/v3" || format === "woma.lock/v2") await exactLock(parseLock(input));
        else {
          const recipeInput = parseRecipeInput(input);
          const recipe: EnvironmentRecipe = { format: "woma.environment/v3", name, agents: recipeInput.agents, packages: [], mcp_servers: recipeInput.mcp_servers };
          const entries = recipeInput.packages.map((entry) => "name" in entry ? entry : entry.source);
          const closure = await resolveRequirements(recipe, entries, path.dirname(file));
          lock = { format: "woma.lock/v3", recipe, packages: closure };
          packages = await loadClosure(lock, false);
        }
      }
    } else {
      const agents = AGENTS.filter((agent) => options.agents?.includes(agent));
      if (!agents.length) throw new Error("create needs at least one agent: woma create -n NAME claude codex");
      const recipe: EnvironmentRecipe = { format: "woma.environment/v3", name, agents, packages: [], mcp_servers: {} };
      const closure = await resolveRequirements(recipe, options.sources ?? [], process.cwd());
      lock = { format: "woma.lock/v3", recipe, packages: closure };
      packages = await loadClosure(lock, false);
    }
    await mkdir(path.dirname(prefix), { recursive: true });
    const stage = path.join(path.dirname(prefix), `.woma-create-${randomUUID()}`);
    await mkdir(stage, { mode: 0o755 });
    let published = false;
    try {
      await publishEnvironment(stage, lock!, packages!, undefined, { identityPrefix: prefix, ...(options.hooks ? { hooks: options.hooks } : {}) });
      await rename(stage, prefix); published = true;
      await registerPrefix(prefix);
      return prefix;
    } catch (error) {
      if (published) await removeTree(prefix);
      throw error;
    } finally { await removeTree(stage); }
  });
}

async function mutate(prefix: string, options: MutationOptions, operation: (old: EnvironmentLock) => Promise<EnvironmentLock>): Promise<EnvironmentState> {
  prefix = await canonicalPrefix(prefix);
  return withPrefixLock(prefix, async () => {
    const previous = await readEnvironment(prefix);
    await assertNoTransactions(prefix);
    const drift = await managedDrift(prefix, previous);
    if (drift.length) throw new Error(drift.join("\n"));
    const lock = await operation(structuredClone(previous.lock));
    const packages = await loadClosure(lock, false);
    return publishEnvironment(prefix, lock, packages, previous, options);
  });
}

/** Install packages, or add an agent (`claude`, `codex`) to the environment. */
export async function installPackages(prefix: string, specs: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  if (!specs.length) throw new Error("install requires at least one package source or agent");
  return mutate(prefix, options, async (lock) => {
    const sources: string[] = [];
    const agents = new Set(lock.recipe.agents);
    for (const spec of specs) {
      const agent = agentSpec(spec);
      if (agent) agents.add(agent); else sources.push(spec);
    }
    lock.recipe.agents = AGENTS.filter((agent) => agents.has(agent));
    lock.packages = await resolveRequirements(lock.recipe, sources, process.cwd(), lock);
    return lock;
  });
}

export async function updatePackages(prefix: string, names: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  for (const name of names) {
    const agent = agentSpec(name);
    if (agent) throw new Error(`Woma does not manage ${agent}'s version; update it the way you installed it (for example: ${installHint[agent]})`);
  }
  return mutate(prefix, options, async (lock) => {
    const refresh = new Set<string>();
    const selected = names.length ? names : lock.recipe.packages.map((r) => r.name);
    function mark(name: string) {
      if (refresh.has(name)) return;
      const record = lock.packages[name];
      if (!record) throw new Error(`Package is not installed: ${name}`);
      refresh.add(name);
      for (const dep of record.dependencies) mark(dep.name);
    }
    for (const name of selected) mark(name);
    lock.packages = await resolveClosure({ roots: lock.recipe.packages, previous: lock, refresh });
    return lock;
  });
}

/** Remove direct packages or an agent. Removing an agent keeps its native home (sign-in, sessions) on disk. */
export async function removePackages(prefix: string, names: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  if (!names.length) throw new Error("remove requires at least one package or agent");
  return mutate(prefix, options, async (lock) => {
    for (const name of names) {
      if ((AGENTS as readonly string[]).includes(name)) {
        const agent = name as Agent;
        if (!lock.recipe.agents.includes(agent)) throw new Error(`This environment has no ${agent}`);
        if (presentAgents(lock).length === 1) throw new Error(`Cannot remove the only agent; use woma env remove to delete the environment`);
        const plugins = Object.values(lock.packages).filter((p) => p.plugin?.harness === agent && !names.includes(p.name));
        if (plugins.length) throw new Error(`Remove the ${agent} plugins first: ${plugins.map((p) => p.name).join(", ")}`);
        lock.recipe.agents = lock.recipe.agents.filter((a) => a !== agent);
      } else if (!lock.recipe.packages.some((r) => r.name === name)) {
        throw new Error(lock.packages[name] ? `Package ${name} is a dependency of another package; remove that package first` : `Package is not installed: ${name}`);
      }
    }
    lock.recipe.packages = lock.recipe.packages.filter((r) => !names.includes(r.name));
    const order = dependencyOrder(lock);
    lock.packages = Object.fromEntries(order.map((name) => [name, lock.packages[name]!]));
    return lock;
  });
}

export async function addMcpServer(prefix: string, name: string, server: McpServer, options: MutationOptions = {}): Promise<EnvironmentState> {
  return mutate(prefix, options, async (lock) => {
    for (const agent of server.agents ?? []) if (!lock.recipe.agents.includes(agent)) throw new Error(`This environment has no ${agent}`);
    lock.recipe.mcp_servers = { ...lock.recipe.mcp_servers, [name]: server };
    return lock;
  });
}

export async function removeMcpServers(prefix: string, names: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  if (!names.length) throw new Error("mcp remove requires at least one server name");
  return mutate(prefix, options, async (lock) => {
    for (const name of names) if (!lock.recipe.mcp_servers[name]) throw new Error(`MCP server is not in this environment: ${name}`);
    lock.recipe.mcp_servers = Object.fromEntries(Object.entries(lock.recipe.mcp_servers).filter(([name]) => !names.includes(name)));
    return lock;
  });
}

export interface ExportResult { content: string; converted: string[]; local: string[] }

/** Export the environment file (intent) or, with explicit, the exact lock. Local packages pushed to Git become Git sources. */
export async function exportEnvironment(prefix: string, options: { explicit?: boolean; file?: string } = {}): Promise<ExportResult> {
  const portable = await portableLock(await readLock(prefix));
  const content = options.explicit ? `${JSON.stringify(portable.lock, null, 2)}\n` : stringifyYaml(portableRecipe(portable.lock.recipe, options.file));
  const directLocal = portable.lock.recipe.packages.filter((p) => p.source.startsWith("file:")).map((p) => p.name);
  return { content, converted: portable.converted, local: options.explicit ? portable.local : directLocal };
}

export async function packEnvironment(prefix: string, file: string): Promise<{ converted: string[]; local: string[] }> {
  const portable = await portableLock(await readLock(prefix));
  await writePack(portable.lock, file);
  return { converted: portable.converted, local: portable.local };
}

export async function doctorEnvironment(prefix: string): Promise<string[]> {
  prefix = await canonicalPrefix(prefix);
  const state = await readEnvironment(prefix);
  const issues = await managedDrift(prefix, state);
  for (const agent of presentAgents(state.lock)) if (!(await findAgent(agent))) issues.push(missingAgent(agent));
  try { await assertNoTransactions(prefix); } catch (error) { issues.push((error as Error).message); }
  for (const record of Object.values(state.lock.packages)) {
    try { await loadPackage(record); } catch (error) { issues.push((error as Error).message); }
  }
  for (const agent of presentAgents(state.lock)) {
    for (const file of configFiles(agent)) {
      try {
        const input = await readFile(path.join(prefix, file.path), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
        reconcileConfigFile(file, prefix, input, state.lock, state.lock);
        issues.push(...configDrift(file, input, state.lock));
      } catch (error) { issues.push((error as Error).message); }
    }
  }
  return issues;
}

export interface AuthStatus { agent: Agent; status: "env" | "signed-in" | "unknown" | "missing"; detail: string }

/** How each agent will authenticate. Reads only the presence of variables and credential files, never their values. */
export async function authStatus(prefix: string, lock: EnvironmentLock, environment: NodeJS.ProcessEnv = process.env): Promise<AuthStatus[]> {
  const result: AuthStatus[] = [];
  for (const agent of presentAgents(lock)) {
    const home = path.join(prefix, agentHome(agent));
    if (agent === "claude") {
      const variable = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].find((name) => environment[name]);
      if (variable) result.push({ agent, status: "env", detail: `uses ${variable} from your shell` });
      else if (await pathExists(path.join(home, ".credentials.json"))) result.push({ agent, status: "signed-in", detail: "signed in inside this environment" });
      else if (process.platform === "darwin") result.push({ agent, status: "unknown", detail: "check with: woma run -p ENV claude auth status" });
      else result.push({ agent, status: "missing", detail: "not signed in: run claude and use /login, or export CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) to share one sign-in across environments" });
    } else if (await pathExists(path.join(home, "auth.json"))) result.push({ agent, status: "signed-in", detail: "signed in inside this environment" });
    else result.push({ agent, status: "missing", detail: "not signed in: run codex login (once per environment), or printenv OPENAI_API_KEY | codex login --with-api-key" });
  }
  return result;
}

export interface EnvironmentSummary { name: string; prefix: string; format: "v3" | "v2" | "legacy" | "invalid"; agents: Agent[] }

export async function listEnvironments(): Promise<EnvironmentSummary[]> {
  const root = path.join(womaHome(), "environments");
  const names = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return []; });
  const known = await readJson<string[]>(path.join(womaHome(), "prefixes.json"), []);
  const prefixes = new Set([...names.filter((n) => n.isDirectory() && !n.name.startsWith(".")).map((n) => path.join(root, n.name)), ...known]);
  const result: EnvironmentSummary[] = [];
  for (const prefix of [...prefixes].sort()) {
    if (!(await pathExists(prefix))) continue;
    try { const state = await readEnvironment(prefix); result.push({ name: state.lock.recipe.name, prefix, format: "v3", agents: presentAgents(state.lock) }); }
    catch {
      const raw = await readRawState(prefix).catch(() => undefined) as { format?: unknown; lock?: { recipe?: { harness?: Agent } } } | undefined;
      if (raw?.format === "woma.state/v2") result.push({ name: path.basename(prefix), prefix, format: "v2", agents: raw.lock?.recipe?.harness ? [raw.lock.recipe.harness] : [] });
      else result.push({ name: path.basename(prefix), prefix, format: await pathExists(path.join(prefix, "environment.yaml")) ? "legacy" : "invalid", agents: [] });
    }
  }
  return result;
}

export async function removeEnvironment(prefix: string): Promise<void> {
  await withPrefixLock(prefix, async () => {
    await readRawState(prefix);
    if (process.env.WOMA_PREFIX && await canonicalPrefix(process.env.WOMA_PREFIX) === await canonicalPrefix(prefix)) throw new Error("Deactivate the environment before removing it");
    await assertNoTransactions(prefix);
    await removeTree(prefix);
    await registerPrefix(prefix, true);
  });
}
