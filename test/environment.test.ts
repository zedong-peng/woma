import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { cachePath } from "../src/content.js";
import { createEnvironment, doctorEnvironment, exportEnvironment, installPackages, listEnvironments, readEnvironment, removePackages, selectPrefix, updatePackages } from "../src/environment.js";
import { originalEnvironment, selectedEnvironment } from "../src/selection.js";
import { fixture, plugin, removeTestTree, skill } from "./helpers.js";

const lockText = async (prefix: string) => (await exportEnvironment(prefix, { explicit: true })).content;

test("environments use the installed agent and locks recreate managed content", async (t) => {
  const f = await fixture(t);
  const first = await createEnvironment({ name: "first" }, { agents: ["codex"] });
  assert.deepEqual((await readdir(first)).sort(), [".woma", "home"]);
  await assert.rejects(installPackages(first, ["codex@0.154.0"]), /does not manage its version/);
  await assert.rejects(updatePackages(first, ["codex"]), /does not manage codex's version/);
  const source = await skill(path.join(f.root, "review"));
  await installPackages(first, [source]);
  await writeFile(path.join(first, "home/codex/auth.json"), '"credential sentinel"');
  await writeFile(path.join(first, "home/codex/session.json"), '"session sentinel"');
  const explicit = await lockText(first);
  assert.doesNotMatch(explicit, /credential sentinel|session sentinel/);
  const lockFile = path.join(f.root, "woma.lock"); await writeFile(lockFile, explicit);
  await removeTestTree(source);
  const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lockFile });
  assert.deepEqual((await readEnvironment(clone)).lock.packages, (await readEnvironment(first)).lock.packages);
  assert.equal(await readFile(path.join(clone, "home/codex/skills/review/references/note.txt"), "utf8"), "Complete reference content\n");
  assert.deepEqual(await readdir(path.join(clone, "home")), ["codex"]);
  assert.deepEqual(await readdir(path.join(clone, "home/codex")), ["skills"]);
  const recipe = parseYaml((await exportEnvironment(first)).content);
  assert.deepEqual(recipe.agents, ["codex"]); assert.deepEqual(recipe.packages, [source]);
  assert.deepEqual(await doctorEnvironment(first), []);
});

test("read-only commands never initialize a default; legacy environments are preserved", async (t) => {
  const f = await fixture(t);
  await assert.rejects(selectPrefix({}, ""), /No environment selected/);
  assert.deepEqual(await listEnvironments(), []);
  await assert.rejects(stat(process.env.WOMA_HOME!), { code: "ENOENT" });
  const legacy = path.join(process.env.WOMA_HOME!, "environments/base");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "environment.yaml"), "kind: WomaEnvironment\n");
  await assert.rejects(readEnvironment(legacy), /Legacy/);
  assert.equal((await listEnvironments())[0]!.format, "legacy");
  assert.equal(await readFile(path.join(legacy, "environment.yaml"), "utf8"), "kind: WomaEnvironment\n");
  await assert.rejects(createEnvironment({ prefix: legacy }, { agents: ["codex"] }), /already exists/);
});

test("skills have independent writable copies, explicit native adoption, and drift protection", async (t) => {
  const f = await fixture(t);
  const a = await createEnvironment({ name: "a" }, { agents: ["codex"] });
  const b = await createEnvironment({ name: "b" }, { agents: ["claude"] });
  const source = await skill(path.join(f.root, "review"));
  await installPackages(a, [source]); await installPackages(b, [source]);
  const target = path.join(a, "home/codex/skills/review/SKILL.md");
  await writeFile(target, "user edit\n");
  assert.match((await doctorEnvironment(a)).join("\n"), /drift/);
  assert.match(await readFile(path.join(b, "home/claude/skills/review/SKILL.md"), "utf8"), /Original content/);
  const before = await lockText(a);
  await assert.rejects(removePackages(a, ["review"]), /drift/);
  await assert.rejects(updatePackages(a, ["review"]), /drift/);
  assert.equal(await lockText(a), before);
  const native = await skill(path.join(b, "home/claude/skills/native"));
  await installPackages(b, [native]);
  assert.ok((await readEnvironment(b)).lock.packages.native);
  await removePackages(b, ["native"]);
  await assert.rejects(stat(native), { code: "ENOENT" });
  await skill(path.join(b, "home/claude/skills/conflict"));
  await assert.rejects(installPackages(b, [await skill(path.join(f.root, "conflict"))]), /Unmanaged installation conflict/);
});

