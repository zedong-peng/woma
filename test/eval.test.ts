import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEvalDefinition, parseEvalDefinition, planEval, runEval } from "../src/eval.js";
import { onboardProject } from "../src/onboard.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed: ${stderr.trim() || code}`));
    });
  });
}

test("eval definitions require one objective verifier", () => {
  assert.throws(
    () =>
      parseEvalDefinition(`apiVersion: harness.conda/eval-v1
kind: HarnessEval
metadata:
  name: bad-eval
spec:
  profile: research
  prompt: This task description is long enough to be considered valid.
  verify: {}
`),
    /choose exactly one of binding or command/,
  );
});

test("paired eval isolates arms and persists only local result metadata", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-eval-test-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const previousHome = process.env.HARNESS_HOME;
  const previousPath = process.env.PATH;
  process.env.HARNESS_HOME = home;
  try {
    await mkdir(project, { recursive: true });
    await run("git", ["init", "-q"], project);
    await run("git", ["config", "user.email", "eval@example.com"], project);
    await run("git", ["config", "user.name", "Harness Eval"], project);
    await write(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "test -f answer.txt" } }));
    await onboardProject(project, {
      name: "eval-fixture",
      agent: "codex",
      targets: ["codex", "claude"],
      switchToResearch: false,
    });
    const definitionPath = await createEvalDefinition(project, "profile-signal", {
      profile: "research",
      verify: { command: "test -f answer.txt" },
    });
    const prompt = "Create answer.txt containing one line with the word ready, then stop.";
    await writeFile(
      definitionPath,
      (await readFile(definitionPath, "utf8")).replace(
        "REPLACE_WITH_A_BOUNDED_TASK_AND_AN_OBSERVABLE_OUTPUT",
        prompt,
      ),
      "utf8",
    );
    await run("git", ["add", "."], project);
    await run("git", ["commit", "-q", "-m", "eval fixture"], project);

    await write(
      path.join(fakeBin, "codex"),
      `#!/bin/sh
if [ -f .agents/skills/research-loop/SKILL.md ]; then
  echo ready > answer.txt
fi
`,
    );
    await chmod(path.join(fakeBin, "codex"), 0o755);
    await write(
      path.join(fakeBin, "claude"),
      `#!/bin/sh
if [ -f .claude/skills/research-loop/SKILL.md ]; then
  echo ready > answer.txt
fi
`,
    );
    await chmod(path.join(fakeBin, "claude"), 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

    const plan = await planEval(project, "profile-signal");
    assert.equal(plan.clean, true);
    assert.equal(plan.sessions, 2);
    assert.equal(plan.profile, "research");

    const packagePath = path.join(project, "package.json");
    const packageContent = await readFile(packagePath, "utf8");
    await writeFile(packagePath, `${packageContent}\n`, "utf8");
    await assert.rejects(runEval(project, "profile-signal", { execute: true }), /requires a clean worktree/);
    await writeFile(packagePath, packageContent, "utf8");

    const result = await runEval(project, "profile-signal", { execute: true, keepFailures: true });
    assert.deepEqual(result.summary.baseline, {
      passed: 0,
      total: 1,
      passRate: 0,
      failures: { agent: 0, verifier: 1, timeout: 0 },
    });
    assert.deepEqual(result.summary.profile, {
      passed: 1,
      total: 1,
      passRate: 1,
      failures: { agent: 0, verifier: 0, timeout: 0 },
    });
    assert.equal(result.results.find((item) => item.arm === "baseline")?.verifierExitCode, 1);
    assert.equal(result.results.find((item) => item.arm === "profile")?.verifierExitCode, 0);
    const retained = result.results.find((item) => item.arm === "baseline")?.worktree;
    assert.ok(retained);
    await assert.rejects(readFile(path.join(retained, "answer.txt")), /ENOENT/);
    const persisted = await readFile(path.join(project, result.resultPath), "utf8");
    assert.doesNotMatch(persisted, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(readFile(path.join(project, "answer.txt")), /ENOENT/);
    const retainedWorktrees = await run("git", ["worktree", "list", "--porcelain"], project);
    assert.equal(retainedWorktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
    await run("git", ["worktree", "remove", "--force", retained], project);
    const cleanedWorktrees = await run("git", ["worktree", "list", "--porcelain"], project);
    assert.equal(cleanedWorktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 1);

    const claudeResult = await runEval(project, "profile-signal", { execute: true, agent: "claude" });
    assert.equal(claudeResult.agent, "claude");
    assert.equal(claudeResult.summary.baseline.passRate, 0);
    assert.equal(claudeResult.summary.profile.passRate, 1);

    const unsafePath = await createEvalDefinition(project, "unsafe", {
      profile: "research",
      verify: { command: "true" },
    });
    await writeFile(unsafePath, (await readFile(unsafePath, "utf8")).replace("agentArgs: []", "agentArgs: [--sandbox=danger-full-access]"));
    await assert.rejects(planEval(project, "unsafe"), /cannot use isolation-changing option/);
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
