import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createEnvironment, doctorEnvironment, installPackages, readEnvironment } from "../src/environment.js";
import { resolvePackage } from "../src/package.js";
import { fixture } from "./helpers.js";

test("shipped examples use the minimal format and install through native layouts", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  for (const name of ["auto-research", "performance-engineering", "reproducibility-core", "woma-package-builder", "native-codex-review"]) {
    await installPackages(f.prefix, [path.resolve("examples", name)]);
  }
  assert.ok((await readEnvironment(f.prefix)).lock.packages["paper-search"]);
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  const native = await resolvePackage(path.resolve("examples/native-claude-review"));
  assert.equal(native.record.kind, "plugin");
  assert.equal(native.record.plugin?.harness, "claude");
  await assert.rejects(resolvePackage(path.resolve("test/fixtures/source-adapter/native")), /v2 woma.yaml accepts only/);
});
