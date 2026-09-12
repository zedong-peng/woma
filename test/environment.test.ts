import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { cachePath } from "../src/content.js";
import { createEnvironment, doctorEnvironment, exportEnvironment, installPackages, listEnvironments, readEnvironment, removePackages, selectPrefix, updatePackages } from "../src/environment.js";
import { commandOutput } from "../src/process.js";
import { originalEnvironment, selectedEnvironment } from "../src/selection.js";
import { fixture, plugin, removeTestTree, skill } from "./helpers.js";

test("runtime versions evolve independently and locks recreate managed content", async (t) => {
  const f = await fixture(t);
  const first = await createEnvironment({ name: "first" }, { harness: "codex", version: "0.154.0", provider: f.provider });
  const second = await createEnvironment({ name: "second" }, { harness: "codex", version: "0.155.0", provider: f.provider });
  assert.equal((await readEnvironment(first)).lock.packages.codex!.version, "0.154.0");
  await updatePackages(first, ["codex@0.156.0"], { provider: f.provider });
  assert.equal((await readEnvironment(second)).lock.packages.codex!.version, "0.155.0");
  const source = await skill(path.join(f.root, "review"));
  await installPackages(first, [source]);
  await writeFile(path.join(first, "home/auth.json"), '"credential sentinel"');
  await writeFile(path.join(first, "home/session.json"), '"session sentinel"');
  const explicit = await exportEnvironment(first, true);
  assert.doesNotMatch(explicit, /credential sentinel|session sentinel/);
  const lockFile = path.join(f.root, "woma.lock"); await writeFile(lockFile, explicit);
  await removeTestTree(source);
  const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lockFile, provider: f.provider });
  assert.deepEqual((await readEnvironment(clone)).lock.packages, (await readEnvironment(first)).lock.packages);
  assert.equal(await readFile(path.join(clone, "home/skills/review/references/note.txt"), "utf8"), "Complete reference content\n");
  assert.deepEqual(await readdir(path.join(clone, "home")), ["skills"]);
  const recipe = parseYaml(await exportEnvironment(first));
  assert.equal(recipe.runtime, "0.156.0"); assert.deepEqual(recipe.packages, [{ name: "review", source: `file:${source}` }]);
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
  await assert.rejects(readEnvironment(legacy), /Legacy environment/);
  assert.equal((await listEnvironments())[0]!.format, "legacy");
  assert.equal(await readFile(path.join(legacy, "environment.yaml"), "utf8"), "kind: WomaEnvironment\n");
  await assert.rejects(createEnvironment({ prefix: legacy }, { harness: "codex", provider: f.provider }), /already exists/);
});

test("skills have independent writable copies, explicit native adoption, and drift protection", async (t) => {
  const f = await fixture(t);
  const a = await createEnvironment({ name: "a" }, { harness: "codex", provider: f.provider });
  const b = await createEnvironment({ name: "b" }, { harness: "claude", provider: f.provider });
  const source = await skill(path.join(f.root, "review"));
  await installPackages(a, [source]); await installPackages(b, [source]);
  const target = path.join(a, "home/skills/review/SKILL.md");
  await writeFile(target, "user edit\n");
  assert.match((await doctorEnvironment(a)).join("\n"), /drift/);
  assert.match(await readFile(path.join(b, "home/skills/review/SKILL.md"), "utf8"), /Original content/);
  const before = await exportEnvironment(a, true);
  await assert.rejects(removePackages(a, ["review"]), /drift/);
  await assert.rejects(updatePackages(a, ["review"]), /drift/);
  assert.equal(await exportEnvironment(a, true), before);
  const native = await skill(path.join(b, "home/skills/native"));
  await installPackages(b, [native]);
  assert.ok((await readEnvironment(b)).lock.packages.native);
  await removePackages(b, ["native"]);
  await assert.rejects(stat(native), { code: "ENOENT" });
  await skill(path.join(b, "home/skills/conflict"));
  await assert.rejects(installPackages(b, [await skill(path.join(f.root, "conflict"))]), /Unmanaged installation conflict/);
});

