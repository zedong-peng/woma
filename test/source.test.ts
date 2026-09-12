import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { create as tar } from "tar";
import { cachePath } from "../src/content.js";
import { createEnvironment, exportEnvironment, installPackages, readEnvironment, updatePackages } from "../src/environment.js";
import { commandOutput } from "../src/process.js";
import { resolvePackage } from "../src/package.js";
import { extractRuntimeArchive } from "../src/runtime.js";
import { canonicalSource } from "../src/source.js";
import { fixture, removeTestTree, skill } from "./helpers.js";

test("Git refs lock to commits and explicit recreation restores exact content", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.root, "repo"); await skill(repo, "review");
  async function git(...args: string[]) { return commandOutput("git", args, { cwd: repo }); }
  await git("init", "-b", "main"); await git("config", "user.name", "Woma Test"); await git("config", "user.email", "test@example.invalid");
  await git("add", "."); await git("commit", "-m", "initial");
  const initial = await git("rev-parse", "HEAD");
  const url = `git+${pathToFileURL(repo).href}#main`;
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  await installPackages(f.prefix, [url]);
  const old = (await readEnvironment(f.prefix)).lock.packages.review!;
  assert.equal(old.source.type === "git" ? old.source.commit : undefined, initial);
  const lockFile = path.join(f.root, "old.lock"); await writeFile(lockFile, await exportEnvironment(f.prefix, true));
  await writeFile(path.join(repo, "new.txt"), "new commit"); await git("add", "."); await git("commit", "-m", "change");
  await assert.rejects(installPackages(f.prefix, [url]), /already locked/);
  await updatePackages(f.prefix, ["review"]);
  assert.notEqual((await readEnvironment(f.prefix)).lock.packages.review!.integrity, old.integrity);
  await removeTestTree(cachePath(old.integrity));
  const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lockFile, provider: f.provider });
  assert.deepEqual((await readEnvironment(clone)).lock.packages.review, old);
  assert.equal(await readFile(path.join(clone, "home/skills/review/SKILL.md"), "utf8"), await readFile(path.join(repo, "SKILL.md"), "utf8"));
});

test("source snapshots reject links and unsupported source schemes", async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.root, "review"));
  await symlink("/tmp", path.join(source, "escape"));
  await assert.rejects(resolvePackage(source), /Unsupported package file/);
  assert.throws(() => canonicalSource("builtin:review"), /Unsupported source/);
  assert.throws(() => canonicalSource("https://user:secret@example.invalid/repo.git"), /must not contain credentials/);
  assert.throws(() => canonicalSource("https://example.invalid/repo.git#--upload-pack=bad"), /Unsafe Git ref/);
});

test("runtime archive extraction rejects links before extracting any content", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "archive"); await mkdir(path.join(source, "package"), { recursive: true });
  await writeFile(path.join(source, "package/package.json"), "{}");
  await symlink("../../outside", path.join(source, "package/link"));
  const file = path.join(f.root, "runtime.tgz"); await tar({ file, cwd: source, gzip: true }, ["package"]);
  await assert.rejects(extractRuntimeArchive(file, path.join(f.root, "unpacked")), /Unsafe runtime archive entry/);
  await rm(path.join(source, "package/link"));
  await tar({ file, cwd: source, gzip: true }, ["package"]);
  await extractRuntimeArchive(file, path.join(f.root, "valid"));
  assert.equal(await readFile(path.join(f.root, "valid/package.json"), "utf8"), "{}");
});
