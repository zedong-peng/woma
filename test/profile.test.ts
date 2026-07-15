import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorProject } from "../src/doctor.js";
import { createHandoff } from "../src/handoff.js";
import { installPackageSource } from "../src/package.js";
import { leaveProfile, switchProfile } from "../src/profile.js";
import { addPackageToProject, initProject, setBinding } from "../src/project.js";
import { putLock, readState } from "../src/store.js";

const repositoryRoot = process.cwd();

async function setup(root: string): Promise<string> {
  process.env.HARNESS_HOME = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "AGENTS.md"), "# Existing project instructions\n", "utf8");
  await initProject(project, { name: "agent-lab" });
  const sources = ["reproducibility-core", "research-workflow", "experiment-workflow"];
  for (const source of sources) {
    const pkg = await installPackageSource(path.join(repositoryRoot, "examples", source));
    await putLock(project, pkg.lock);
  }
  await addPackageToProject(project, "reproducibility-core", { base: true });
  await addPackageToProject(project, "research-workflow", { profile: "research" });
  await addPackageToProject(project, "experiment-workflow", { profile: "experiment" });
  await setBinding(project, "test", "npm test");
  await setBinding(project, "benchmark", "npm run benchmark");
  return project;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "src", "cli.js"), ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("research switches to experiment with base retention and handoff", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-"));
  try {
    const project = await setup(root);
    await switchProfile(project, "research");
    const researchState = await readState(project);
    assert.equal(researchState.profile?.name, "research");
    assert.deepEqual(researchState.profile?.packages, ["reproducibility-core", "research-workflow"]);
    const coreActivatedAt = researchState.activations["reproducibility-core"]?.activatedAt;
    assert.ok(coreActivatedAt);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /Active Harness Profile: research/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /test: `npm test`/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "research-loop", "SKILL.md"), "utf8"), /Research loop/);

    const handoff = await createHandoff(project, "experiment");
    await appendFile(path.join(project, handoff), "\nObserved evidence: baseline is reproducible.\n", "utf8");
    const switched = await switchProfile(project, "experiment");
    assert.equal(switched.handoff, handoff);
    const experimentState = await readState(project);
    assert.equal(experimentState.profile?.name, "experiment");
    assert.deepEqual(experimentState.profile?.packages, ["reproducibility-core", "experiment-workflow"]);
    assert.equal(experimentState.activations["reproducibility-core"]?.activatedAt, coreActivatedAt);
    assert.equal(experimentState.activations["research-workflow"], undefined);
    assert.ok(experimentState.activations["experiment-workflow"]);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "research-loop", "SKILL.md")), /ENOENT/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "experiment-loop", "SKILL.md"), "utf8"), /Experiment loop/);
    const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
    assert.match(agents, /Active Harness Profile: experiment/);
    assert.match(agents, new RegExp(handoff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const settings = JSON.parse(await readFile(path.join(project, ".claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Edit|Write");
    assert.equal((await doctorProject(project)).some((check) => check.status === "fail"), false);

    await leaveProfile(project);
    const finalState = await readState(project);
    assert.equal(finalState.profile, undefined);
    assert.deepEqual(finalState.activations, {});
    assert.equal(await readFile(path.join(project, "AGENTS.md"), "utf8"), "# Existing project instructions\n");
    await assert.rejects(readFile(path.join(project, "CLAUDE.md")), /ENOENT/);
    assert.match(await readFile(path.join(project, handoff), "utf8"), /baseline is reproducible/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed profile switch rolls back packages and routing signal", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-"));
  try {
    const project = await setup(root);
    await switchProfile(project, "research");
    const before = await readFile(path.join(project, "AGENTS.md"), "utf8");
    const conflict = path.join(project, ".agents", "skills", "experiment-loop");
    await mkdir(conflict, { recursive: true });
    await writeFile(path.join(conflict, "SKILL.md"), "user-owned", "utf8");
    await assert.rejects(switchProfile(project, "experiment"), /Refusing to overwrite existing skill/);
    const state = await readState(project);
    assert.equal(state.profile?.name, "research");
    assert.ok(state.activations["research-workflow"]);
    assert.equal(state.activations["experiment-workflow"], undefined);
    assert.equal(await readFile(path.join(project, "AGENTS.md"), "utf8"), before);
    assert.match(await readFile(path.join(project, ".agents", "skills", "research-loop", "SKILL.md"), "utf8"), /Research loop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modified active instructions require explicit repair", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-"));
  try {
    const project = await setup(root);
    await switchProfile(project, "research");
    const researchActivatedAt = (await readState(project)).activations["research-workflow"]?.activatedAt;
    const agentsPath = path.join(project, "AGENTS.md");
    const modified = (await readFile(agentsPath, "utf8")).replace("Active Harness Profile: research", "Active Harness Profile: user-edit");
    await writeFile(agentsPath, modified, "utf8");
    await assert.rejects(switchProfile(project, "experiment"), /modified or removed/);
    const rejectedState = await readState(project);
    assert.equal(rejectedState.profile?.name, "research");
    assert.equal(rejectedState.activations["research-workflow"]?.activatedAt, researchActivatedAt);
    await switchProfile(project, "experiment", { repair: true });
    assert.match(await readFile(agentsPath, "utf8"), /Active Harness Profile: experiment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enter switches profile and launches a fresh Agent process with arguments", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-"));
  const previousPath = process.env.PATH;
  const previousOutput = process.env.HARNESS_ENTER_OUTPUT;
  try {
    const project = await setup(root);
    const bin = path.join(root, "bin");
    const output = path.join(root, "agent-output.txt");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "codex");
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n%s\\n" "$PWD" "$*" > "$HARNESS_ENTER_OUTPUT"\n', "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.HARNESS_ENTER_OUTPUT = output;

    const result = await runCli(
      ["--project", project, "enter", "--agent", "codex", "research", "--", "--full-auto", "investigate"],
      process.env,
    );
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const observed = await readFile(output, "utf8");
    const canonicalProject = await realpath(project);
    assert.match(observed, new RegExp(`^${canonicalProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(observed, /--full-auto investigate/);
    assert.equal((await readState(project)).profile?.name, "research");
  } finally {
    process.env.PATH = previousPath;
    if (previousOutput === undefined) delete process.env.HARNESS_ENTER_OUTPUT;
    else process.env.HARNESS_ENTER_OUTPUT = previousOutput;
    await rm(root, { recursive: true, force: true });
  }
});