for (const harness of ["codex", "claude"] as const) {
  test(`${harness} plugins preserve native content, configuration replacements, and enable state`, async (t) => {
    const f = await fixture(t);
    const prefix = await createEnvironment({ prefix: f.prefix }, { harness, provider: f.provider });
    const source = await plugin(path.join(f.root, "native"), harness);
    const config = path.join(prefix, harness === "codex" ? "home/config.toml" : "home/settings.json");
    const original = harness === "codex" ? '# User comment\nmodel = "custom"\n[plugins."external@local"]\nenabled = true\n' : '{\n  // User comment\n  "model": "custom", "enabledPlugins": {"external@local": true}\n}\n';
    await writeFile(config, original, { mode: 0o600 });
    await skill(path.join(prefix, "home/skills/external"));
    await writeFile(path.join(prefix, "home/session.json"), "native session\n");
    await installPackages(prefix, [source]);
    const installed = path.join(prefix, harness === "codex" ? "home/plugins/cache/woma/native/1.0.0" : "home/skills/native");
    assert.equal(await readFile(path.join(installed, ".mcp.json"), "utf8"), await readFile(path.join(source, ".mcp.json"), "utf8"));
    const contents = await readFile(config, "utf8");
    assert.match(contents, /User comment/); assert.match(contents, /custom/);
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
    assert.equal(await readFile(path.join(prefix, "home/session.json"), "utf8"), "native session\n");
    assert.ok((await stat(path.join(prefix, "home/skills/external"))).isDirectory());
    await assert.rejects(stat(installed), { code: "ENOENT" });
    assert.equal((await stat(config)).mode & 0o777, 0o600);
  });
}

test("harness incompatibility and native dependencies fail before environment mutation", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const before = await exportEnvironment(f.prefix, true);
  const source = await plugin(path.join(f.root, "wrong"), "claude");
  await assert.rejects(installPackages(f.prefix, [source]), /incompatible/);
  const dependent = await plugin(path.join(f.root, "dependent"), "codex");
  await writeFile(path.join(dependent, ".codex-plugin/plugin.json"), JSON.stringify({ name: "dependent", dependencies: ["unlocked"] }));
  await assert.rejects(installPackages(f.prefix, [dependent]), /unlocked native dependency/);
  await assert.rejects(updatePackages(f.prefix, ["claude"], { provider: f.provider }), /new environment/);
  await assert.rejects(removePackages(f.prefix, ["codex"]), /Cannot remove/);
  assert.equal(await exportEnvironment(f.prefix, true), before);
});

test("dependency closure retains old resolutions until explicit updates and detects conflicts", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
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
  await assert.rejects(removePackages(f.prefix, ["dependency"]), /not a direct requirement/);
  const conflict = path.join(f.root, "conflict"); await mkdir(conflict);
  await writeFile(path.join(conflict, "woma.yaml"), "name: conflict\ndependencies:\n  - name: dependency\n    version: ^2.0.0\n    source: ../dependency\n");
  const before = await exportEnvironment(f.prefix, true);
  await assert.rejects(installPackages(f.prefix, [conflict]), /Dependency conflict/);
  assert.equal(await exportEnvironment(f.prefix, true), before);
  await removePackages(f.prefix, ["bundle"]);
  assert.equal((await readEnvironment(f.prefix)).lock.packages.dependency, undefined);
});

test("publication failure rolls back managed files, native config, and metadata", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const original = await skill(path.join(f.root, "original"));
  await installPackages(f.prefix, [original]);
  const before = await exportEnvironment(f.prefix, true);
  const config = path.join(f.prefix, "home/config.toml"); await writeFile(config, 'model = "keep"\n');
  const homeBefore = await readdir(path.join(f.prefix, "home"));
  const source = await plugin(path.join(f.root, "native"), "codex");
  await assert.rejects(installPackages(f.prefix, [source], { hooks: { afterChange: async (relative) => { if (relative === "home/config.toml") throw new Error("injected publication failure"); } } }), /injected publication failure/);
  assert.equal(await exportEnvironment(f.prefix, true), before);
  assert.equal(await readFile(config, "utf8"), 'model = "keep"\n');
  assert.deepEqual(await readdir(path.join(f.prefix, "home")), homeBefore);
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  await assert.rejects(stat(path.join(f.prefix, "home/plugins/cache/woma/native/1.0.0")), { code: "ENOENT" });
});

test("concurrent native edits are retained and Woma mutations serialize", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "claude", provider: f.provider });
  const config = path.join(f.prefix, "home/settings.json"); await writeFile(config, '{"model":"old"}');
  await assert.rejects(installPackages(f.prefix, [await plugin(path.join(f.root, "native"), "claude")], { hooks: { beforePublish: async () => { await writeFile(config, '{"model":"external"}'); } } }), /Concurrent modification/);
  assert.equal(await readFile(config, "utf8"), '{"model":"external"}');
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  const a = await skill(path.join(f.root, "a")), b = await skill(path.join(f.root, "b"));
  await Promise.all([installPackages(f.prefix, [a]), installPackages(f.prefix, [b])]);
  assert.deepEqual(Object.keys((await readEnvironment(f.prefix)).lock.packages).sort(), ["a", "b", "claude"]);
});

