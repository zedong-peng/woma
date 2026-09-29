import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cachePath } from "../src/content.js";
import { createEnvironment, exportEnvironment, installPackages, readEnvironment, updatePackages } from "../src/environment.js";
import { commandOutput } from "../src/process.js";
import { resolvePackage } from "../src/package.js";
import { searchSkills } from "../src/registry.js";
import { canonicalSource, gitIntent, gitLocator } from "../src/source.js";
import { fixture, plugin, removeTestTree, skill } from "./helpers.js";

test("source spellings: GitHub paths, browser URLs, refs, and NAME@repository", () => {
  const repo = "https://github.com/anthropics/skills.git";
  assert.deepEqual(gitLocator("gh:anthropics/skills"), { url: repo });
  assert.deepEqual(gitLocator("gh:anthropics/skills/skills/pdf#v1.0"), { url: repo, ref: "v1.0", subdirectory: "skills/pdf" });
  assert.deepEqual(gitLocator("gh:anthropics/skills#main::skills/pdf"), { url: repo, ref: "main", subdirectory: "skills/pdf" });
  assert.deepEqual(gitLocator("https://github.com/anthropics/skills/tree/main/skills/pdf"), { url: repo, ref: "main", subdirectory: "skills/pdf" });
  assert.deepEqual(gitLocator("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"), { url: repo, ref: "main", subdirectory: "skills/pdf" });
  assert.deepEqual(gitLocator("https://github.com/anthropics/skills"), { url: repo });
  assert.deepEqual(gitLocator("pdf@anthropics/skills"), { url: repo, select: "pdf" });
  assert.deepEqual(gitLocator("pdf@anthropics/skills#v1.0"), { url: repo, ref: "v1.0", select: "pdf" });
  assert.deepEqual(gitLocator("https://skills.sh/anthropics/skills/pdf"), { url: repo, select: "pdf" });
  assert.deepEqual(gitLocator("code-review@gh:anthropics/claude-plugins-official"), { url: "https://github.com/anthropics/claude-plugins-official.git", select: "code-review" });
  assert.deepEqual(gitLocator("git@github.com:owner/repo.git"), { url: "git@github.com:owner/repo.git" });
  assert.deepEqual(gitLocator("review@git+file:///srv/repo#main"), { url: "file:///srv/repo", ref: "main", select: "review" });
  assert.equal(gitLocator("./examples/review"), undefined);
  for (const input of ["gh:anthropics/skills/skills/pdf#v1.0", "pdf@anthropics/skills#main", "review@git+file:///srv/repo#main::skills", "git@github.com:owner/repo.git#main"]) {
    assert.equal(canonicalSource(canonicalSource(input)), canonicalSource(input));
    assert.deepEqual(gitLocator(gitIntent(gitLocator(input)!)), gitLocator(input));
  }
  assert.equal(canonicalSource("https://github.com/anthropics/skills/tree/main/skills/pdf"), "gh:anthropics/skills/skills/pdf#main");
});

test("Git refs lock to commits and explicit recreation restores exact content", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.root, "repo"); await skill(repo, "review");
  async function git(...args: string[]) { return commandOutput("git", args, { cwd: repo }); }
  await git("init", "-b", "main"); await git("config", "user.name", "Woma Test"); await git("config", "user.email", "test@example.invalid");
  await git("add", "."); await git("commit", "-m", "initial");
  const initial = await git("rev-parse", "HEAD");
  const url = `git+${pathToFileURL(repo).href}#main`;
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  await installPackages(f.prefix, [url]);
  const old = (await readEnvironment(f.prefix)).lock.packages.review!;
  assert.equal(old.source.type === "git" ? old.source.commit : undefined, initial);
  const lockFile = path.join(f.root, "old.lock"); await writeFile(lockFile, (await exportEnvironment(f.prefix, { explicit: true })).content);
  await writeFile(path.join(repo, "new.txt"), "new commit"); await git("add", "."); await git("commit", "-m", "change");
  await assert.rejects(installPackages(f.prefix, [url]), /already installed/);
  await updatePackages(f.prefix, ["review"]);
  assert.notEqual((await readEnvironment(f.prefix)).lock.packages.review!.integrity, old.integrity);
  await removeTestTree(cachePath(old.integrity));
  const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lockFile });
  assert.deepEqual((await readEnvironment(clone)).lock.packages.review, old);
  assert.equal(await readFile(path.join(clone, "home/codex/skills/review/SKILL.md"), "utf8"), await readFile(path.join(repo, "SKILL.md"), "utf8"));
});

