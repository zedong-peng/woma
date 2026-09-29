import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { assertInside, pathExists } from "./fs.js";
import { relativePath } from "./schema.js";
import { checkout, checkoutDirectory, gitIntent, type Checkout, type GitLocator } from "./source.js";

export interface Selection { url: string; commit: string; subdirectory?: string | undefined; root: string; cleanup?: () => Promise<void> }

type MarketplaceSource = string | { source?: string; repo?: string; url?: string; path?: string; ref?: string; sha?: string };
interface MarketplaceEntry { name?: string; source?: MarketplaceSource; strict?: boolean; [key: string]: unknown }

const unsupportedEntryFields = ["commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles"];

function normalizeRelative(base: string, target: string, label: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(base || ".", target));
  if (joined === "." || joined === "./") return undefined;
  const cleaned = joined.replace(/^\.\//, "").replace(/\/$/, "");
  if (!relativePath.safeParse(cleaned).success) throw new Error(`${label} escapes its repository: ${target}`);
  return cleaned;
}

async function readManifest(file: string): Promise<{ plugins?: MarketplaceEntry[]; metadata?: { pluginRoot?: string } } | undefined> {
  if (!(await pathExists(file))) return undefined;
  const value = JSON.parse(await readFile(file, "utf8")) as { plugins?: unknown };
  if (!Array.isArray(value.plugins)) throw new Error(`Invalid marketplace manifest: ${file}`);
  return value as { plugins: MarketplaceEntry[] };
}

async function located(checkedOut: Checkout, url: string, subdirectory: string | undefined, cleanup?: () => Promise<void>): Promise<Selection> {
  return { url, commit: checkedOut.commit, subdirectory, root: await checkoutDirectory(checkedOut, subdirectory), ...(cleanup ? { cleanup } : {}) };
}

/** The Skill directories a plain directory installs as, mirroring package layout detection. */
async function detectedSkills(root: string): Promise<string[]> {
  if (await pathExists(path.join(root, "SKILL.md"))) return ["."];
  const base = await pathExists(path.join(root, "skills")) ? "skills" : "";
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, base), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && await pathExists(path.join(root, base, entry.name, "SKILL.md"))) found.push(base ? `${base}/${entry.name}` : entry.name);
  }
  return found.sort();
}

/** A strict:false entry that lists Skills installs only if its directory holds exactly those Skills. */
async function assertSkillBundle(selection: Selection, entry: MarketplaceEntry, name: string, label: string): Promise<void> {
  if (entry.strict !== false || !Array.isArray(entry.skills)) return;
  const listed = (entry.skills as unknown[]).map((item) => typeof item === "string" ? normalizeRelative("", item, label) ?? "." : "?").sort();
  if (JSON.stringify(listed) === JSON.stringify(await detectedSkills(selection.root))) return;
  const names = listed.map((item) => path.posix.basename(item));
  throw new Error(`${name} in ${label} is a marketplace bundle of selected Skills; install them individually: woma install ${names.map((skill) => gitIntent({ url: selection.url, select: skill })).join(" ")}`);
}

async function marketplaceSelection(checkedOut: Checkout, git: GitLocator, entry: MarketplaceEntry, marketplaceRoot: string, pluginRoot: string | undefined, label: string): Promise<Selection> {
  const name = git.select!;
  if (entry.strict === false) {
    const extra = unsupportedEntryFields.filter((field) => entry[field] !== undefined);
    if (extra.length) throw new Error(`${name} in ${label} is defined by marketplace fields (${extra.join(", ")}); Woma installs only plugins with their own manifest or plain Skills`);
  }
  const source = entry.source;
  if (typeof source === "string") {
    const base = pluginRoot && !source.startsWith("./") && !source.startsWith("../") ? normalizeRelative(marketplaceRoot, pluginRoot, label) ?? "" : marketplaceRoot;
    const selection = await located(checkedOut, git.url, normalizeRelative(base, source, label));
    await assertSkillBundle(selection, entry, name, label);
    return selection;
  }
  if (!source || typeof source !== "object") throw new Error(`Invalid source for ${name} in ${label}`);
  let url: string;
  if (source.source === "github" && source.repo) url = `https://github.com/${source.repo.replace(/\.git$/, "")}.git`;
  else if ((source.source === "url" || source.source === "git" || source.source === "git-subdir") && source.url) url = source.url;
  else throw new Error(`${name} in ${label} uses an unsupported source type (${source.source ?? "unknown"}); install it from its Git repository instead`);
  const ref = source.sha ?? source.ref;
  const remote = await checkout(url, ref);
  try {
    const selection = await located(remote, url, source.path ? normalizeRelative("", source.path, label) : undefined, remote.cleanup);
    await assertSkillBundle(selection, entry, name, label);
    return selection;
  } catch (error) { await remote.cleanup(); throw error; }
}