for (const harness of ["codex", "claude"] as const) {
  test(`${harness} plugins preserve native content, configuration replacements, and enable state`, async (t) => {
    const f = await fixture(t);
    const prefix = await createEnvironment({ prefix: f.prefix }, { agents: [harness] });
    const source = await plugin(path.join(f.root, "native"), harness);
    const config = path.join(prefix, harness === "codex" ? "home/codex/config.toml" : "home/claude/settings.json");
    const original = harness === "codex" ? '# User comment\nmodel = "custom"\n[plugins."external@local"]\nenabled = true\n' : '{\n  // User comment\n  "model": "custom", "enabledPlugins": {"external@local": true}\n}\n';
    await writeFile(config, original, { mode: 0o600 });
    await skill(path.join(prefix, `home/${harness}/skills/external`));
    await writeFile(path.join(prefix, `home/${harness}/session.json`), "native session\n");
    await installPackages(prefix, [source]);
    const installed = path.join(prefix, harness === "codex" ? "home/codex/plugins/cache/woma/native/1.0.0" : "home/claude/skills/native");
    assert.equal(await readFile(path.join(installed, ".mcp.json"), "utf8"), await readFile(path.join(source, ".mcp.json"), "utf8"));
    const contents = await readFile(config, "utf8");
    assert.match(contents, /User comment/); assert.match(contents, /custom/);
    assert.match(contents, harness === "codex" ? /enabled = true[\s\S]*native@woma|native@woma[\s\S]*enabled = true/ : /"native@skills-dir": true/);
    const replacement = contents.replace("custom", "changed-model");
    await writeFile(`${config}.new`, replacement, { mode: 0o600 }); await rename(`${config}.new`, config);
    await writeFile(path.join(source, "payload.txt"), "updated content");
    await updatePackages(prefix, ["native"]);
    assert.equal(await readFile(config, "utf8"), replacement);
    assert.equal(await readFile(path.join(installed, "payload.txt"), "utf8"), "updated content");
    assert.deepEqual(await doctorEnvironment(prefix), []);
    await removePackages(prefix, ["native"]);
    assert.match(await readFile(config, "utf8"), /changed-model/);
    assert.match(await readFile(config, "utf8"), /external@local/);
    assert.doesNotMatch(await readFile(config, "utf8"), harness === "codex" ? /marketplaces/ : /native@skills-dir/);
    assert.equal(await readFile(path.join(prefix, `home/${harness}/session.json`), "utf8"), "native session\n");
    assert.ok((await stat(path.join(prefix, `home/${harness}/skills/external`))).isDirectory());
    await assert.rejects(stat(installed), { code: "ENOENT" });
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  });
}

test("agent mismatches and native dependencies fail before environment mutation", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const before = await lockText(f.prefix);
  const source = await plugin(path.join(f.root, "wrong"), "claude");
  await assert.rejects(installPackages(f.prefix, [source]), /has no claude/);
  const dependent = await plugin(path.join(f.root, "dependent"), "codex");
  await writeFile(path.join(dependent, ".codex-plugin/plugin.json"), JSON.stringify({ name: "dependent", dependencies: ["unlocked"] }));
  await assert.rejects(installPackages(f.prefix, [dependent]), /unlocked native dependency/);
  await assert.rejects(updatePackages(f.prefix, ["claude"], {}), /does not manage claude's version/);
  await assert.rejects(removePackages(f.prefix, ["codex"]), /only agent/);
  const claudeOnly = await skill(path.join(f.root, "claude-only"));
  await writeFile(path.join(claudeOnly, "woma.yaml"), "harnesses:\n  claude: '*'\n");
  await assert.rejects(installPackages(f.prefix, [claudeOnly]), /none of which is in this environment/);
  assert.equal(await lockText(f.prefix), before);
});

