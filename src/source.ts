import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertInside } from "./fs.js";
import { commandOutput } from "./process.js";
import { relativePath } from "./schema.js";
import type { PackageSource } from "./types.js";

export interface GitLocator { url: string; ref?: string | undefined; subdirectory?: string | undefined }
export interface MaterializedSource { root: string; source: Exclude<PackageSource, { type: "runtime" }>; intent: string; cleanup: () => Promise<void> }

export function gitLocator(input: string): GitLocator | undefined {
  const [locator, fragment, ...extra] = input.split("#");
  if (!locator || extra.length) throw new Error(`Invalid source: ${input}`);
  let url = locator.replace(/^git\+/, "");
  const shorthand = /^(?:gh|github):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(url);
  if (shorthand) url = `https://github.com/${shorthand[1]!.replace(/\.git$/, "")}.git`;
  else if (!/^(?:https?:\/\/|ssh:\/\/|git@)/.test(url) && !input.startsWith("git+file:")) return undefined;
  if (/[\x00-\x20\x7f]/.test(url)) throw new Error(`Unsafe Git URL: ${url}`);
  if (/^https?:/.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error("Git URLs must not contain credentials; use Git's credential helper");
  }
  const [ref, subdirectory, ...rest] = (fragment ?? "").split("::");
  if (rest.length || (ref && (/^[\s-]/.test(ref) || /[\x00-\x20\x7f]/.test(ref)))) throw new Error(`Unsafe Git ref: ${ref}`);
  if (subdirectory) relativePath.parse(subdirectory);
  return { url, ...(ref ? { ref } : {}), ...(subdirectory ? { subdirectory } : {}) };
}

export function gitIntent(git: GitLocator): string {
  return `${git.url.startsWith("file:") ? "git+" : ""}${git.url}${git.ref || git.subdirectory ? `#${git.ref ?? ""}` : ""}${git.subdirectory ? `::${git.subdirectory}` : ""}`;
}

export function canonicalSource(input: string, cwd = process.cwd()): string {
  const git = gitLocator(input);
  if (git) return gitIntent(git);
  if (/^[a-z][a-z0-9+.-]*:/.test(input) && !input.startsWith("file:")) throw new Error(`Unsupported source ${input}; use a local directory or Git`);
  return `file:${path.resolve(cwd, input.startsWith("file://") ? fileURLToPath(input) : input.replace(/^file:/, ""))}`;
}

export function dependencySource(input: string, parent: Exclude<PackageSource, { type: "runtime" }>): string {
  if (parent.type === "local") return canonicalSource(input, parent.path);
  const remote = gitLocator(input);
  if (remote) return gitIntent(remote);
  if (!input.startsWith("./") && !input.startsWith("../")) throw new Error(`Git dependencies must be Git URLs or repository-relative paths: ${input}`);
  const subdirectory = path.posix.normalize(path.posix.join(parent.subdirectory ?? ".", input));
  relativePath.parse(subdirectory);
  return gitIntent({ url: parent.url, ref: parent.commit, subdirectory });
}

export async function materializeSource(input: string, cwd = process.cwd()): Promise<MaterializedSource> {
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
  const temp = await mkdtemp(path.join(os.tmpdir(), "woma-git-"));
  const cleanup = () => rm(temp, { recursive: true, force: true });
  try {
    await commandOutput("git", ["init", "--", temp]);
    await commandOutput("git", ["-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "--", git.url, git.ref ?? "HEAD"], { cwd: temp });
    await commandOutput("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "FETCH_HEAD"], { cwd: temp });
    const commit = await commandOutput("git", ["rev-parse", "HEAD"], { cwd: temp });
    if (/^[a-f0-9]{40,64}$/.test(git.ref ?? "") && commit !== git.ref) throw new Error(`Git commit mismatch: expected ${git.ref}, got ${commit}`);
    const root = path.join(temp, git.subdirectory ?? ".");
    const tracked = await commandOutput("git", ["ls-files", "--stage", "--", git.subdirectory ?? "."], { cwd: temp });
    if (/^160000 /m.test(tracked)) throw new Error("Git submodules are not supported in package snapshots; supply complete local content or explicit package dependencies");
    const info = await lstat(root).catch(() => { throw new Error(`Git subdirectory missing: ${git.subdirectory}`); });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Git subdirectory is not an ordinary directory: ${root}`);
    assertInside(await realpath(temp), await realpath(root), "Git subdirectory");
    return { root, source: { type: "git", url: git.url, commit, ...(git.subdirectory ? { subdirectory: git.subdirectory } : {}) }, intent, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
