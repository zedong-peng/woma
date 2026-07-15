import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initProject, parseProjectConfig, readProjectConfig, setBinding } from "../src/project.js";

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

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

test("project init creates opinionated research, experiment, and performance phases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-"));
  try {
    const config = await initProject(root, { name: "agent-lab", targets: ["codex"] });
    assert.deepEqual(Object.keys(config.spec.profiles), ["research", "experiment", "performance"]);
    await setBinding(root, "test", "npm test");
    const loaded = await readProjectConfig(root);
    assert.equal(loaded.spec.bindings.test, "npm test");
    assert.match(await readFile(path.join(root, ".harness", "project.yaml"), "utf8"), /harness\.conda\/project-v1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project init excludes machine-local evidence from Git", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-"));
  try {
    await run("git", ["init", "-q"], root);
    await initProject(root, { name: "private-evidence" });
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/\.harness\/state\.json$/m);
    assert.match(exclude, /^\/\.harness\/local\/$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
