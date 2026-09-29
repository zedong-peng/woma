import { mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { satisfies, valid } from "semver";
import { extract } from "tar";
import { cachePath, publishContent, removeTree, validateTree, verifyContent } from "./content.js";
import { hashDirectory, pathExists } from "./fs.js";
import { commandOutput } from "./process.js";
import { resolveSelection } from "./registry.js";
import { loadManifest, nameSchema, skillMetadata } from "./schema.js";
import { canonicalSource, dependencySource, gitIntent, gitLocator, materializeSource, portableRemote } from "./source.js";
import { AGENTS, type Agent, type Dependency, type EnvironmentLock, type GitOrigin, type InstalledPackage, type PackageRecord, type PackageSource, type RootRequirement } from "./types.js";

async function skillSubdirectories(root: string): Promise<{ directories: string[]; missing: string[] }> {
  const directories: string[] = [];
  const missing: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (await pathExists(path.join(root, entry.name, "SKILL.md"))) directories.push(entry.name);
    else missing.push(entry.name);
  }
  return { directories, missing };
}

async function layoutHint(root: string): Promise<string> {
  const found: string[] = [];
  async function walk(relative: string, depth: number) {
    if (found.length >= 5 || depth > 4) return;
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (await pathExists(path.join(root, child, "SKILL.md"))) found.push(child); else await walk(child, depth + 1);
    }
  }
  await walk("", 0);
  return found.length ? ` Skills were found in subdirectories: ${found.join(", ")}. Install one of those directories instead.` : "";
}

