import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject, parseProjectConfig, readProjectConfig, setBinding } from "../src/project.js";

test("project config models base, profiles, targets, and bindings", () => {
  const config = parseProjectConfig(`
apiVersion: harness.conda/project-v1
kind: HarnessProject
metadata:
  name: agent-lab
spec:
  profiles:
    research:
      description: Research phase.
      packages: [research-workflow]
`);
  assert.equal(config.spec.agent, "codex");
  assert.deepEqual(config.spec.targets, ["codex", "claude"]);
  assert.deepEqual(config.spec.base, []);
  assert.equal(config.spec.profiles.research?.packages[0], "research-workflow");
  assert.equal(config.spec.handoffDirectory, ".harness/handoffs");
});

test("project init creates opinionated research and experiment phases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-"));
  try {
    const config = await initProject(root, { name: "agent-lab", targets: ["codex"] });
    assert.deepEqual(Object.keys(config.spec.profiles), ["research", "experiment"]);
    await setBinding(root, "test", "npm test");
    const loaded = await readProjectConfig(root);
    assert.equal(loaded.spec.bindings.test, "npm test");
    assert.match(await readFile(path.join(root, ".harness", "project.yaml"), "utf8"), /harness\.conda\/project-v1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
