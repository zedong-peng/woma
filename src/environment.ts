import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { removeTree } from "./content.js";
import { canonicalPrefix, withEnvironmentLock, withPrefixLock } from "./environment-lock.js";
import { pathExists, readJson, womaHome, writeJsonAtomic } from "./fs.js";
import { nativeConfigPath, reconcileNativeConfig, validateNativeContract } from "./native.js";
import { assertCompatible, dependencyOrder, loadPackage, resolveClosure, resolvePackage } from "./package.js";
import { npmRuntimeProvider, runtimePlatform, type RuntimeProvider } from "./runtime.js";
import { nameSchema, parseLock, parseRecipe, parseState } from "./schema.js";
import { canonicalSource } from "./source.js";
import { assertNoTransactions, assertOrdinaryAncestors, installationOwners, managedDrift, publishEnvironment, statePath, type PublicationHooks } from "./transaction.js";
import type { EnvironmentLock, EnvironmentRecipe, EnvironmentState, Harness, InstalledPackage, PackageRecord } from "./types.js";

export interface Target { name?: string | undefined; prefix?: string | undefined }
export interface MutationOptions { provider?: RuntimeProvider; hooks?: PublicationHooks }

export async function selectPrefix(target: Target, active = process.env.WOMA_PREFIX): Promise<string> {
  if (target.name && target.prefix) throw new Error("Select an environment with --name or --prefix, not both");
  if (target.name) return canonicalPrefix(path.join(womaHome(), "environments", nameSchema.parse(target.name)));
  if (target.prefix) return canonicalPrefix(target.prefix);
  if (active) return canonicalPrefix(active);
  throw new Error("No environment selected. Use -n/--name, -p/--prefix, or woma activate; Woma does not create a default environment.");
}

export function validateLock(lock: EnvironmentLock): void {
  if (lock.platform !== runtimePlatform()) throw new Error(`Platform mismatch: lock has ${lock.platform}, current platform is ${runtimePlatform()}`);
  const runtime = lock.packages[lock.recipe.harness];
  const runtimes = Object.values(lock.packages).filter((p) => p.kind === "runtime");
  if (runtimes.length !== 1 || runtime?.kind !== "runtime" || runtime.source.type !== "runtime" || runtime.source.platform !== lock.platform || runtime.dependencies.length || runtime.skills.length || runtime.plugin) throw new Error("Lock must contain exactly one matching managed runtime");
  if (lock.recipe.runtime !== "latest" && lock.recipe.runtime !== runtime.version) throw new Error("Locked runtime version does not match the recipe's exact requirement");
  const roots = lock.recipe.packages.map((p) => p.name);
  if (new Set(roots).size !== roots.length || roots.includes(lock.recipe.harness)) throw new Error("Duplicate or invalid direct package requirements");
  const order = dependencyOrder(lock);
  if (order.length !== Object.keys(lock.packages).length) throw new Error("Lock contains packages outside its dependency closure");
  for (const pkg of Object.values(lock.packages)) {
    if ((pkg.kind === "runtime") !== (pkg.source.type === "runtime")) throw new Error(`Invalid package source kind: ${pkg.name}`);
    if ((pkg.kind === "plugin") !== Boolean(pkg.plugin)) throw new Error(`Invalid plugin metadata: ${pkg.name}`);
    assertCompatible(pkg, lock.recipe.harness, runtime.version);
    validateNativeContract(pkg, runtime.version);
  }
}

export async function readEnvironment(prefix: string): Promise<EnvironmentState> {
  await assertOrdinaryAncestors(prefix, statePath);
  const file = path.join(prefix, statePath);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!info) {
    if (await pathExists(path.join(prefix, "environment.yaml"))) throw new Error(`Legacy environment at ${prefix}. It is preserved; create a new v2 environment. Automatic migration is not supported.`);
    throw new Error(`Environment does not exist: ${prefix}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Environment metadata must be an ordinary file: ${file}`);
  const state = parseState(JSON.parse(await readFile(file, "utf8")));
  validateLock(state.lock);
  const owners = installationOwners(Object.values(state.lock.packages));
  if (owners.size !== state.paths.length || new Set(state.paths.map((p) => p.path)).size !== state.paths.length || state.paths.some((p) => owners.get(p.path) !== p.package)) throw new Error("Environment ownership metadata does not match the managed package closure");
  return state;
}

