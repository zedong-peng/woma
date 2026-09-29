import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertInside } from "./fs.js";
import { commandOutput } from "./process.js";
import { relativePath } from "./schema.js";
import type { GitOrigin, PackageSource } from "./types.js";

/**
 * A Git package location. `select` names a Skill or Plugin inside the repository
 * (`NAME@owner/repo`), resolved through marketplace manifests or SKILL.md names.
 */
export interface GitLocator { url: string; ref?: string | undefined; subdirectory?: string | undefined; select?: string | undefined }
export interface MaterializedSource {
  root: string;
  source: PackageSource;
  intent: string;
  origin?: GitOrigin | undefined;
  cleanup: () => Promise<void>;
}

const githubPart = /^[A-Za-z0-9_.-]+$/;
const selectName = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function githubUrl(owner: string, repo: string): string {
  if (!githubPart.test(owner) || !githubPart.test(repo) || [owner, repo].some((p) => p === "." || p === "..")) throw new Error(`Invalid GitHub repository: ${owner}/${repo}`);
  return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`;
}

function githubParts(url: string): { owner: string; repo: string } | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\.git$/.exec(url);
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

function checkRef(ref: string | undefined): string | undefined {
  if (ref === undefined || ref === "") return undefined;
  if (/^[\s-]/.test(ref) || /[\x00-\x20\x7f]/.test(ref) || ref.includes("..")) throw new Error(`Unsafe Git ref: ${ref}`);
  return ref;
}

function checkSubdirectory(subdirectory: string | undefined): string | undefined {
  if (subdirectory === undefined || subdirectory === "" || subdirectory === ".") return undefined;
  const normalized = subdirectory.replace(/\/+$/, "");
  relativePath.parse(normalized);
  return normalized;
}

function locator(url: string, ref?: string, subdirectory?: string, select?: string): GitLocator {
  if (/[\x00-\x20\x7f]/.test(url)) throw new Error(`Unsafe Git URL: ${url}`);
  if (/^https?:/.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error("Git URLs must not contain credentials; use Git's credential helper");
  }
  const checkedRef = checkRef(ref);
  const checkedSubdirectory = checkSubdirectory(subdirectory);
  return { url, ...(checkedRef ? { ref: checkedRef } : {}), ...(checkedSubdirectory ? { subdirectory: checkedSubdirectory } : {}), ...(select ? { select } : {}) };
}

/** Parse a repository location without a selected name. */
function repositoryLocator(input: string): GitLocator | undefined {
  // gh:owner/repo[/sub/dir][#ref], also the older gh:owner/repo#ref::subdir form.
  const shorthand = /^(?:gh|github):([^#]+)(?:#(.*))?$/.exec(input);
  if (shorthand) {
    const [owner, repo, ...rest] = shorthand[1]!.split("/");
    if (!owner || !repo) throw new Error(`Invalid GitHub source: ${input}; use gh:owner/repo[/path][#ref]`);
    const [ref, legacySubdirectory, ...extra] = (shorthand[2] ?? "").split("::");
    if (extra.length || (rest.length && legacySubdirectory)) throw new Error(`Invalid GitHub source: ${input}`);
    return locator(githubUrl(owner, repo), ref, rest.length ? rest.join("/") : legacySubdirectory);
  }
  if (/^https:\/\/github\.com\//.test(input) && !/\.git(?:#|$)/.test(input.split("#")[0]! + "#")) {
    // Browser URLs: https://github.com/owner/repo[/tree|blob/REF/path]
    const [base, fragment] = input.split("#");
    const parsed = new URL(base!);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid GitHub URL: ${input}`);
    let ref = fragment;
    let subdirectory: string | undefined;
    if (parts.length > 2) {
      if (!["tree", "blob"].includes(parts[2]!) || parts.length < 4) throw new Error(`Unsupported GitHub URL: ${input}; use https://github.com/owner/repo/tree/REF/path`);
      if (fragment) throw new Error(`Specify the ref once: ${input}`);
      ref = parts[3];
      const rest = parts.slice(4);
      if (parts[2] === "blob" && rest.at(-1) === "SKILL.md") rest.pop();
      subdirectory = rest.join("/");
    }
    return locator(githubUrl(parts[0]!, parts[1]!), ref, subdirectory);
  }
  const [base, fragment, ...extra] = input.split("#");
  if (!base || extra.length) throw new Error(`Invalid source: ${input}`);
  let url = base.replace(/^git\+/, "");
  if (!/^(?:https?:\/\/|ssh:\/\/|git@)/.test(url) && !input.startsWith("git+file:")) return undefined;
  if (/^https:\/\/github\.com\//.test(url)) {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length === 2) url = githubUrl(parts[0]!, parts[1]!);
  }
  const [ref, subdirectory, ...rest] = (fragment ?? "").split("::");
  if (rest.length) throw new Error(`Invalid Git source: ${input}`);
  return locator(url, ref, subdirectory);
}

