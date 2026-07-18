import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function packageFixture(
  root: string,
  name: string,
  dependencies: { name: string; source: string }[] = [],
): Promise<string> {
  const packageRoot = path.join(root, name);
  const dependencyYaml = dependencies.length === 0
    ? ""
    : `  dependencies:\n${dependencies
        .map((dependency) => `    - name: ${dependency.name}\n      version: ^1.0.0\n      source: ${dependency.source}`)
        .join("\n")}\n`;
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: ${name}
  version: 1.0.0
  description: ${name} fixture.
spec:
  platforms: [codex, claude]
${dependencyYaml}  skills:
    - name: ${name}
      path: ./skills/${name}
`,
  );
  await write(path.join(packageRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}.\n---\n\n${name}.\n`);
  return packageRoot;
}

test("built CLI entrypoint is executable", async () => {
  await access(path.resolve("dist/src/cli.js"), constants.X_OK);
});

test("CLI exposes environment commands and removes workflow phase commands", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-help-"));
  try {
    const result = await runCli(["--help"], root, path.join(root, "home"));
    assert.equal(result.code, 0, result.stderr);
    for (const command of ["env", "install", "activate", "deactivate", "info", "sync", "doctor", "shell"]) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    }
    for (const command of ["bind", "current", "onboard", "project", "profile", "switch", "leave", "handoff", "outcome", "stats", "enter", "use", "eval"]) {
      assert.doesNotMatch(result.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
    }
    const removed = await runCli(["bind", "test", "npm", "test"], root, path.join(root, "home"));
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, /unknown command ['"]bind['"]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI provides a Conda-style base environment default from project subdirectories", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-base-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "nested");
  try {
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(path.join(project, ".git"), { recursive: true })]);
    const pkg = await packageFixture(root, "base-skill");
    const initial = await runCli(["info", "--json"], project, home);
    assert.equal(initial.code, 0, initial.stderr);
    assert.equal((JSON.parse(initial.stdout) as { environment: { name: string } }).environment.name, "base");
    const baseLock = JSON.parse(await readFile(path.join(home, "environments", "base", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseLock.packages), ["harness-project-memory", "meta-skill-builder"]);

    const install = await runCli(["install", pkg], project, home);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /into base/);
    const activate = await runCli(["activate"], nested, home);
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /Activated environment base/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "harness-project-memory", "SKILL.md"), "utf8"), /Persist stable knowledge automatically/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /\.agents\/skills\/harness-project-memory\/SKILL\.md/);

    const current = await runCli(["info", "--json"], nested, home);
    assert.equal(current.code, 0, current.stderr);
    assert.equal((JSON.parse(current.stdout) as { environment: { name: string } }).environment.name, "base");
    const structured = await runCli(["info", "--json"], nested, home);
    assert.equal(structured.code, 0, structured.stderr);
    const context = JSON.parse(structured.stdout) as {
      projectRoot: string;
      environment: { name: string };
      packages: { name: string; skills: string[]; memory: string }[];
    };
    assert.equal(context.projectRoot, project);
    assert.equal(context.environment.name, "base");
    assert.deepEqual(context.packages.map((pkg) => pkg.name), ["harness-project-memory", "meta-skill-builder", "base-skill"]);
    assert.deepEqual(context.packages[0]?.skills, ["harness-project-memory"]);
    assert.match(context.packages.find((pkg) => pkg.name === "base-skill")?.memory ?? "", /\.harness\/memory\/packages\/base-skill\.md$/);

    assert.equal((await runCli(["env", "create", "research", "--target", "codex"], nested, home)).code, 0);
    assert.equal((await runCli(["activate", "research"], nested, home)).code, 0);
    const activateDefault = await runCli(["activate"], nested, home);
    assert.equal(activateDefault.code, 0, activateDefault.stderr);
    assert.match(activateDefault.stdout, /Activated environment base/);
    const deactivate = await runCli(["deactivate"], nested, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI always includes foundational packages and rejects the removed without-memory option", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-foundations-"));
  const project = path.join(root, "project");
  try {
    const removedOption = await runCli(
      ["--project", project, "env", "create", "minimal", "--target", "codex", "--without-memory"],
      root,
      path.join(root, "home"),
    );
    assert.notEqual(removedOption.code, 0);
    assert.match(removedOption.stderr, /unknown option '--without-memory'/);
    const create = await runCli(
      ["--project", project, "env", "create", "minimal", "--target", "codex"],
      root,
      path.join(root, "home"),
    );
    assert.equal(create.code, 0, create.stderr);
    assert.match(create.stdout, /foundational harness-project-memory@0\.1\.0, meta-skill-builder@1\.0\.0/);
    const activate = await runCli(["--project", project, "activate", "minimal"], root, path.join(root, "home"));
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /harness-project-memory\/SKILL\.md/);
    const current = JSON.parse((await runCli(["--project", project, "info", "--json"], root, path.join(root, "home"))).stdout) as {
      packages: { name: string }[];
    };
    assert.deepEqual(current.packages.map((pkg) => pkg.name), ["harness-project-memory", "meta-skill-builder"]);
    assert.match(
      await readFile(path.join(project, ".agents", "skills", "harness-project-memory", "SKILL.md"), "utf8"),
      /Persist stable knowledge automatically/,
    );
    assert.match(
      await readFile(path.join(project, ".agents", "skills", "meta-skill-builder", "SKILL.md"), "utf8"),
      /meta-skill/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI installs and activates a complete meta-skill dependency closure", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-environment-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    await packageFixture(root, "paper-search");
    const meta = await packageFixture(root, "auto-research", [{ name: "paper-search", source: "../paper-search" }]);
    const idea = await packageFixture(root, "idea-gen");
    const create = await runCli(["--project", project, "env", "create", "research", "--target", "codex"], root, home);
    assert.equal(create.code, 0, create.stderr);
    const install = await runCli(["--project", project, "install", "-n", "research", meta], root, home);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /dependencies\s+paper-search@1\.0\.0/);
    const lock = JSON.parse(await readFile(path.join(home, "environments", "research", "lock.json"), "utf8")) as {
      packages: Record<string, { cacheKey: string }>;
    };
    for (const [name, pkg] of Object.entries(lock.packages)) {
      await rm(path.join(home, "packages", name, pkg.cacheKey), { recursive: true, force: true });
    }
    const sync = await runCli(["--project", project, "sync", "-n", "research"], root, home);
    assert.equal(sync.code, 0, sync.stderr);
    assert.match(sync.stdout, /Synced research: 4 packages/);
    const activate = await runCli(["--project", project, "activate", "research"], root, home);
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /packages\s+harness-project-memory, meta-skill-builder, paper-search, auto-research/);
    assert.match(await readFile(path.join(project, ".gitignore"), "utf8"), /\/\.harness\/state\.json/);
    assert.match(await readFile(path.join(project, ".gitignore"), "utf8"), /\/\.harness\/local\//);
    assert.match(await readFile(path.join(project, ".harness", "memory", "project.md"), "utf8"), /Project Memory/);
    await access(path.join(project, ".harness", "memory", "packages"));
    assert.match(await readFile(path.join(project, ".agents", "skills", "harness-project-memory", "SKILL.md"), "utf8"), /harness info --json/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "paper-search", "SKILL.md"), "utf8"), /paper-search/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "auto-research", "SKILL.md"), "utf8"), /auto-research/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /\.agents\/skills\/harness-project-memory\/SKILL\.md/);

    const current = await runCli(["--project", project, "info"], root, home);
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Environment: research/);
    assert.match(current.stdout, /roots\s+harness-project-memory, meta-skill-builder, auto-research/);
    const list = await runCli(["--project", project, "env", "list"], root, home);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /\* research/);
    const show = await runCli(["--project", project, "env", "show", "research"], root, home);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /paper-search@1\.0\.0/);
    const installWhileActive = await runCli(["--project", project, "install", idea], root, home);
    assert.equal(installWhileActive.code, 0, installWhileActive.stderr);
    assert.match(installWhileActive.stdout, /Installed idea-gen@1\.0\.0 into research/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "idea-gen", "SKILL.md"), "utf8"), /idea-gen/);
    const activeContext = JSON.parse((await runCli(["--project", project, "info", "--json"], root, home)).stdout) as {
      packages: { name: string; skills: string[] }[];
    };
    assert.deepEqual(activeContext.packages.find((pkg) => pkg.name === "idea-gen")?.skills, ["idea-gen"]);
    const removeWhileActive = await runCli(["--project", project, "env", "remove", "research"], root, home);
    assert.notEqual(removeWhileActive.code, 0);
    assert.match(removeWhileActive.stderr, /is active.*deactivate/);
    const doctor = await runCli(["--project", project, "doctor", "-n", "research"], root, home);
    assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
    assert.match(doctor.stdout, /\[ok\] active:auto-research/);
    assert.match(doctor.stdout, /\[ok\] active:idea-gen/);
    assert.match(doctor.stdout, /\[ok\] memory-bootstrap/);

    const deactivate = await runCli(["--project", project, "deactivate"], root, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "paper-search", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "auto-research", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "idea-gen", "SKILL.md")), /ENOENT/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "harness-project-memory", "SKILL.md"), "utf8"), /Project Memory/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "meta-skill-builder", "SKILL.md"), "utf8"), /meta-skill/i);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /harness-project-memory\/SKILL\.md/);
    assert.match(await readFile(path.join(project, ".harness", "memory", "project.md"), "utf8"), /Project Memory/);
    const removeEnvironment = await runCli(["--project", project, "env", "remove", "research"], root, home);
    assert.equal(removeEnvironment.code, 0, removeEnvironment.stderr);
    await assert.rejects(readFile(path.join(home, "environments", "research", "environment.yaml")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI atomically switches environments", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-switch-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    const first = await packageFixture(root, "first-skill");
    const second = await packageFixture(root, "second-skill");
    for (const name of ["first", "second"]) {
      const create = await runCli(["--project", project, "env", "create", name, "--target", "codex"], root, home);
      assert.equal(create.code, 0, create.stderr);
    }
    assert.equal((await runCli(["--project", project, "install", "-n", "first", first], root, home)).code, 0);
    assert.equal((await runCli(["--project", project, "install", "-n", "second", second], root, home)).code, 0);
    assert.equal((await runCli(["--project", project, "activate", "first"], root, home)).code, 0);

    const installActive = await runCli(["--project", project, "install", second], root, home);
    assert.equal(installActive.code, 0, installActive.stderr);
    assert.match(await readFile(path.join(project, ".agents", "skills", "first-skill", "SKILL.md"), "utf8"), /first-skill/);
    const switched = await runCli(["--project", project, "activate", "second"], root, home);
    assert.equal(switched.code, 0, switched.stderr);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "first-skill", "SKILL.md")), /ENOENT/);
    assert.match(await readFile(path.join(project, ".agents", "skills", "second-skill", "SKILL.md"), "utf8"), /second-skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