test("dependency closure retains old resolutions until explicit updates and detects conflicts", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const dependency = await skill(path.join(f.root, "dependency"));
  await writeFile(path.join(dependency, "woma.yaml"), "name: dependency\nversion: 1.0.0\n");
  const bundle = path.join(f.root, "bundle"); await mkdir(bundle);
  await writeFile(path.join(bundle, "woma.yaml"), "name: bundle\nversion: 1.0.0\ndependencies:\n  - name: dependency\n    version: ^1.0.0\n    source: ../dependency\n");
  await installPackages(f.prefix, [bundle]);
  const pinned = (await readEnvironment(f.prefix)).lock.packages.dependency!.integrity;
  await writeFile(path.join(dependency, "extra.txt"), "changed source");
  await installPackages(f.prefix, [await skill(path.join(f.root, "unrelated"))]);
  assert.equal((await readEnvironment(f.prefix)).lock.packages.dependency!.integrity, pinned);
  await updatePackages(f.prefix, ["bundle"]);
  assert.notEqual((await readEnvironment(f.prefix)).lock.packages.dependency!.integrity, pinned);
  await assert.rejects(removePackages(f.prefix, ["dependency"]), /dependency of another package/);
  const conflict = path.join(f.root, "conflict"); await mkdir(conflict);
  await writeFile(path.join(conflict, "woma.yaml"), "name: conflict\ndependencies:\n  - name: dependency\n    version: ^2.0.0\n    source: ../dependency\n");
  const before = await lockText(f.prefix);
  await assert.rejects(installPackages(f.prefix, [conflict]), /Dependency conflict/);
  assert.equal(await lockText(f.prefix), before);
  await removePackages(f.prefix, ["bundle"]);
  assert.equal((await readEnvironment(f.prefix)).lock.packages.dependency, undefined);
});

test("publication failure rolls back managed files, native config, and metadata", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const original = await skill(path.join(f.root, "original"));
  await installPackages(f.prefix, [original]);
  const before = await lockText(f.prefix);
  const config = path.join(f.prefix, "home/codex/config.toml"); await writeFile(config, 'model = "keep"\n');
  const homeBefore = await readdir(path.join(f.prefix, "home/codex"));
  const source = await plugin(path.join(f.root, "native"), "codex");
  await assert.rejects(installPackages(f.prefix, [source], { hooks: { afterChange: async (relative) => { if (relative === "home/codex/config.toml") throw new Error("injected publication failure"); } } }), /injected publication failure/);
  assert.equal(await lockText(f.prefix), before);
  assert.equal(await readFile(config, "utf8"), 'model = "keep"\n');
  assert.deepEqual(await readdir(path.join(f.prefix, "home/codex")), homeBefore);
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  await assert.rejects(stat(path.join(f.prefix, "home/codex/plugins/cache/woma/native/1.0.0")), { code: "ENOENT" });
});

test("concurrent native edits are retained and Woma mutations serialize", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["claude"] });
  const config = path.join(f.prefix, "home/claude/settings.json"); await writeFile(config, '{"model":"old"}');
  await assert.rejects(installPackages(f.prefix, [await plugin(path.join(f.root, "native"), "claude")], { hooks: { beforePublish: async () => { await writeFile(config, '{"model":"external"}'); } } }), /Concurrent modification/);
  assert.equal(await readFile(config, "utf8"), '{"model":"external"}');
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  const a = await skill(path.join(f.root, "a")), b = await skill(path.join(f.root, "b"));
  await Promise.all([installPackages(f.prefix, [a]), installPackages(f.prefix, [b])]);
  assert.deepEqual(Object.keys((await readEnvironment(f.prefix)).lock.packages).sort(), ["a", "b"]);
});