export function gitLocator(input: string): GitLocator | undefined {
  // https://skills.sh/owner/repo/skill
  const directory = /^https:\/\/(?:www\.)?skills\.sh\/([^/#?]+)\/([^/#?]+)\/([^/#?]+)\/?$/.exec(input);
  if (directory) {
    if (!selectName.test(directory[3]!)) throw new Error(`Invalid Skill name in ${input}`);
    return { ...locator(githubUrl(directory[1]!, directory[2]!)), select: directory[3]! };
  }
  // NAME@owner/repo[#ref] or NAME@<any repository source>
  const named = /^([^@/:#\s]+)@(.+)$/.exec(input);
  if (named && !/^[^/]+:/.test(named[2]!)) {
    const name = named[1]!;
    if (!selectName.test(name)) throw new Error(`Invalid package name before @: ${name}`);
    const rest = named[2]!;
    const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(.*))?$/.exec(rest);
    const repository = shorthand ? locator(githubUrl(shorthand[1]!, shorthand[2]!), shorthand[3]) : repositoryLocator(rest);
    if (!repository) throw new Error(`Invalid repository in ${input}; use NAME@owner/repo`);
    return { ...repository, select: name };
  }
  if (named && /^(?:gh|github|https?|ssh|git\+file):/.test(named[2]!) && selectName.test(named[1]!)) {
    const repository = repositoryLocator(named[2]!);
    if (repository) return { ...repository, select: named[1]! };
  }
  return repositoryLocator(input);
}

/** Render a locator in its canonical, human-readable form. Parsing the result yields the same locator. */
export function gitIntent(git: GitLocator): string {
  const github = githubParts(git.url);
  const ref = git.ref ? `#${git.ref}` : "";
  if (github) {
    if (git.select && !git.subdirectory) return `${git.select}@${github.owner}/${github.repo}${ref}`;
    return `${git.select ? `${git.select}@` : ""}gh:${github.owner}/${github.repo}${git.subdirectory ? `/${git.subdirectory}` : ""}${ref}`;
  }
  const url = `${git.url.startsWith("file:") ? "git+" : ""}${git.url}`;
  return `${git.select ? `${git.select}@` : ""}${url}${git.ref || git.subdirectory ? `#${git.ref ?? ""}` : ""}${git.subdirectory ? `::${git.subdirectory}` : ""}`;
}

export function canonicalSource(input: string, cwd = process.cwd()): string {
  const git = gitLocator(input);
  if (git) return gitIntent(git);
  if (/^[a-z][a-z0-9+.-]*:/.test(input) && !input.startsWith("file:")) throw new Error(`Unsupported source ${input}; use a local directory, gh:owner/repo[/path], NAME@owner/repo, or a Git URL`);
  const local = input.startsWith("file://") ? fileURLToPath(input) : input.replace(/^file:/, "");
  return `file:${path.resolve(cwd, local.startsWith("~/") ? path.join(os.homedir(), local.slice(2)) : local)}`;
}

export function dependencySource(input: string, parent: PackageSource): string {
  if (parent.type === "local") return canonicalSource(input, parent.path);
  const remote = gitLocator(input);
  if (remote) return gitIntent(remote);
  if (!input.startsWith("./") && !input.startsWith("../")) throw new Error(`Git dependencies must be Git sources or repository-relative paths: ${input}`);
  const subdirectory = path.posix.normalize(path.posix.join(parent.subdirectory ?? ".", input));
  relativePath.parse(subdirectory);
  return gitIntent({ url: parent.url, ref: parent.commit, subdirectory });
}

export interface Checkout { root: string; commit: string; cleanup: () => Promise<void> }

/** Fetch one commit of a repository into a temporary directory. */
export async function checkout(url: string, ref?: string): Promise<Checkout> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "woma-git-"));
  const cleanup = () => rm(temp, { recursive: true, force: true });
  try {
    await commandOutput("git", ["init", "--quiet", "--", temp]);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    await commandOutput("git", ["-c", "core.hooksPath=/dev/null", "fetch", "--quiet", "--depth=1", "--", url, ref ?? "HEAD"], { cwd: temp, env }).catch((error: Error) => {
      throw new Error(`Cannot fetch ${url}${ref ? ` at ${ref}` : ""}: ${error.message.split("\n").at(-1)}`);
    });
    await commandOutput("git", ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: temp });
    const commit = await commandOutput("git", ["rev-parse", "HEAD"], { cwd: temp });
    if (/^[a-f0-9]{40,64}$/.test(ref ?? "") && commit !== ref) throw new Error(`Git commit mismatch: expected ${ref}, got ${commit}`);
    return { root: temp, commit, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function checkoutDirectory(checkedOut: Checkout, subdirectory: string | undefined): Promise<string> {
  const root = path.join(checkedOut.root, subdirectory ?? ".");
  const tracked = await commandOutput("git", ["ls-files", "--stage", "--", subdirectory ?? "."], { cwd: checkedOut.root });
  if (/^160000 /m.test(tracked)) throw new Error("Git submodules are not supported in package snapshots; supply complete local content or explicit package dependencies");
  const info = await lstat(root).catch(() => { throw new Error(`Git subdirectory missing: ${subdirectory}`); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Git subdirectory is not an ordinary directory: ${subdirectory}`);
  assertInside(await realpath(checkedOut.root), await realpath(root), "Git subdirectory");
  return root;
}

export async function materializeSource(input: string, cwd = process.cwd(), resolveSelection?: (checkedOut: Checkout, git: GitLocator) => Promise<{ url: string; commit: string; subdirectory?: string | undefined; root: string; cleanup?: () => Promise<void> }>): Promise<MaterializedSource> {
  const intent = canonicalSource(input, cwd);
  const git = gitLocator(intent);
  if (!git) {
    let root = intent.slice(5);
    const info = await lstat(root).catch(() => { throw new Error(`Local source does not exist: ${root}`); });
    if (info.isFile() && path.basename(root) === "SKILL.md") root = path.dirname(root);
    else if (!info.isDirectory()) throw new Error(`Package source must be a directory or SKILL.md: ${root}`);
    root = await realpath(root);
    return { root, source: { type: "local", path: root }, intent: `file:${root}`, cleanup: async () => {} };
  }
  const checkedOut = await checkout(git.url, git.ref);
  try {
    if (git.select) {
      if (!resolveSelection) throw new Error(`Named sources are not supported here: ${intent}`);
      const selected = await resolveSelection(checkedOut, git);
      const cleanup = async () => { await selected.cleanup?.(); await checkedOut.cleanup(); };
      return { root: selected.root, source: { type: "git", url: selected.url, commit: selected.commit, ...(selected.subdirectory ? { subdirectory: selected.subdirectory } : {}) }, intent, cleanup };
    }
    const root = await checkoutDirectory(checkedOut, git.subdirectory);
    return { root, source: { type: "git", url: git.url, commit: checkedOut.commit, ...(git.subdirectory ? { subdirectory: git.subdirectory } : {}) }, intent, cleanup: checkedOut.cleanup };
  } catch (error) { await checkedOut.cleanup(); throw error; }
}

/** Convert common remote spellings to a URL others can fetch without SSH keys. */
export function portableRemote(url: string): string | undefined {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (scp) return githubUrl(scp[1]!, scp[2]!);
  const ssh = /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (ssh) return githubUrl(ssh[1]!, ssh[2]!);
  if (/^https:\/\/github\.com\//.test(url)) {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length === 2) return githubUrl(parts[0]!, parts[1]!.replace(/\.git$/, ""));
  }
  if (/^(?:https:\/\/|ssh:\/\/|git@)/.test(url)) {
    try { if (/^https:/.test(url) && (new URL(url).username || new URL(url).password)) return undefined; } catch { return undefined; }
    return url;
  }
  return undefined;
}
