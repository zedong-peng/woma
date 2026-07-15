import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("dist/src/cli.js");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function fixture(root: string, version: string): Promise<string> {
  const packageRoot = path.join(root, `package-${version}`);
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: cli-upgrade
  version: ${version}
  description: CLI upgrade fixture.
spec:
  platforms: [codex]
  skills:
    - name: cli-workflow
      path: ./skills/cli-workflow
`,
  );
  await write(path.join(packageRoot, "skills", "cli-workflow", "SKILL.md"), `---\ndescription: Version ${version}.\n---\n${version}\n`);
  return packageRoot;
}

test("CLI refuses to replace the lock for an active package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-"));
  const project = path.join(root, "project");
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...baseEnv } = process.env;
  const env = { ...baseEnv, HARNESS_HOME: path.join(root, "home") };
  try {
    const versionOne = await fixture(root, "1.0.0");
    const versionTwo = await fixture(root, "2.0.0");
    assert.equal((await runCli(["--project", project, "install", versionOne], env)).code, 0);
    assert.equal((await runCli(["--project", project, "activate", "cli-upgrade", "--target", "codex"], env)).code, 0);

    const failure = await runCli(["--project", project, "install", versionTwo], env);
    assert.notEqual(failure.code, 0, "installing a different version of an active package must fail");
    const lock = JSON.parse(await readFile(path.join(project, ".harness", "lock.json"), "utf8")) as Record<string, any>;
    assert.equal(lock.packages["cli-upgrade"].version, "1.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