test("explicit locks reject missing local snapshots, platform mismatch, and content corruption", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const source = await skill(path.join(f.root, "review")); await installPackages(f.prefix, [source]);
  const state = await readEnvironment(f.prefix);
  const lock = path.join(f.root, "woma.lock");
  await writeFile(lock, await exportEnvironment(f.prefix, true));
  const cache = cachePath(state.lock.packages.review!.integrity);
  await chmod(path.join(cache, "SKILL.md"), 0o644); await writeFile(path.join(cache, "SKILL.md"), "corrupt");
  await assert.rejects(createEnvironment({ prefix: path.join(f.root, "corrupt") }, { file: lock, provider: f.provider }), /writable|Integrity mismatch/);
  await removeTestTree(cache);
  await assert.rejects(createEnvironment({ prefix: path.join(f.root, "missing") }, { file: lock, provider: f.provider }), /Missing snapshot/);
  state.lock.platform = "wrong-platform"; await writeFile(lock, JSON.stringify(state.lock));
  await assert.rejects(createEnvironment({ prefix: path.join(f.root, "platform") }, { file: lock, provider: f.provider }), /Platform mismatch/);
});

test("selection restores unset and empty variables and does not stack environments", async (t) => {
  const f = await fixture(t);
  const a = await createEnvironment({ name: "a" }, { harness: "codex", provider: f.provider });
  const b = await createEnvironment({ name: "b" }, { harness: "claude", provider: f.provider });
  const initial = { PATH: "/original/bin", CODEX_HOME: "", DISABLE_AUTOUPDATER: "0" };
  const first = selectedEnvironment(a, await readEnvironment(a), initial);
  const second = selectedEnvironment(b, await readEnvironment(b), first);
  assert.equal(second.PATH, `${b}/bin:/original/bin`);
  assert.equal(second.CODEX_HOME, "");
  assert.equal(second.CLAUDE_CONFIG_DIR, `${b}/home`);
  assert.deepEqual(originalEnvironment(second), initial);
  assert.deepEqual(selectedEnvironment(b, await readEnvironment(b), second), second);
  assert.equal(await commandOutput(path.join(a, "bin/codex"), ["--version"]), "codex 0.154.0");
});

test("rollback retains external edits with backups and blocks further mutation", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const source = await skill(path.join(f.root, "review")); await installPackages(f.prefix, [source]);
  await writeFile(path.join(source, "new.txt"), "new content");
  const target = path.join(f.prefix, "home/skills/review");
  await assert.rejects(updatePackages(f.prefix, ["review"], { hooks: { afterChange: async (relative) => {
    if (relative === "home/skills/review") { await writeFile(path.join(target, "external.txt"), "retain me"); throw new Error("injected failure"); }
  } } }), /rollback incomplete.*Backups retained/);
  assert.equal(await readFile(path.join(target, "external.txt"), "utf8"), "retain me");
  assert.match((await doctorEnvironment(f.prefix)).join("\n"), /Interrupted transaction/);
  await assert.rejects(installPackages(f.prefix, [source]), /Interrupted transaction/);
});

test("modified ownership metadata cannot claim native credentials or unrelated paths", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const state = await readEnvironment(f.prefix);
  state.paths.push({ path: "home/auth.json", package: "codex", integrity: state.paths[0]!.integrity });
  await writeFile(path.join(f.prefix, ".woma/state.json"), JSON.stringify(state));
  await assert.rejects(readEnvironment(f.prefix), /ownership metadata/);
});

test("native homes cannot be snapshotted and export needs no access to native state", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const home = path.join(f.prefix, "home");
  await skill(path.join(home, "skills/native"));
  await writeFile(path.join(home, "auth.json"), '"credential sentinel"');
  const store = path.join(process.env.WOMA_HOME!, "store/v2");
  const before = await readdir(store);
  await assert.rejects(installPackages(f.prefix, [home]), /Native state cannot enter|native home is not/);
  assert.deepEqual(await readdir(store), before);
  await chmod(home, 0o000);
  try { assert.doesNotMatch(await exportEnvironment(f.prefix, true), /credential sentinel/); }
  finally { await chmod(home, 0o700); }
});
