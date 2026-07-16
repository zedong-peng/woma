import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindEnvironment,
  createEnvironment,
  environmentLockPath,
  environmentPath,
  parseEnvironment,
  deactivateEnvironment,
} from "../src/environment.js";
import { activatePackage } from "../src/activation.js";
import { installPackageSource } from "../src/package.js";
import { putLock, readState, statePath } from "../src/store.js";

test("environment paths reject traversal names", () => {
  assert.throws(() => environmentPath("/tmp/project", "../../outside"), /must use lowercase letters/);
  assert.throws(() => environmentLockPath("/tmp/project", "../outside"), /must use lowercase letters/);
});

test("environment recipes reject duplicate roots", () => {
  assert.throws(
    () =>
      parseEnvironment(`
apiVersion: harness.conda/environment-v1
kind: HarnessEnvironment
metadata:
  name: research
spec:
  targets: [codex]
  roots:
    - name: auto-research
      source: gh:owner/auto-research#v1.0.0
    - name: auto-research
      source: gh:owner/auto-research#v2.0.0
`),
    /duplicate root package auto-research/,
  );
});

test("invalid bindings do not corrupt an environment recipe", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-schema-"));
  try {
    await createEnvironment(root, "research", ["codex"]);
    const filePath = environmentPath(root, "research");
    const before = await readFile(filePath, "utf8");
    await assert.rejects(bindEnvironment(root, "research", "../test", "npm test"), /must use lowercase letters/);
    assert.equal(await readFile(filePath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deactivate cleans legacy profile packages and routing blocks without the old workflow engine", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-migration-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource("builtin:paper-search");
    await putLock(root, pkg.lock);
    await activatePackage(pkg, root, ["codex"]);
    const block = "<!-- >>> harness-conda:active-profile -->\nlegacy\n<!-- <<< harness-conda:active-profile -->";
    await writeFile(path.join(root, "AGENTS.md"), `${block}\n`, "utf8");
    const state = await readState(root);
    state.profile = {
      name: "research",
      packages: ["paper-search"],
      targets: ["codex"],
      activatedAt: new Date().toISOString(),
      instructions: [{ path: "AGENTS.md", block }],
    };
    await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await deactivateEnvironment(root);
    assert.deepEqual((await readState(root)).activations, {});
    assert.equal((await readState(root)).profile, undefined);
    await assert.rejects(readFile(path.join(root, ".agents", "skills", "paper-search", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(root, "AGENTS.md")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
