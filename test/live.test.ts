import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createEnvironment, doctorEnvironment, exportEnvironment, installPackages, readEnvironment, removePackages, updatePackages } from "../src/environment.js";
import { commandOutput } from "../src/process.js";
import { selectedEnvironment } from "../src/selection.js";
import { fixture, plugin } from "./helpers.js";

for (const harness of ["codex", "claude"] as const) {
  test(`official ${harness} runtime and native plugin contract`, { skip: process.env.WOMA_LIVE_TESTS !== "1", timeout: 600_000 }, async (t) => {
    const f = await fixture(t);
    const prefix = await createEnvironment({ prefix: f.prefix }, { harness, version: harness === "codex" ? "0.154.0" : "2.1.269" });
    const env = selectedEnvironment(prefix, await readEnvironment(prefix), { PATH: process.env.PATH, HOME: path.join(f.root, "user") });
    await mkdir(env.HOME!, { recursive: true });
    const executable = path.join(prefix, "bin", harness);
    assert.match(await commandOutput(executable, ["--version"], { cwd: f.root, env }), harness === "codex" ? /0\.154\.0/ : /2\.1\.269/);
    const source = await plugin(path.join(f.root, "probe"), harness);
    await installPackages(prefix, [source]);
    const listed = JSON.parse(await commandOutput(executable, ["plugin", "list", "--json"], { cwd: f.root, env })) as unknown;
    assert.match(JSON.stringify(listed), /probe/);
    assert.match(JSON.stringify(listed), /false/);
    assert.deepEqual(await doctorEnvironment(prefix), []);
    const lock = path.join(f.root, "woma.lock"); await writeFile(lock, await exportEnvironment(prefix, true));
    const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lock });
    assert.deepEqual((await readEnvironment(clone)).lock.packages, (await readEnvironment(prefix)).lock.packages);
    await removePackages(prefix, ["probe"]);
    assert.deepEqual(await doctorEnvironment(prefix), []);
    if (harness === "codex") {
      await updatePackages(prefix, ["codex@0.153.0"]);
      assert.match(await commandOutput(executable, ["--version"], { cwd: f.root, env }), /0\.153\.0/);
      assert.equal((await readEnvironment(clone)).lock.packages.codex!.version, "0.154.0");
    }
  });
}
