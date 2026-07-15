import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorPackage } from "../src/doctor.js";
import { onboardProject } from "../src/onboard.js";
import { loadCachedPackage, syncLockedPackage } from "../src/package.js";
import { switchProfile } from "../src/profile.js";
import { readProjectConfig, setBinding } from "../src/project.js";
import { readLock, readState } from "../src/store.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("one-command onboarding detects bindings and activates research", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-onboard-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    await write(path.join(project, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }));
    const result = await onboardProject(project, { name: "onboard-demo", targets: ["codex"] });
    assert.deepEqual(result.detection.stacks, ["Node.js"]);
    assert.equal(result.active?.name, "research");

    const config = await readProjectConfig(project);
    assert.deepEqual(config.spec.base, ["reproducibility-core"]);
    assert.deepEqual(config.spec.profiles.research?.packages, ["research-workflow"]);
    assert.deepEqual(config.spec.profiles.experiment?.packages, ["experiment-workflow"]);
    assert.deepEqual(config.spec.profiles.performance?.packages, ["performance-engineering"]);
    assert.equal(config.spec.bindings.build, "npm run build");
    assert.equal(config.spec.bindings.test, "npm test");
    const lock = await readLock(project);
    assert.equal(lock.packages["research-workflow"]?.source, "builtin:research-workflow");
    assert.equal(lock.packages["performance-engineering"]?.source, "builtin:performance-engineering");
    const performancePackage = await loadCachedPackage(lock.packages["performance-engineering"]!);
    const inactiveChecks = await doctorPackage(performancePackage, project, { activationExpected: false });
    assert.equal(inactiveChecks.find((check) => check.label === "binding:test")?.status, "ok");
    assert.equal(inactiveChecks.find((check) => check.label === "binding:benchmark")?.status, "warn");
    assert.equal((await readState(project)).profile?.name, "research");
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /Active Harness Profile: research/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "research-loop", "SKILL.md"), "utf8"), /Research loop/);
    await assert.rejects(switchProfile(project, "performance"), /requires project binding benchmark/);
    assert.equal((await readState(project)).profile?.name, "research");
    await setBinding(project, "benchmark", "npm run bench");
    await switchProfile(project, "performance");
    assert.equal((await readState(project)).profile?.name, "performance");
    assert.match(await readFile(path.join(project, ".agents", "skills", "performance-loop", "SKILL.md"), "utf8"), /Performance loop/);
    const activeChecks = await doctorPackage(performancePackage, project);
    assert.equal(activeChecks.find((check) => check.label === "binding:test")?.status, "ok");
    assert.equal(activeChecks.find((check) => check.label === "binding:benchmark")?.status, "ok");
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "research-loop", "SKILL.md")), /ENOENT/);
    await assert.rejects(onboardProject(project, { targets: ["codex"] }), /fresh Harness project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built-in package locks restore without the original working directory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-onboard-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    await onboardProject(project, { targets: ["codex"], switchToResearch: false });
    const lock = await readLock(project);
    const performance = lock.packages["performance-engineering"]!;
    const cached = await loadCachedPackage(performance);
    await rm(cached.root, { recursive: true, force: true });
    const restored = await syncLockedPackage(performance);
    assert.equal(restored.manifest.metadata.name, "performance-engineering");
    assert.equal(restored.lock.integrity, performance.integrity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
