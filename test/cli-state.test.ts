import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function runCli(args: string[], cwd: string, home: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const cli = path.resolve("dist/src/cli.js");
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, HARNESS_HOME: home },
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

test("CLI refuses an install that would replace the lock of an active package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-state-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const packageRoot = path.join(root, "package");
  try {
    await write(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: cli-state
  version: 1.0.0
  description: CLI state fixture.
spec:
  platforms: [codex]
  skills:
    - name: cli-state
      path: ./skills/cli-state
`,
    );
    await write(path.join(packageRoot, "skills", "cli-state", "SKILL.md"), "---\ndescription: CLI state.\n---\nState.\n");

    const install = await runCli(["--project", project, "install", packageRoot], root, home);
    assert.equal(install.code, 0, install.stderr);
    const activate = await runCli(["--project", project, "activate", "cli-state", "--target", "codex"], root, home);
    assert.equal(activate.code, 0, activate.stderr);

    const manifestPath = path.join(packageRoot, "harness.yaml");
    await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("version: 1.0.0", "version: 2.0.0"), "utf8");
    const upgrade = await runCli(["--project", project, "install", packageRoot], root, home);
    assert.notEqual(upgrade.code, 0);
    assert.match(upgrade.stderr, /deactivate it before installing a new version/);

    const lock = JSON.parse(await readFile(path.join(project, ".harness", "lock.json"), "utf8")) as {
      packages: Record<string, { version: string }>;
    };
    assert.equal(lock.packages["cli-state"]?.version, "1.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI onboarding gives an actionable performance binding when no benchmark is detected", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-onboard-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    await write(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const result = await runCli(
      ["--project", project, "onboard", "--agent", "codex", "--target", "codex", "--no-switch"],
      root,
      home,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /performance\s+needs benchmark binding: harness bind benchmark <command>/);
    assert.doesNotMatch(result.stdout, /needs test binding/);
    const config = await readFile(path.join(project, ".harness", "project.yaml"), "utf8");
    assert.match(config, /performance-engineering/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI install locks a meta-skill and its dependencies", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-dependencies-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const child = path.join(root, "paper-search");
  const meta = path.join(root, "auto-research");
  try {
    await write(
      path.join(child, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: paper-search
  version: 1.0.0
  description: Search papers.
spec:
  platforms: [codex]
  skills:
    - name: paper-search
      path: ./skills/paper-search
`,
    );
    await write(path.join(child, "skills", "paper-search", "SKILL.md"), "---\ndescription: Search papers.\n---\nSearch.\n");
    await write(
      path.join(meta, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: auto-research
  version: 1.0.0
  description: Complete research method.
spec:
  platforms: [codex]
  dependencies:
    - name: paper-search
      version: ^1.0.0
      source: ../paper-search
  entrypoints:
    - name: research
      skill: auto-research
      description: Run the complete research method.
  skills:
    - name: auto-research
      path: ./skills/auto-research
`,
    );
    await write(path.join(meta, "skills", "auto-research", "SKILL.md"), "---\ndescription: Complete research.\n---\nResearch.\n");

    const result = await runCli(["--project", project, "install", meta], root, home);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /dependencies\s+paper-search@1\.0\.0/);
    const lock = JSON.parse(await readFile(path.join(project, ".harness", "lock.json"), "utf8")) as {
      packages: Record<string, { dependencies: string[] }>;
    };
    assert.deepEqual(Object.keys(lock.packages), ["paper-search", "auto-research"]);
    assert.deepEqual(lock.packages["auto-research"]?.dependencies, ["paper-search"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
