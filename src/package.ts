import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { satisfies, valid } from "semver";
import { cachePath, publishContent, validateTree, verifyContent } from "./content.js";
import { pathExists } from "./fs.js";
import { loadManifest, nameSchema, skillMetadata } from "./schema.js";
import { canonicalSource, dependencySource, gitIntent, gitLocator, materializeSource } from "./source.js";
import { verifyRuntimeIdentity } from "./runtime.js";
import type { Dependency, EnvironmentLock, Harness, InstalledPackage, PackageRecord, PackageSource, RootRequirement } from "./types.js";

export async function describePackage(root: string, source: Exclude<PackageSource, { type: "runtime" }>, integrity: string): Promise<PackageRecord> {
  await validateTree(root);
  const manifest = await loadManifest(root);
  const plugins: { harness: Harness; file: string }[] = [];
  for (const harness of ["codex", "claude"] as const) {
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
    if (await pathExists(path.join(root, "SKILL.md"))) {
      const metadata = skillMetadata(await readFile(path.join(root, "SKILL.md"), "utf8"), root);
      skills.push({ name: metadata.name, path: "." });
    } else if (await pathExists(path.join(root, "skills"))) {
      for (const entry of (await readdir(path.join(root, "skills"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillPath = `skills/${entry.name}`;
        const file = path.join(root, skillPath, "SKILL.md");
        if (!(await pathExists(file))) throw new Error(`Skill directory has no SKILL.md: ${file}`);
        const metadata = skillMetadata(await readFile(file, "utf8"), file);
        skills.push({ name: metadata.name, path: skillPath });
      }
    }
  }
  const sourceName = source.type === "local" ? path.basename(source.path) : path.posix.basename(source.subdirectory ?? source.url.replace(/\.git$/, ""));
  const name = nameSchema.parse(manifest.name ?? plugin?.name ?? (skills.length === 1 && skills[0]?.path === "." ? skills[0].name : sourceName.toLowerCase().replace(/[^a-z0-9._-]/g, "-")));
  if (name === "codex" || name === "claude") throw new Error(`Package name ${name} is reserved for a runtime`);
  if (manifest.name && plugin && manifest.name !== plugin.name) throw new Error("woma.yaml and the native plugin name must agree");
  if (manifest.version && nativeVersion && manifest.version !== nativeVersion) throw new Error("woma.yaml and the native plugin version must agree");
  const version = manifest.version ?? nativeVersion ?? `0.0.0+${integrity.slice(7, 19)}`;
  if (!plugin && skills.length === 0 && manifest.dependencies.length === 0) throw new Error(`Unsupported package layout at ${root}: expected SKILL.md, skills/, a native plugin, or a dependency collection`);
  if (new Set(skills.map((s) => s.name)).size !== skills.length) throw new Error(`Duplicate Skill names in ${name}`);
  if (new Set(manifest.dependencies.map((d) => d.name)).size !== manifest.dependencies.length) throw new Error(`Duplicate dependencies in ${name}`);
  const harnesses = manifest.harnesses ?? (plugin ? { [plugin.harness]: "*" } : { codex: "*", claude: "*" });
  if (plugin && Object.keys(harnesses).some((h) => h !== plugin.harness)) throw new Error(`Native ${plugin.harness} plugin cannot target another harness`);
  return { name, version, kind: plugin ? "plugin" : skills.length ? "skill" : "collection", source, integrity,
    dependencies: manifest.dependencies.map((d) => ({ ...d, source: dependencySource(d.source, source) })), harnesses, skills, ...(plugin ? { plugin } : {}),
  };
}

export async function resolvePackage(input: string, cwd = process.cwd()): Promise<InstalledPackage & { intent: string }> {
  const source = await materializeSource(input, cwd);
  try {
    if (await pathExists(path.join(source.root, ".woma/state.json")) || path.basename(source.root) === "home" && await pathExists(path.join(source.root, "../.woma/state.json"))) {
      throw new Error("An environment or native home is not a package source; install an individual Skill or Plugin directory");
    }
    const nativeHomes = [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.WOMA_PREFIX ? path.join(process.env.WOMA_PREFIX, "home") : undefined,
      path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".claude")].filter((v): v is string => Boolean(v));
    for (const home of nativeHomes) {
      if (source.root === await realpath(home).catch(() => path.resolve(home))) throw new Error("A native home is not a package source; install an individual Skill or Plugin directory");
    }
    for (const file of ["auth.json", ".credentials.json", "history.jsonl", "session_index.jsonl"]) {
      if (await pathExists(path.join(source.root, file))) throw new Error(`Native state cannot enter a package snapshot (${file}); install an individual Skill or Plugin directory`);
    }
    const layouts = ["SKILL.md", "skills", "woma.yaml", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
    if (!(await Promise.all(layouts.map((file) => pathExists(path.join(source.root, file))))).some(Boolean)) throw new Error(`Unsupported package layout at ${source.root}: expected SKILL.md, skills/, a native plugin, or a dependency collection`);
    // Describe the immutable snapshot so changes to a local source cannot race metadata validation.
    const cached = await publishContent(source.root);
    return { root: cached.root, record: await describePackage(cached.root, source.source, cached.integrity), intent: source.intent };
  } finally { await source.cleanup(); }
}

export async function loadPackage(record: PackageRecord, restore = false): Promise<InstalledPackage> {
  const root = cachePath(record.integrity);
  if (!(await pathExists(root))) {
    if (!restore || record.source.type !== "git") throw new Error(`Missing snapshot for ${record.name}@${record.version}: ${root}. Local snapshots cannot be reconstructed from a changed source.`);
    const restored = await resolvePackage(gitIntent({ url: record.source.url, ref: record.source.commit, subdirectory: record.source.subdirectory }));
    if (restored.record.integrity !== record.integrity) throw new Error(`Source integrity mismatch for ${record.name}`);
  }
  await verifyContent(root, record.integrity, true);
  if (record.source.type === "runtime") await verifyRuntimeIdentity(record, root);
  else {
    const actual = await describePackage(root, record.source, record.integrity);
    if (!isDeepStrictEqual(actual, record)) throw new Error(`Locked package metadata does not match its snapshot: ${record.name}`);
  }
  return { root, record };
}

export function assertCompatible(record: PackageRecord, harness: Harness, runtimeVersion: string): void {
  const constraint = record.harnesses[harness];
  if (!constraint || !satisfies(runtimeVersion, constraint, { includePrerelease: true })) throw new Error(`Package ${record.name} is incompatible with ${harness}@${runtimeVersion}`);
}

function checkDependency(dependency: Dependency, record: PackageRecord): void {
  if (record.name !== dependency.name || !satisfies(record.version, dependency.version, { includePrerelease: true })) throw new Error(`Dependency conflict: ${dependency.name} requires ${dependency.version}, resolved ${record.name}@${record.version}`);
  assertSourceIdentity(record, dependency.source);
}

export function assertSourceIdentity(record: PackageRecord, intent: string): void {
  const canonical = canonicalSource(intent);
  const git = gitLocator(canonical);
  const source = record.source;
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
  visit(lock.recipe.harness);
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
