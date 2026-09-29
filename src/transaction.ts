import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { copyContent, removeTree, setTreeWritable } from "./content.js";
import { hashPath, pathExists } from "./fs.js";
import { agentHome, codexMarketplace, configFiles, marketplacePath, pluginInstallationPaths, presentAgents, reconcileConfigFile } from "./native.js";
import { packageTargets } from "./package.js";
import { relativePath } from "./schema.js";
import { AGENTS, type Agent, type EnvironmentLock, type EnvironmentState, type InstalledPackage, type ManagedPath, type PackageRecord } from "./types.js";

export interface PublicationHooks {
  beforePublish?: () => Promise<void>;
  afterChange?: (relative: string, index: number) => Promise<void>;
}
interface Change { path: string; before: string | null; after: string | null; stage?: string; backup: string }

export const statePath = ".woma/state.json";

/** Every managed path a package publishes, with the package-relative directory it receives. */
export function installationPlan(record: PackageRecord, agents: readonly Agent[]): { path: string; source: string }[] {
  if (record.plugin) return pluginInstallationPaths(record).map((relative) => ({ path: relative, source: "." }));
  return packageTargets(record, agents).flatMap((agent) => record.skills.map((skill) => ({ path: `${agentHome(agent)}/skills/${skill.name}`, source: skill.path })));
}

export function installationOwners(lock: EnvironmentLock): Map<string, string> {
  const owners = new Map<string, string>();
  const agents = presentAgents(lock);
  function add(relative: string, name: string) {
    relativePath.parse(relative);
    if (owners.has(relative)) throw new Error(`Duplicate installation path: ${relative}`);
    owners.set(relative, name);
  }
  for (const record of Object.values(lock.packages)) for (const item of installationPlan(record, agents)) add(item.path, record.name);
  if (Object.values(lock.packages).some((r) => r.plugin?.harness === "codex")) add(marketplacePath, "codex");
  return owners;
}