async function skillDirectories(root: string, relative = "", depth = 0, found: { path: string; names: string[] }[] = []): Promise<{ path: string; names: string[] }[]> {
  const directory = path.join(root, relative);
  if (await pathExists(path.join(directory, "SKILL.md"))) {
    const names = [path.basename(relative || root)];
    try {
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(path.join(directory, "SKILL.md"), "utf8"));
      const name = (parseYaml(match?.[1] ?? "") as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.unshift(name);
    } catch { /* The directory name still identifies Skills with malformed frontmatter. */ }
    found.push({ path: relative, names });
    return found;
  }
  if (depth >= 6) return found;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || [".git", "node_modules"].includes(entry.name)) continue;
    await skillDirectories(root, relative ? `${relative}/${entry.name}` : entry.name, depth + 1, found);
  }
  return found;
}

/** Resolve `NAME@repository` to a concrete package directory inside a fetched commit. */
export async function resolveSelection(checkedOut: Checkout, git: GitLocator): Promise<Selection> {
  const name = git.select!;
  const scope = git.subdirectory ?? "";
  const scopeRoot = await checkoutDirectory(checkedOut, git.subdirectory);
  const label = `${git.url}${scope ? `/${scope}` : ""}`;
  for (const manifest of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    const data = await readManifest(path.join(scopeRoot, manifest));
    const entries = data?.plugins?.filter((p) => p.name === name) ?? [];
    if (entries.length > 1) throw new Error(`Marketplace ${label} lists ${name} more than once`);
    if (entries[0]) {
      const entry = entries[0];
      // Codex marketplaces wrap local paths as { source: "local", path }.
      if (typeof entry.source === "object" && entry.source?.source === "local" && entry.source.path) entry.source = entry.source.path;
      return marketplaceSelection(checkedOut, git, entry, scope, data?.metadata?.pluginRoot, label);
    }
  }
  const candidates = await skillDirectories(scopeRoot);
  let matches = candidates.filter((c) => c.names[0] === name);
  if (!matches.length) matches = candidates.filter((c) => c.names.includes(name));
  if (matches.length > 1) throw new Error(`Several Skills named ${name} in ${label}: ${matches.map((m) => m.path || ".").join(", ")}. Install one with gh:OWNER/REPO/PATH`);
  if (!matches[0]) {
    const available = candidates.map((c) => c.names[0]).slice(0, 12);
    throw new Error(`No Skill or plugin named ${name} in ${label}${available.length ? `. Available: ${available.join(", ")}${candidates.length > 12 ? ", ..." : ""}` : ""}`);
  }
  const target = path.join(scopeRoot, matches[0].path);
  assertInside(await realpath(checkedOut.root), await realpath(target), "Skill directory");
  if ((await lstat(target)).isSymbolicLink()) throw new Error(`Skill directory is a symlink: ${target}`);
  return located(checkedOut, git.url, normalizeRelative(scope, matches[0].path, label));
}

export interface SearchResult { name: string; source: string; installs: number; install: string }

/** Query the public skills.sh directory. Results name Skills as NAME@owner/repo install sources. */
export async function searchSkills(query: string, limit = 10): Promise<SearchResult[]> {
  const base = process.env.WOMA_SKILLS_API ?? "https://skills.sh";
  const url = `${base}/api/search?${new URLSearchParams({ q: query, limit: String(limit) })}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((error: Error) => { throw new Error(`skills.sh search failed: ${error.message}`); });
  if (!response.ok) throw new Error(`skills.sh search failed (HTTP ${response.status})`);
  const data = await response.json() as { skills?: { skillId?: unknown; name?: unknown; source?: unknown; installs?: unknown }[] };
  const results: SearchResult[] = [];
  for (const skill of data.skills ?? []) {
    const name = typeof skill.skillId === "string" ? skill.skillId : typeof skill.name === "string" ? skill.name : undefined;
    const source = typeof skill.source === "string" ? skill.source : undefined;
    if (!name || !source || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) continue;
    results.push({ name, source, installs: typeof skill.installs === "number" ? skill.installs : 0, install: `${name}@${source}` });
  }
  return results.sort((a, b) => b.installs - a.installs);
}