export async function describePackage(root: string, source: PackageSource, integrity: string): Promise<PackageRecord> {
  await validateTree(root);
  const manifest = await loadManifest(root);
  const plugins: { harness: Agent; file: string }[] = [];
  for (const harness of AGENTS) {
    const file = path.join(root, `.${harness}-plugin`, "plugin.json");
    if (await pathExists(file)) plugins.push({ harness, file });
  }
  if (await pathExists(path.join(root, "plugin.json"))) throw new Error("Universal root plugin.json is not yet a verified adapter contract; provide an explicit .codex-plugin or .claude-plugin manifest");
  if (plugins.length > 1) throw new Error("Ambiguous native plugin: select a package with exactly one harness manifest");
  const native = plugins[0];
  let plugin: PackageRecord["plugin"];
  let nativeVersion: string | undefined;
  if (native) {
    const data = JSON.parse(await readFile(native.file, "utf8")) as Record<string, unknown>;
    plugin = { harness: native.harness, name: nameSchema.parse(data.name), version: typeof data.version === "string" ? data.version : "local" };
    if (data.version !== undefined) {
      if (typeof data.version !== "string" || !valid(data.version)) throw new Error(`Invalid native plugin version: ${native.file}`);
      nativeVersion = data.version;
    }
    for (const key of ["dependencies", "optionalDependencies", "requiresPlugins"]) {
      const value = data[key];
      if (value !== undefined && (!Array.isArray(value) || value.length > 0)) throw new Error(`Native plugin ${plugin.name} declares ${key}; this adapter cannot prevent unlocked native dependency resolution`);
    }
  }
  const skills: PackageRecord["skills"] = [];
  if (!plugin) {
    async function addSkill(skillPath: string) {
      const file = path.join(root, skillPath, "SKILL.md");
      skills.push({ name: skillMetadata(await readFile(file, "utf8"), file).name, path: skillPath });
    }
    if (await pathExists(path.join(root, "SKILL.md"))) await addSkill(".");
    else if (await pathExists(path.join(root, "skills"))) {
      const { directories, missing } = await skillSubdirectories(path.join(root, "skills"));
      if (missing.length) throw new Error(`Skill directory has no SKILL.md: ${path.join(root, "skills", missing[0]!, "SKILL.md")}`);
      for (const directory of directories) await addSkill(`skills/${directory}`);
    } else if (!manifest.dependencies.length) {
      // A directory whose children are Skills, e.g. a folder collected from several sources.
      const { directories, missing } = await skillSubdirectories(root);
      if (directories.length && !missing.length) for (const directory of directories) await addSkill(directory);
    }
  }
  const sourceName = source.type === "local" ? path.basename(source.path) : path.posix.basename(source.subdirectory ?? source.url.replace(/\.git$/, ""));
  const name = nameSchema.parse(manifest.name ?? plugin?.name ?? (skills.length === 1 && skills[0]?.path === "." ? skills[0].name : sourceName.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "")));
  if ((AGENTS as readonly string[]).includes(name)) throw new Error(`Package name ${name} is reserved for an agent`);
  if (manifest.name && plugin && manifest.name !== plugin.name) throw new Error("woma.yaml and the native plugin name must agree");
  if (manifest.version && nativeVersion && manifest.version !== nativeVersion) throw new Error("woma.yaml and the native plugin version must agree");
  const version = manifest.version ?? nativeVersion ?? `0.0.0+${integrity.slice(7, 19)}`;
  if (!plugin && skills.length === 0 && manifest.dependencies.length === 0) throw new Error(`Unsupported package layout at ${root}: expected SKILL.md, skills/, directories of Skills, a native plugin, or a dependency collection.${await layoutHint(root)}`);
  if (new Set(skills.map((s) => s.name)).size !== skills.length) throw new Error(`Duplicate Skill names in ${name}`);
  if (new Set(manifest.dependencies.map((d) => d.name)).size !== manifest.dependencies.length) throw new Error(`Duplicate dependencies in ${name}`);
  const harnesses = manifest.harnesses ?? (plugin ? { [plugin.harness]: "*" } : { codex: "*", claude: "*" });
  if (plugin && Object.keys(harnesses).some((h) => h !== plugin.harness)) throw new Error(`Native ${plugin.harness} plugin cannot target another agent`);
  return { name, version, kind: plugin ? "plugin" : skills.length ? "skill" : "collection", source, integrity,
    dependencies: manifest.dependencies.map((d) => ({ ...d, source: dependencySource(d.source, source) })), harnesses, skills, ...(plugin ? { plugin } : {}),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> { return commandOutput("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }

/**
 * Find a pushed commit whose tree at this directory is byte-identical to the snapshot.
 * Such local packages can be exported as Git sources that others can fetch.
 */
export async function detectOrigin(root: string, integrity: string): Promise<GitOrigin | undefined> {
  let top: string;
  try { top = await realpath(await git(root, "rev-parse", "--show-toplevel")); } catch { return undefined; }
  try {
    const subdirectory = path.relative(top, root).split(path.sep).join("/");
    if (subdirectory.startsWith("..")) return undefined;
    const scope = subdirectory || ".";
    if (await git(top, "status", "--porcelain", "--untracked-files=all", "--", scope)) return undefined;
    const commit = await git(top, "rev-parse", "HEAD");
    if (!(await git(top, "branch", "-r", "--contains", commit))) return undefined;
    const upstream = await git(top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").catch(() => "origin/");
    const remote = upstream.split("/")[0] || "origin";
    const url = portableRemote(await git(top, "remote", "get-url", remote));
    if (!url) return undefined;
    const temp = await mkdtemp(path.join(os.tmpdir(), "woma-origin-"));
    try {
      const archive = path.join(temp, "tree.tar");
      await git(top, "archive", "--format=tar", "-o", archive, subdirectory ? `${commit}:${subdirectory}` : commit);
      const tree = path.join(temp, "tree");
      await mkdir(tree);
      await extract({ file: archive, cwd: tree, strict: true, preserveOwner: false });
      if (await hashDirectory(tree) !== integrity) return undefined;
    } finally { await removeTree(temp); }
    return { url, commit, ...(subdirectory ? { subdirectory } : {}) };
  } catch { return undefined; }
}

export async function resolvePackage(input: string, cwd = process.cwd()): Promise<InstalledPackage & { intent: string }> {
  const source = await materializeSource(input, cwd, resolveSelection);
  try {
    const insideEnvironment = await pathExists(path.join(source.root, "../.woma/state.json")) || path.basename(path.dirname(source.root)) === "home" && await pathExists(path.join(source.root, "../../.woma/state.json"));
    if (await pathExists(path.join(source.root, ".woma/state.json")) || insideEnvironment) {
      throw new Error("An environment or native home is not a package source; install an individual Skill or Plugin directory");
    }
    const nativeHomes = [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".claude")].filter((v): v is string => Boolean(v));
    for (const home of nativeHomes) {
      if (source.root === await realpath(home).catch(() => path.resolve(home))) throw new Error("A native home is not a package source; install an individual Skill or Plugin directory");
    }
    for (const file of ["auth.json", ".credentials.json", "history.jsonl", "session_index.jsonl", ".claude.json"]) {
      if (await pathExists(path.join(source.root, file))) throw new Error(`Native state cannot enter a package snapshot (${file}); install an individual Skill or Plugin directory`);
    }
    // Describe the immutable snapshot so changes to a local source cannot race metadata validation.
    const cached = await publishContent(source.root);
    const record = await describePackage(cached.root, source.source, cached.integrity);
    const origin = source.source.type === "local" ? await detectOrigin(source.root, cached.integrity) : undefined;
    return { root: cached.root, record: { ...record, ...(origin ? { origin } : {}) }, intent: source.intent };
  } finally { await source.cleanup(); }
}

export async function loadPackage(record: PackageRecord, restore = false): Promise<InstalledPackage> {
  const root = cachePath(record.integrity);
  if (!(await pathExists(root))) {
    const location = record.source.type === "git" ? record.source : record.origin;
    if (!restore || !location) throw new Error(`Missing snapshot for ${record.name}@${record.version}: ${root}. Local snapshots cannot be reconstructed from a changed source; share local packages with woma export --pack.`);
    const restored = await resolvePackage(gitIntent({ url: location.url, ref: location.commit, subdirectory: location.subdirectory }));
    if (restored.record.integrity !== record.integrity) throw new Error(`Source integrity mismatch for ${record.name}`);
  }
  await verifyContent(root, record.integrity, true);
  const { origin: _origin, ...expected } = record;
  const actual = await describePackage(root, record.source, record.integrity);
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Locked package metadata does not match its snapshot: ${record.name}`);
  return { root, record };
}

/** The agents that receive a package: those it supports that are in the environment. A package no agent can use is an error. */
export function packageTargets(record: PackageRecord, agents: readonly Agent[]): Agent[] {
  if (record.plugin) {
    if (!agents.includes(record.plugin.harness)) throw new Error(`Package ${record.name} is a ${record.plugin.harness} plugin; this environment has no ${record.plugin.harness}. Add it with woma install ${record.plugin.harness}`);
    return [record.plugin.harness];
  }
  const targets = AGENTS.filter((agent) => agents.includes(agent) && record.harnesses[agent] !== undefined);
  if (record.kind === "skill" && !targets.length) throw new Error(`Package ${record.name} supports ${Object.keys(record.harnesses).join(", ")}, none of which is in this environment`);
  return targets;
}

function checkDependency(dependency: Dependency, record: PackageRecord): void {
  if (record.name !== dependency.name || !satisfies(record.version, dependency.version, { includePrerelease: true })) throw new Error(`Dependency conflict: ${dependency.name} requires ${dependency.version}, resolved ${record.name}@${record.version}`);
  assertSourceIdentity(record, dependency.source);
}

export function assertSourceIdentity(record: PackageRecord, intent: string): void {
  const canonical = canonicalSource(intent);
  const git = gitLocator(canonical);
  const source = record.source;
  // A named source resolves through a marketplace or Skill search; the lock records where it led.
  if (git?.select) {
    if (source.type !== "git") throw new Error(`Locked source mismatch for ${record.name}: ${intent}`);
    return;
  }
  const matches = git
    ? source.type === "git" && source.url === git.url && (source.subdirectory ?? ".") === (git.subdirectory ?? ".") && (!/^[a-f0-9]{40,64}$/.test(git.ref ?? "") || git.ref === source.commit)
    : source.type === "local" && source.path === canonical.slice(5);
  if (!matches) throw new Error(`Locked source mismatch for ${record.name}: ${intent}`);
}

export function dependencyOrder(lock: EnvironmentLock): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(name: string) {
    if (visiting.has(name)) throw new Error(`Dependency cycle at ${name}`);
    if (visited.has(name)) return;
    const record = lock.packages[name];
    if (!record || record.name !== name) throw new Error(`Missing or invalid locked package: ${name}`);
    visiting.add(name);
    for (const dep of record.dependencies) {
      const child = lock.packages[dep.name];
      if (!child) throw new Error(`Missing dependency ${dep.name} of ${name}`);
      checkDependency(dep, child);
      visit(dep.name);
    }
    visiting.delete(name); visited.add(name); ordered.push(name);
  }
  for (const root of lock.recipe.packages) {
    visit(root.name);
    assertSourceIdentity(lock.packages[root.name]!, root.source);
  }
  return ordered;
}

export async function resolveClosure(options: {
  roots: RootRequirement[];
  previous?: EnvironmentLock;
  refresh?: Set<string>;
  additions?: (InstalledPackage & { intent: string })[];
}): Promise<Record<string, PackageRecord>> {
  const resolved = new Map<string, PackageRecord>();
  const visiting = new Set<string>();
  const additions = new Map(options.additions?.map((p) => [p.record.name, p]));
  const intents = new Map<string, string>();
  async function visit(requirement: RootRequirement, dependency?: Dependency): Promise<void> {
    const intent = canonicalSource(requirement.source);
    const priorIntent = intents.get(requirement.name);
    if (priorIntent && priorIntent !== intent) throw new Error(`Conflicting sources for ${requirement.name}: ${priorIntent} and ${intent}`);
    intents.set(requirement.name, intent);
    if (visiting.has(requirement.name)) throw new Error(`Dependency cycle at ${requirement.name}`);
    const existing = resolved.get(requirement.name);
    if (existing) { if (dependency) checkDependency(dependency, existing); return; }
    const previous = options.previous?.packages[requirement.name];
    let record: PackageRecord;
    if (additions.has(requirement.name)) record = additions.get(requirement.name)!.record;
    else if (previous && !options.refresh?.has(requirement.name)) record = previous;
    else record = (await resolvePackage(intent)).record;
    if (record.name !== requirement.name) throw new Error(`Source identity changed: expected ${requirement.name}, got ${record.name}`);
    if (dependency) checkDependency(dependency, record);
    visiting.add(record.name);
    for (const child of record.dependencies) await visit(child, child);
    visiting.delete(record.name); resolved.set(record.name, record);
  }
  for (const root of options.roots) await visit(root);
  return Object.fromEntries(resolved);
}