test("explicit locks reject missing local snapshots and content corruption", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const source = await skill(path.join(f.root, "review")); await installPackages(f.prefix, [source]);
  const state = await readEnvironment(f.prefix);
  const lock = path.join(f.root, "woma.lock");
  await writeFile(lock, await lockText(f.prefix));
  const cache = cachePath(state.lock.packages.review!.integrity);
  await chmod(path.join(cache, "SKILL.md"), 0o644); await writeFile(path.join(cache, "SKILL.md"), "corrupt");
  await assert.rejects(createEnvironment({ prefix: path.join(f.root, "corrupt") }, { file: lock }), /writable|Integrity mismatch/);
  await removeTestTree(cache);
  await assert.rejects(createEnvironment({ prefix: path.join(f.root, "missing") }, { file: lock }), /Missing snapshot.*--pack/);
});

test("selection restores unset and empty variables and does not stack environments", async (t) => {
  const f = await fixture(t);
  const a = await createEnvironment({ name: "a" }, { agents: ["codex"] });
  const b = await createEnvironment({ name: "b" }, { agents: ["claude"] });
  const initial = { PATH: "/original/bin", CODEX_HOME: "" };
  const first = selectedEnvironment(a, await readEnvironment(a), initial);
  assert.equal(first.CODEX_HOME, `${a}/home/codex`);
  const second = selectedEnvironment(b, await readEnvironment(b), first);
  assert.equal(second.PATH, "/original/bin");
  assert.equal(second.CODEX_HOME, "");
  assert.equal(second.CLAUDE_CONFIG_DIR, `${b}/home/claude`);
  assert.equal(second.DISABLE_AUTOUPDATER, undefined);
  assert.deepEqual(originalEnvironment(second), initial);
  assert.deepEqual(selectedEnvironment(b, await readEnvironment(b), second), second);
});

test("rollback retains external edits with backups and blocks further mutation", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const source = await skill(path.join(f.root, "review")); await installPackages(f.prefix, [source]);
  await writeFile(path.join(source, "new.txt"), "new content");
  const target = path.join(f.prefix, "home/codex/skills/review");
  await assert.rejects(updatePackages(f.prefix, ["review"], { hooks: { afterChange: async (relative) => {
    if (relative === "home/codex/skills/review") { await writeFile(path.join(target, "external.txt"), "retain me"); throw new Error("injected failure"); }
  } } }), /rollback incomplete.*Backups retained/);
  assert.equal(await readFile(path.join(target, "external.txt"), "utf8"), "retain me");
  assert.match((await doctorEnvironment(f.prefix)).join("\n"), /Interrupted transaction/);
  await assert.rejects(installPackages(f.prefix, [source]), /Interrupted transaction/);
});

test("modified ownership metadata cannot claim native credentials or unrelated paths", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  await installPackages(f.prefix, [await skill(path.join(f.root, "review"))]);
  const state = await readEnvironment(f.prefix);
  state.paths.push({ path: "home/codex/auth.json", package: "codex", integrity: state.paths[0]!.integrity });
  await writeFile(path.join(f.prefix, ".woma/state.json"), JSON.stringify(state));
  await assert.rejects(readEnvironment(f.prefix), /ownership metadata/);
});

test("native homes cannot be snapshotted and export needs no access to native state", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["codex"] });
  const home = path.join(f.prefix, "home/codex");
  await skill(path.join(home, "skills/native"));
  await writeFile(path.join(home, "auth.json"), '"credential sentinel"');
  const store = path.join(process.env.WOMA_HOME!, "store/v2");
  const before = await readdir(store).catch(() => []);
  await assert.rejects(installPackages(f.prefix, [home]), /Native state cannot enter|native home is not/);
  assert.deepEqual(await readdir(store).catch(() => []), before);
  await chmod(path.join(f.prefix, "home"), 0o000);
  try { assert.doesNotMatch(await lockText(f.prefix), /credential sentinel/); }
  finally { await chmod(path.join(f.prefix, "home"), 0o700); }
});