async function loadClosure(lock: EnvironmentLock, restore: boolean, provider: RuntimeProvider): Promise<InstalledPackage[]> {
  validateLock(lock);
  const packages: InstalledPackage[] = [];
  for (const name of dependencyOrder(lock)) {
    const record = lock.packages[name]!;
    packages.push(record.kind === "runtime" && restore ? await provider.restore(record) : await loadPackage(record, restore));
  }
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

export async function createEnvironment(target: Target, options: MutationOptions & { harness?: Harness; version?: string; file?: string }): Promise<string> {
  if (!target.name && !target.prefix) throw new Error("create requires -n/--name or -p/--prefix");
  const prefix = await selectPrefix(target);
  return withPrefixLock(prefix, async () => {
    if (await lstat(prefix).catch(() => undefined)) throw new Error(`Environment prefix already exists: ${prefix}`);
    const name = target.name ?? nameSchema.parse(path.basename(prefix).toLowerCase().replace(/[^a-z0-9._-]/g, "-"));
    const provider = options.provider ?? npmRuntimeProvider;
    let lock: EnvironmentLock;
    let packages: InstalledPackage[];
    if (options.file) {
      if (options.harness || options.version) throw new Error("A recipe or lock supplies the harness and runtime; do not also specify them");
      const input: unknown = parseYaml(await readFile(options.file, "utf8"));
      if ((input as { format?: unknown })?.format === "woma.lock/v2") {
        lock = parseLock(input);
        lock.recipe.name = name;
        packages = await loadClosure(lock, true, provider);
      } else {
        const recipe = parseRecipe(input);
        recipe.name = name;
        recipe.packages = recipe.packages.map((r) => ({ ...r, source: canonicalSource(r.source, path.dirname(path.resolve(options.file!))) }));
        const runtime = await provider.resolve(recipe.harness, recipe.runtime);
        const closure = await resolveClosure({ roots: recipe.packages });
        lock = { format: "woma.lock/v2", platform: runtimePlatform(), recipe, packages: { [recipe.harness]: runtime.record, ...closure } };
        packages = await loadClosure(lock, false, provider);
      }
    } else {
      if (!options.harness) throw new Error("create requires a harness (codex or claude) or --file");
      const runtime = await provider.resolve(options.harness, options.version ?? "latest");
      const recipe: EnvironmentRecipe = { format: "woma.environment/v2", name, harness: options.harness, runtime: options.version ?? "latest", packages: [] };
      lock = { format: "woma.lock/v2", platform: runtimePlatform(), recipe, packages: { [options.harness]: runtime.record } };
      validateLock(lock); packages = [runtime];
    }
    await mkdir(path.dirname(prefix), { recursive: true });
    const stage = path.join(path.dirname(prefix), `.woma-create-${randomUUID()}`);
    await mkdir(path.join(stage, "home"), { recursive: true, mode: 0o700 });
    let published = false;
    try {
      await publishEnvironment(stage, lock, packages, undefined, { identityPrefix: prefix, ...(options.hooks ? { hooks: options.hooks } : {}) });
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
    const packages = await loadClosure(lock, false, options.provider ?? npmRuntimeProvider);
    return publishEnvironment(prefix, lock, packages, previous, options);
  });
}

export async function installPackages(prefix: string, sources: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  if (!sources.length) throw new Error("install requires at least one source");
  return mutate(prefix, options, async (lock) => {
    const additions: (InstalledPackage & { intent: string })[] = [];
    for (const source of sources) {
      const pkg = await resolvePackage(source);
      const old = lock.packages[pkg.record.name];
      if (old && (!isDeepStrictEqual(old.source, pkg.record.source) || old.integrity !== pkg.record.integrity)) throw new Error(`Package ${pkg.record.name} is already locked to different content or source; use woma update ${pkg.record.name}`);
      const duplicate = additions.find((p) => p.record.name === pkg.record.name);
      if (duplicate && !isDeepStrictEqual(duplicate.record, pkg.record)) throw new Error(`Conflicting sources or content for ${pkg.record.name}`);
      if (!duplicate) additions.push(pkg);
      if (!lock.recipe.packages.some((r) => r.name === pkg.record.name)) lock.recipe.packages.push({ name: pkg.record.name, source: pkg.intent });
    }
    const closure = await resolveClosure({ roots: lock.recipe.packages, previous: lock, additions });
    lock.packages = { [lock.recipe.harness]: lock.packages[lock.recipe.harness]!, ...closure };
    return lock;
  });
}

export async function updatePackages(prefix: string, names: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  return mutate(prefix, options, async (lock) => {
    const refresh = new Set<string>();
    let runtimeVersion: string | undefined;
    const selected = names.length ? names : [lock.recipe.harness, ...lock.recipe.packages.map((r) => r.name)];
    function mark(name: string) {
      if (refresh.has(name)) return;
      const record = lock.packages[name];
      if (!record) throw new Error(`Package is not installed: ${name}`);
      refresh.add(name);
      for (const dep of record.dependencies) mark(dep.name);
    }
    for (const spec of selected) {
      const match = /^(codex|claude)(?:@(.+))?$/.exec(spec);
      if (match) {
        if (match[1] !== lock.recipe.harness) throw new Error("Changing harness brands requires a new environment");
        runtimeVersion = match[2] ?? "latest";
      } else mark(spec);
    }
    let runtime = lock.packages[lock.recipe.harness]!;
    if (runtimeVersion) {
      runtime = (await (options.provider ?? npmRuntimeProvider).resolve(lock.recipe.harness, runtimeVersion)).record;
      lock.recipe.runtime = runtimeVersion;
    }
    const closure = await resolveClosure({ roots: lock.recipe.packages, previous: lock, refresh });
    lock.packages = { [lock.recipe.harness]: runtime, ...closure };
    return lock;
  });
}

export async function removePackages(prefix: string, names: string[], options: MutationOptions = {}): Promise<EnvironmentState> {
  if (!names.length) throw new Error("remove requires at least one package name");
  return mutate(prefix, options, async (lock) => {
    for (const name of names) {
      if (name === lock.recipe.harness) throw new Error("Cannot remove the environment's runtime; use env remove to delete the environment");
      if (!lock.recipe.packages.some((r) => r.name === name)) throw new Error(`Package ${name} is not a direct requirement; remove its dependent package first`);
    }
    lock.recipe.packages = lock.recipe.packages.filter((r) => !names.includes(r.name));
    const order = dependencyOrder(lock);
    lock.packages = Object.fromEntries(order.map((name) => [name, lock.packages[name]!]));
    return lock;
  });
}

export async function exportEnvironment(prefix: string, explicit = false): Promise<string> {
  const state = await readEnvironment(prefix);
  return explicit ? `${JSON.stringify(state.lock, null, 2)}\n` : stringifyYaml(state.lock.recipe);
}

export async function doctorEnvironment(prefix: string): Promise<string[]> {
  prefix = await canonicalPrefix(prefix);
  const state = await readEnvironment(prefix);
  const issues = await managedDrift(prefix, state);
  try { await assertNoTransactions(prefix); } catch (error) { issues.push((error as Error).message); }
  for (const record of Object.values(state.lock.packages)) {
    try { await loadPackage(record); } catch (error) { issues.push((error as Error).message); }
  }
  try {
    const file = path.join(prefix, nativeConfigPath(state.lock.recipe.harness));
    const input = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
    const records = Object.values(state.lock.packages);
    reconcileNativeConfig(state.lock.recipe.harness, prefix, input, records, records);
  } catch (error) { issues.push((error as Error).message); }
  return issues;
}

export async function listEnvironments(): Promise<{ name: string; prefix: string; format: "v2" | "legacy" | "invalid" }[]> {
  const root = path.join(womaHome(), "environments");
  const names = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return []; });
  const known = await readJson<string[]>(path.join(womaHome(), "prefixes.json"), []);
  const prefixes = new Set([...names.filter((n) => n.isDirectory() && !n.name.startsWith(".")).map((n) => path.join(root, n.name)), ...known]);
  const result: { name: string; prefix: string; format: "v2" | "legacy" | "invalid" }[] = [];
  for (const prefix of [...prefixes].sort()) {
    if (!(await pathExists(prefix))) continue;
    try { const state = await readEnvironment(prefix); result.push({ name: state.lock.recipe.name, prefix, format: "v2" }); }
    catch { result.push({ name: path.basename(prefix), prefix, format: await pathExists(path.join(prefix, "environment.yaml")) ? "legacy" : "invalid" }); }
  }
  return result;
}

export async function removeEnvironment(prefix: string): Promise<void> {
  await withPrefixLock(prefix, async () => {
    await readEnvironment(prefix);
    if (process.env.WOMA_PREFIX && await canonicalPrefix(process.env.WOMA_PREFIX) === await canonicalPrefix(prefix)) throw new Error("Deactivate the environment before removing it");
    await assertNoTransactions(prefix);
    await removeTree(prefix);
    await registerPrefix(prefix, true);
  });
}