export async function assertOrdinaryAncestors(prefix: string, relative: string): Promise<void> {
  relativePath.parse(relative);
  const components = relative.split("/");
  let current = prefix;
  for (const part of components.slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Managed path has a non-directory or symlink ancestor: ${current}`);
  }
}

export async function fingerprint(prefix: string, relative: string): Promise<string | null> {
  await assertOrdinaryAncestors(prefix, relative);
  const file = path.join(prefix, relative);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`Managed path is a symlink: ${file}`);
  return hashPath(file);
}

export async function managedDrift(prefix: string, state: EnvironmentState): Promise<string[]> {
  const issues: string[] = [];
  for (const entry of state.paths) {
    try {
      if (await fingerprint(prefix, entry.path) !== entry.integrity) issues.push(`Managed content drift: ${entry.path}`);
    } catch (error) { issues.push((error as Error).message); }
  }
  return issues;
}

export async function assertNoTransactions(prefix: string): Promise<void> {
  const directory = path.join(prefix, ".woma/transactions");
  await assertOrdinaryAncestors(prefix, ".woma/transactions/entry");
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return []; });
  if (entries.length) throw new Error(`Interrupted transaction at ${directory}; preserve its backups and recover before modifying this environment`);
}

export async function publishEnvironment(prefix: string, lock: EnvironmentLock, packages: InstalledPackage[], previous?: EnvironmentState, options: { identityPrefix?: string; hooks?: PublicationHooks } = {}): Promise<EnvironmentState> {
  await assertNoTransactions(prefix);
  const stateBefore = await fingerprint(prefix, statePath);
  const agents = presentAgents(lock);
  if (!agents.length) throw new Error("An environment needs at least one agent");
  for (const pkg of packages) packageTargets(pkg.record, agents);
  const transaction = path.join(prefix, ".woma/transactions", randomUUID());
  const staging = path.join(transaction, "next");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const desired: ManagedPath[] = [];
  const owners = new Map<string, string>();
  const previousPaths = new Map(previous?.paths.map((entry) => [entry.path, entry]));
  const unchanged = new Set<string>();
  const changes: Change[] = [];
  let preserveTransaction = false;
  try {
    async function own(relative: string, owner: string, content: { source: string; integrity: string } | { text: string }) {
      for (const [owned, other] of owners) {
        if (relative === owned || relative.startsWith(`${owned}/`) || owned.startsWith(`${relative}/`)) throw new Error(`Installation path conflict: ${relative} (${other}, ${owner})`);
      }
      owners.set(relative, owner);
      const old = previousPaths.get(relative);
      if ("source" in content && old?.package === owner && previous?.lock.packages[owner]?.integrity === content.integrity) {
        desired.push(old); unchanged.add(relative); return;
      }
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      if ("source" in content) {
        await copyContent(content.source, destination);
        await setTreeWritable(destination, true);
      } else {
        await writeFile(destination, content.text, { mode: 0o644 });
      }
      const integrity = await hashPath(destination);
      desired.push({ path: relative, integrity, package: owner });
    }
    for (const pkg of packages) {
      for (const item of installationPlan(pkg.record, agents)) await own(item.path, pkg.record.name, { source: path.join(pkg.root, item.source), integrity: pkg.record.integrity });
    }
    // The Codex plugin marketplace is shared by every Codex plugin; it is owned by the agent, not by one package.
    const codexPlugins = packages.filter((p) => p.record.plugin?.harness === "codex");
    if (codexPlugins.length) await own(marketplacePath, "codex", { text: codexMarketplace(packages.map((p) => p.record)) });

    async function change(relative: string, after: string | null, stage?: string, expected?: string | null) {
      const before = await fingerprint(prefix, relative);
      if (expected !== undefined && expected !== before) throw new Error(`Concurrent modification or managed drift: ${relative}`);
      if (after === before) return;
      changes.push({ path: relative, before, after, ...(stage ? { stage } : {}), backup: path.join(transaction, "previous", String(changes.length)) });
    }
    for (const old of previousPaths.values()) {
      if (!owners.has(old.path)) await change(old.path, null, undefined, old.integrity);
    }
    for (const item of desired) {
      if (unchanged.has(item.path)) continue;
      const old = previousPaths.get(item.path);
      let expected: string | null = old?.integrity ?? null;
      if (!old && await fingerprint(prefix, item.path) !== null) {
        const pkg = packages.find((p) => p.record.name === item.package);
        const source = pkg?.record.source;
        const skill = pkg?.record.skills.find((s) => /^home\/[a-z]+\/skills\//.test(item.path) && item.path.endsWith(`/skills/${s.name}`));
        const original = source?.type === "local" ? path.resolve(source.path, skill?.path ?? ".") : undefined;
        if (!original || original !== path.join(options.identityPrefix ?? prefix, item.path)) throw new Error(`Unmanaged installation conflict at ${item.path}; install that exact native path to adopt it`);
        expected = item.integrity;
      }
      await change(item.path, item.integrity, path.join(staging, item.path), expected);
    }

    for (const agent of AGENTS.filter((a) => lock.recipe.agents.includes(a) || previous?.lock.recipe.agents.includes(a))) {
      for (const file of configFiles(agent)) {
        const configBefore = await fingerprint(prefix, file.path);
        const originalConfig = configBefore === null ? "" : await readFile(path.join(prefix, file.path), "utf8");
        const config = reconcileConfigFile(file, options.identityPrefix ?? prefix, originalConfig, previous?.lock, lock);
        if (config === originalConfig) continue;
        const staged = path.join(staging, file.path);
        await mkdir(path.dirname(staged), { recursive: true });
        const mode = configBefore === null ? 0o600 : (await lstat(path.join(prefix, file.path))).mode & 0o777;
        await writeFile(staged, config, { mode });
        await chmod(staged, mode);
        await change(file.path, await hashPath(staged), staged, configBefore);
      }
    }
    const state: EnvironmentState = { format: "woma.state/v3", lock, paths: desired };
    const stagedState = path.join(staging, statePath);
    await mkdir(path.dirname(stagedState), { recursive: true });
    await writeFile(stagedState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await change(statePath, await hashPath(stagedState), stagedState, stateBefore);
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify(changes, null, 2), { mode: 0o600 });
    await options.hooks?.beforePublish?.();
    // Recheck the complete managed surface before the first mutation; native config also has a per-write check.
    if (previous) {
      const drift = await managedDrift(prefix, previous);
      if (drift.length) throw new Error(drift.join("\n"));
    }
    const applied: { change: Change; expected: string | null }[] = [];
    const createdParents = new Set<string>();
    try {
      for (const [index, entry] of changes.entries()) {
        if (await fingerprint(prefix, entry.path) !== entry.before) throw new Error(`Concurrent modification: ${entry.path}`);
        const target = path.join(prefix, entry.path);
        const parent = path.dirname(target);
        const firstCreated = await mkdir(parent, { recursive: true });
        if (firstCreated) {
          let directory = parent;
          const created: string[] = [];
          while (directory.length >= firstCreated.length) {
            created.push(directory);
            if (directory === firstCreated) break;
            directory = path.dirname(directory);
          }
          for (const directory of created.reverse()) createdParents.add(directory);
        }
        if (entry.before !== null) {
          await mkdir(path.dirname(entry.backup), { recursive: true });
          await rename(target, entry.backup);
        }
        const appliedEntry = { change: entry, expected: null as string | null };
        applied.push(appliedEntry);
        if (entry.stage) {
          await rename(entry.stage, target);
          appliedEntry.expected = entry.after;
        }
        await options.hooks?.afterChange?.(entry.path, index);
      }
      // Native homes hold agent-owned state; Woma creates them but never manages their contents.
      for (const agent of presentAgents(lock)) await mkdir(path.join(prefix, agentHome(agent)), { recursive: true, mode: 0o700 });
    } catch (error) {
      const failures: string[] = [];
      for (const { change: entry, expected } of applied.reverse()) {
        try {
          const current = await fingerprint(prefix, entry.path);
          if (current !== expected) throw new Error(`External changes retained at ${entry.path}`);
          if (current !== null) await removeTree(path.join(prefix, entry.path));
          if (entry.before !== null) await rename(entry.backup, path.join(prefix, entry.path));
        } catch (rollbackError) { failures.push((rollbackError as Error).message); }
      }
      for (const directory of [...createdParents].reverse()) {
        try { await rmdir(directory); }
        catch (error) {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) failures.push((error as Error).message);
        }
      }
      if (failures.length) { preserveTransaction = true; throw new Error(`${(error as Error).message}; rollback incomplete: ${failures.join("; ")}. Backups retained at ${transaction}`); }
      throw error;
    }
    return state;
  } finally {
    if (!preserveTransaction) await removeTree(transaction);
    const directory = path.dirname(transaction);
    if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true });
  }
}
