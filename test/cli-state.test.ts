import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { removeTestTree } from "./helpers.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

let cliRun = 0;

async function runCli(args: string[], cwd: string, home: string): Promise<CommandResult> {
  const cli = path.resolve("dist/src/cli.js");
  const previous = {
    argv: process.argv,
    cwd: process.cwd(),
    harnessHome: process.env.HARNESS_HOME,
    exitCode: process.exitCode,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
  };
  let stdout = "";
  let stderr = "";
  process.argv = [process.execPath, cli, ...args];
  process.chdir(cwd);
  process.env.HARNESS_HOME = home;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await import(`${pathToFileURL(cli).href}?test-run=${cliRun++}`);
    return { code: typeof process.exitCode === "number" ? process.exitCode : 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdoutWrite;
    process.stderr.write = previous.stderrWrite;
  }
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

test("CLI exports and imports a portable Environment bundle", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-bundle-"));
  const project = path.join(root, "project");
  const homeA = path.join(root, "home-a");
  const homeB = path.join(root, "home-b");
  const bundle = path.join(root, "portable.harness-env");
  try {
    const pkg = await packageFixture(root, "portable-skill");
    assert.equal((await runCli(["--project", project, "env", "create", "portable", "--target", "codex"], root, homeA)).code, 0);
    assert.equal((await runCli(["--project", project, "install", "-n", "portable", pkg], root, homeA)).code, 0);
    const exported = await runCli(
      ["--project", project, "env", "export", "--name", "portable", "--output", bundle],
      root,
      homeA,
    );
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Exported environment portable/);
    await rm(pkg, { recursive: true, force: true });
    await removeTestTree(homeA);

    const imported = await runCli(["--project", project, "env", "import", bundle, "--name", "restored"], root, homeB);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /Imported environment restored/);
    assert.match(
      await readFile(path.join(homeB, "environments", "restored", "view", "codex", "skills", "portable-skill", "SKILL.md"), "utf8"),
      /portable-skill/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("CLI exposes environment commands and removes workflow phase commands", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-help-"));
  try {
    const result = await runCli(["--help"], root, path.join(root, "home"));
    assert.equal(result.code, 0, result.stderr);
    for (const command of ["env", "migrate", "install", "activate", "deactivate", "info", "sync", "doctor", "shell"]) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    }
    for (const command of ["bind", "current", "onboard", "project", "profile", "switch", "leave", "handoff", "outcome", "stats", "enter", "use", "eval"]) {
      assert.doesNotMatch(result.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
    }
    const removed = await runCli(["bind", "test", "npm", "test"], root, path.join(root, "home"));
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, /unknown command ['"]bind['"]/);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI provides base from an explicit project when invoked in a subdirectory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-base-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "nested");
  try {
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(path.join(project, ".git"), { recursive: true })]);
    const pkg = await packageFixture(root, "base-skill");
    const shellHook = await runCli(["shell", "hook", "bash"], project, home);
    assert.equal(shellHook.code, 0, shellHook.stderr);
    assert.match(shellHook.stdout, /__harness_apply_env/);
    assert.match(await readFile(path.join(home, "environments", "base", "view", "view.json"), "utf8"), /"environment": "base"/);
    const initial = await runCli(["info", "--json"], project, home);
    assert.equal(initial.code, 0, initial.stderr);
    assert.equal((JSON.parse(initial.stdout) as { environment: { name: string } }).environment.name, "base");
    const baseLock = JSON.parse(await readFile(path.join(home, "environments", "base", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseLock.packages), ["harness-project-memory", "harness-package-builder"]);

    const install = await runCli(["install", pkg], project, home);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /into base/);
    const activate = await runCli(["--project", project, "activate"], nested, home);
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /Activated environment base/);
    assert.match(await readFile(path.join(home, "environments", "base", "view", "codex", "skills", "harness-project-memory", "SKILL.md"), "utf8"), /Persist stable knowledge automatically/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);

    const current = await runCli(["--project", project, "info", "--json"], nested, home);
    assert.equal(current.code, 0, current.stderr);
    assert.equal((JSON.parse(current.stdout) as { environment: { name: string } }).environment.name, "base");
    const structured = await runCli(["--project", project, "info", "--json"], nested, home);
    assert.equal(structured.code, 0, structured.stderr);
    const context = JSON.parse(structured.stdout) as {
      projectRoot: string;
      environment: { name: string };
      packages: { name: string; skills: string[]; memory: string }[];
    };
    assert.equal(context.projectRoot, project);
    assert.equal(context.environment.name, "base");
    assert.deepEqual(context.packages.map((pkg) => pkg.name), ["harness-project-memory", "harness-package-builder", "base-skill"]);
    assert.deepEqual(context.packages[0]?.skills, ["harness-project-memory"]);
    assert.match(context.packages.find((pkg) => pkg.name === "base-skill")?.memory ?? "", /\.harness\/memory\/packages\/base-skill\.md$/);

    assert.equal((await runCli(["--project", project, "env", "create", "research", "--target", "codex"], nested, home)).code, 0);
    assert.equal((await runCli(["--project", project, "activate", "research"], nested, home)).code, 0);
    const activateDefault = await runCli(["--project", project, "activate"], nested, home);
    assert.equal(activateDefault.code, 0, activateDefault.stderr);
    assert.match(activateDefault.stdout, /Activated environment base/);
    const deactivate = await runCli(["--project", project, "deactivate"], nested, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI uses the exact working directory instead of a parent Project Memory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-project-boundary-"));
  const workspace = path.join(root, "workspace");
  const project = path.join(workspace, "project");
  const parentMemory = path.join(workspace, ".harness", "memory", "project.md");
  try {
    await mkdir(project, { recursive: true });
    await write(parentMemory, "# Parent Memory\n");

    const activated = await runCli(["activate"], project, path.join(root, "home"));

    assert.equal(activated.code, 0, activated.stderr);
    assert.match(await readFile(path.join(project, ".harness", "memory", "project.md"), "utf8"), /Project Memory/);
    await assert.rejects(access(path.join(project, ".harness", "state.json")));
    assert.equal(await readFile(parentMemory, "utf8"), "# Parent Memory\n");
  } finally {
    await removeTestTree(root);
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
    assert.match(create.stdout, /foundational harness-project-memory@0\.1\.0, harness-package-builder@1\.0\.0/);
    const activate = await runCli(["--project", project, "activate", "minimal"], root, path.join(root, "home"));
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);
    const current = JSON.parse((await runCli(["--project", project, "info", "--json"], root, path.join(root, "home"))).stdout) as {
      packages: { name: string }[];
    };
    assert.deepEqual(current.packages.map((pkg) => pkg.name), ["harness-project-memory", "harness-package-builder"]);
    assert.match(
      await readFile(path.join(root, "home", "environments", "minimal", "view", "codex", "skills", "harness-project-memory", "SKILL.md"), "utf8"),
      /Persist stable knowledge automatically/,
    );
    assert.match(
      await readFile(path.join(root, "home", "environments", "minimal", "view", "codex", "skills", "harness-package-builder", "SKILL.md"), "utf8"),
      /Create one ordinary Harness Package/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("CLI installs and activates a complete Package dependency closure", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-environment-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
  try {
    await packageFixture(root, "paper-search");
    const methodPackage = await packageFixture(root, "auto-research", [{ name: "paper-search", source: "../paper-search" }]);
    const idea = await packageFixture(root, "idea-gen");
    const create = await runCli(["--project", project, "env", "create", "research", "--target", "codex"], root, home);
    assert.equal(create.code, 0, create.stderr);
    const install = await runCli(["--project", project, "install", "-n", "research", methodPackage], root, home);
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
    assert.match(activate.stdout, /packages\s+harness-project-memory, harness-package-builder, paper-search, auto-research/);
    assert.doesNotMatch(await readFile(path.join(project, ".gitignore"), "utf8"), /state\.json/);
    assert.match(await readFile(path.join(project, ".gitignore"), "utf8"), /\/\.harness\/local\//);
    assert.match(await readFile(path.join(project, ".harness", "memory", "project.md"), "utf8"), /Project Memory/);
    await access(path.join(project, ".harness", "memory", "packages"));
    const researchSkills = path.join(home, "environments", "research", "view", "codex", "skills");
    assert.match(await readFile(path.join(researchSkills, "harness-project-memory", "SKILL.md"), "utf8"), /harness info --json/);
    assert.match(await readFile(path.join(researchSkills, "paper-search", "SKILL.md"), "utf8"), /paper-search/);
    assert.match(await readFile(path.join(researchSkills, "auto-research", "SKILL.md"), "utf8"), /auto-research/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);
    process.env.HARNESS_ENV = "research";

    const current = await runCli(["--project", project, "info"], root, home);
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Environment: research/);
    assert.match(current.stdout, /roots\s+harness-project-memory, harness-package-builder, auto-research/);
    const list = await runCli(["--project", project, "env", "list"], root, home);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /\* research/);
    const show = await runCli(["--project", project, "env", "show", "research"], root, home);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /paper-search@1\.0\.0/);
    const installWhileActive = await runCli(["--project", project, "install", idea], root, home);
    assert.equal(installWhileActive.code, 0, installWhileActive.stderr);
    assert.match(installWhileActive.stdout, /Installed idea-gen@1\.0\.0 into research/);
    assert.match(await readFile(path.join(researchSkills, "idea-gen", "SKILL.md"), "utf8"), /idea-gen/);
    const activeContext = JSON.parse((await runCli(["--project", project, "info", "--json"], root, home)).stdout) as {
      packages: { name: string; skills: string[] }[];
    };
    assert.deepEqual(activeContext.packages.find((pkg) => pkg.name === "idea-gen")?.skills, ["idea-gen"]);
    const removeWhileActive = await runCli(["--project", project, "env", "remove", "research"], root, home);
    assert.notEqual(removeWhileActive.code, 0);
    assert.match(removeWhileActive.stderr, /is active.*deactivate/);
    const doctor = await runCli(["--project", project, "doctor", "-n", "research"], root, home);
    assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
    assert.match(doctor.stdout, /\[ok\] view:/);
    assert.match(doctor.stdout, /\[ok\] memory-bootstrap/);

    const deactivate = await runCli(["--project", project, "deactivate"], root, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
    process.env.HARNESS_ENV = "base";
    const baseSkills = path.join(home, "environments", "base", "view", "codex", "skills");
    await assert.rejects(readFile(path.join(baseSkills, "paper-search", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(baseSkills, "auto-research", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(baseSkills, "idea-gen", "SKILL.md")), /ENOENT/);
    assert.match(await readFile(path.join(baseSkills, "harness-project-memory", "SKILL.md"), "utf8"), /Project Memory/);
    assert.match(await readFile(path.join(baseSkills, "harness-package-builder", "SKILL.md"), "utf8"), /Create one ordinary Harness Package/);
    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);
    assert.match(await readFile(path.join(project, ".harness", "memory", "project.md"), "utf8"), /Project Memory/);
    const removeEnvironment = await runCli(["--project", project, "env", "remove", "research"], root, home);
    assert.equal(removeEnvironment.code, 0, removeEnvironment.stderr);
    await assert.rejects(readFile(path.join(home, "environments", "research", "environment.yaml")), /ENOENT/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("CLI atomically switches environments", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-switch-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
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
    process.env.HARNESS_ENV = "first";

    const installActive = await runCli(["--project", project, "install", second], root, home);
    assert.equal(installActive.code, 0, installActive.stderr);
    assert.match(await readFile(path.join(home, "environments", "first", "view", "codex", "skills", "first-skill", "SKILL.md"), "utf8"), /first-skill/);
    const switched = await runCli(["--project", project, "activate", "second"], root, home);
    assert.equal(switched.code, 0, switched.stderr);
    process.env.HARNESS_ENV = "second";
    assert.match(await readFile(path.join(home, "environments", "first", "view", "codex", "skills", "first-skill", "SKILL.md"), "utf8"), /first-skill/);
    assert.match(await readFile(path.join(home, "environments", "second", "view", "codex", "skills", "second-skill", "SKILL.md"), "utf8"), /second-skill/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});