test("NAME@repository resolves Claude marketplaces, Codex marketplaces, and Skill names to locked commits", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.root, "catalog");
  await skill(path.join(repo, "skills/.curated/review"), "review");
  await skill(path.join(repo, "template"), "template-skill");
  await plugin(path.join(repo, "plugins/native"), "claude", "native");
  await plugin(path.join(repo, "codex-plugins/helper"), "codex", "helper");
  await mkdir(path.join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(repo, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "catalog", plugins: [
    { name: "native", source: "./plugins/native" },
    { name: "lsp-only", source: "./plugins/native", strict: false, lspServers: { x: { command: "x" } } },
    { name: "partial-bundle", source: "./", strict: false, skills: ["./skills/.curated/review"] },
    { name: "pair", source: "./pair", strict: false, skills: ["./skills/one", "./skills/two"] },
  ] }));
  await skill(path.join(repo, "pair/skills/one"), "one"); await skill(path.join(repo, "pair/skills/two"), "two");
  await mkdir(path.join(repo, ".agents/plugins"), { recursive: true });
  await writeFile(path.join(repo, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "catalog", plugins: [{ name: "helper", source: { source: "local", path: "./codex-plugins/helper" } }] }));
  async function git(...args: string[]) { return commandOutput("git", args, { cwd: repo }); }
  await git("init", "-b", "main"); await git("config", "user.name", "Woma Test"); await git("config", "user.email", "test@example.invalid");
  await git("add", "."); await git("commit", "-m", "initial");
  const commit = await git("rev-parse", "HEAD");
  const base = `git+${pathToFileURL(repo).href}`;
  const review = await resolvePackage(`review@${base}`);
  assert.equal(review.record.kind, "skill");
  assert.deepEqual(review.record.source, { type: "git", url: pathToFileURL(repo).href, commit, subdirectory: "skills/.curated/review" });
  assert.equal(review.intent, `review@${base}`);
  assert.equal((await resolvePackage(`native@${base}`)).record.plugin?.harness, "claude");
  assert.equal((await resolvePackage(`helper@${base}#main`)).record.plugin?.harness, "codex");
  await assert.rejects(resolvePackage(`lsp-only@${base}`), /defined by marketplace fields \(lspServers\)/);
  await assert.rejects(resolvePackage(`missing@${base}`), /No Skill or plugin named missing.*Available: one, two, review, template-skill/);
  await assert.rejects(resolvePackage(`partial-bundle@${base}`), /marketplace bundle of selected Skills; install them individually: woma install review@git\+file:/);
  assert.deepEqual((await resolvePackage(`pair@${base}`)).record.skills.map((s) => s.name), ["one", "two"]);

  await createEnvironment({ prefix: f.prefix }, { agents: ["claude", "codex"] });
  await installPackages(f.prefix, [`review@${base}`, `native@${base}`]);
  const recipe = (await readEnvironment(f.prefix)).lock.recipe.packages;
  assert.deepEqual(recipe.map((p) => p.source), [`review@${base}`, `native@${base}`]);
  await writeFile(path.join(repo, "skills/.curated/review/extra.md"), "newer\n"); await git("add", "."); await git("commit", "-m", "newer");
  await updatePackages(f.prefix, ["review"]);
  assert.equal(await readFile(path.join(f.prefix, "home/codex/skills/review/extra.md"), "utf8"), "newer\n");
});

test("skills.sh search results become NAME@owner/repo install sources", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.match(String(input), /\/api\/search\?q=pdf&limit=3$/);
    return Response.json({ skills: [
      { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 202214 },
      { id: "mintlify/bun.com/bun", source: "mintlify/bun.com", skillId: "bun", name: "bun", installs: 10 },
      { id: "x/y/Bad Name", source: "x/y", skillId: "Bad Name", installs: 1 },
    ] });
  });
  assert.deepEqual(await searchSkills("pdf", 3), [
    { name: "pdf", source: "anthropics/skills", installs: 202214, install: "pdf@anthropics/skills" },
    { name: "bun", source: "mintlify/bun.com", installs: 10, install: "bun@mintlify/bun.com" },
  ]);
});

test("source snapshots reject links and unsupported source schemes", async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.root, "review"));
  await symlink("/tmp", path.join(source, "escape"));
  await assert.rejects(resolvePackage(source), /Unsupported package file/);
  assert.throws(() => canonicalSource("builtin:review"), /Unsupported source/);
  assert.throws(() => canonicalSource("https://user:secret@example.invalid/repo.git"), /must not contain credentials/);
  assert.throws(() => canonicalSource("https://example.invalid/repo.git#--upload-pack=bad"), /Unsafe Git ref/);
  assert.throws(() => canonicalSource("gh:owner/repo/../escape"), /Unsafe relative path|escape/);
});
