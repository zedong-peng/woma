import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
    womaHome: process.env.WOMA_HOME,
    exitCode: process.exitCode,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
  };
  let stdout = "";
  let stderr = "";
  process.argv = [process.execPath, cli, ...args];
  process.chdir(cwd);
  process.env.WOMA_HOME = home;
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
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdoutWrite;
    process.stderr.write = previous.stderrWrite;
  }
}

async function runCliProcess(args: string[], cwd: string, home: string, timeoutMs = 10_000): Promise<CommandResult> {
  const cli = path.resolve("dist/src/cli.js");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, WOMA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function helpCommandNames(output: string): string[] {
  const commands = output.split("\nCommands:\n", 2)[1];
  assert.ok(commands, "help output should include a Commands section");
  return commands
    .split("\n")
    .flatMap((line) => line.match(/^  (\S+)/)?.[1] ?? []);
}

test("CLI help lists commands alphabetically", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-help-"));
  try {
    for (const args of [["-h"], ["env", "-h"]]) {
      const result = await runCliProcess(args, root, path.join(root, "home"));
      assert.equal(result.code, 0, result.stderr);
      const commands = helpCommandNames(result.stdout);
      assert.deepEqual(commands, [...commands].sort((left, right) => left.localeCompare(right)));
    }
  } finally {
    await removeTestTree(root);
  }
});

test("package metadata exposes only the woma executable", async () => {
  const metadata = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { name: string; bin: Record<string, string> };
  assert.equal(metadata.name, "woma");
  assert.deepEqual(metadata.bin, { woma: "dist/src/cli.js" });
});

test("CLI deactivate does not initialize base or write project state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-deactivate-"));
  const home = path.join(root, "home");
  const previousEnvironment = process.env.WOMA_ENV;
  try {
    process.env.WOMA_ENV = "research";
    const result = await runCli(["deactivate"], root, home);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Deactivated environment research/);
    await assert.rejects(access(home));
    await assert.rejects(access(path.join(root, ".woma")));
    await assert.rejects(access(path.join(root, "AGENTS.md")));
    await assert.rejects(access(path.join(root, "CLAUDE.md")));
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

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
    path.join(packageRoot, "woma.yaml"),
    `apiVersion: woma.dev/v1
kind: Woma
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

async function resourcePackageFixture(root: string, name: string): Promise<string> {
  const packageRoot = path.join(root, name);
  await write(
    path.join(packageRoot, "woma.yaml"),
    `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: ${name}
  version: 1.0.0
  description: ${name} resource fixture.
spec:
  platforms: [codex, claude]
  skills:
    - name: ${name}
      path: ./skills/${name}
  mcpServers:
    - name: shared-tools
      transport: stdio
      command: node
    - name: claude-docs
      transport: http
      url: https://example.com/mcp
      platforms: [claude]
  hooks:
    - event: PostToolUse
      matcher: Edit
      command: npm test
      platforms: [codex]
    - event: Stop
      command: npm run check
      platforms: [claude]
`,
  );
  await write(path.join(packageRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}.\n---\n\n${name}.\n`);
  return packageRoot;
}

test("CLI reports existing Agent state once without contaminating stdout", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-existing-state-"));
  const home = path.join(root, "home");
  const codex = path.join(root, "codex-private-name");
  const previous = {
    codex: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claude: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    await mkdir(path.join(codex, "skills"), { recursive: true });
    process.env.WOMA_ORIGINAL_CODEX_HOME = codex;
    process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "claude");

    const first = await runCli(["info", "--json"], root, home);
    assert.equal(first.code, 0, first.stderr);
    assert.equal((JSON.parse(first.stdout) as { environment: { name: string } }).environment.name, "base");
    assert.match(first.stderr, /Woma created an isolated base Environment/);
    assert.match(first.stderr, /woma migrate skills --dry-run/);
    assert.match(first.stderr, /woma migrate sessions --dry-run/);
    assert.doesNotMatch(first.stderr, /codex-private-name/);

    const second = await runCli(["list"], root, home);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Environment: base/);
    assert.equal(second.stderr, "");
  } finally {
    if (previous.codex === undefined) delete process.env.WOMA_ORIGINAL_CODEX_HOME;
    else process.env.WOMA_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("CLI rejects the removed shell command without creating Woma state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-removed-shell-"));
  const home = path.join(root, "home");
  try {
    const result = await runCliProcess(["shell", "hook", "bash"], root, home);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unknown command ['"]shell['"]/);
    await assert.rejects(access(home), { code: "ENOENT" });
  } finally {
    await removeTestTree(root);
  }
});

test("built CLI entrypoint is executable", async () => {
  await access(path.resolve("dist/src/cli.js"), constants.X_OK);
});

test("CLI exports and creates from a portable Environment bundle", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-bundle-"));
  const project = path.join(root, "project");
  const homeA = path.join(root, "home-a");
  const homeB = path.join(root, "home-b");
  const bundle = path.join(root, "portable.woma-env");
  try {
    const pkg = await packageFixture(root, "portable-skill");
    assert.equal((await runCli(["--project", project, "create", "--name", "portable", "--target", "codex"], root, homeA)).code, 0);
    assert.equal((await runCli(["--project", project, "install", "-n", "portable", pkg], root, homeA)).code, 0);
    const exported = await runCli(
      ["--project", project, "export", "--name", "portable", "--file", bundle],
      root,
      homeA,
    );
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, /Exported environment portable/);
    await rm(pkg, { recursive: true, force: true });
    await removeTestTree(homeA);

    const imported = await runCli(["--project", project, "create", "--name", "restored", "--file", bundle], root, homeB);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /Created environment restored/);
    assert.match(
      await readFile(path.join(homeB, "environments", "restored", "view", "codex", "skills", "portable-skill", "SKILL.md"), "utf8"),
      /portable-skill/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("CLI lists all Package-managed resources in a selected Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-list-"));
  const home = path.join(root, "home");
  const previousEnvironment = process.env.WOMA_ENV;
  try {
    delete process.env.WOMA_ENV;
    const pkg = await resourcePackageFixture(root, "listed-resources");
    assert.equal((await runCli(["env", "create", "listed", "--target", "both"], root, home)).code, 0);
    assert.equal((await runCli(["install", "-n", "listed", pkg], root, home)).code, 0);

    const selected = await runCli(["list", "-n", "listed"], root, home);
    assert.equal(selected.code, 0, selected.stderr);
    assert.match(selected.stdout, /Environment: listed/);
    assert.match(selected.stdout, /packages\s+.*listed-resources@1\.0\.0/);
    assert.match(selected.stdout, /skills\n[\s\S]*listed-resources\s+listed-resources@1\.0\.0\s+codex, claude/);
    assert.match(selected.stdout, /mcp servers\n[\s\S]*shared-tools\s+stdio\s+listed-resources@1\.0\.0\s+codex, claude/);
    assert.match(selected.stdout, /claude-docs\s+http\s+listed-resources@1\.0\.0\s+claude/);
    assert.match(selected.stdout, /hooks\n[\s\S]*PostToolUse\s+Edit\s+listed-resources@1\.0\.0\s+codex/);
    assert.match(selected.stdout, /Stop\s+\*\s+listed-resources@1\.0\.0\s+claude/);
    assert.doesNotMatch(selected.stdout, /unavailable packages/);

    assert.equal((await runCli(["env", "create", "listed-codex", "--target", "codex"], root, home)).code, 0);
    assert.equal((await runCli(["install", "-n", "listed-codex", pkg], root, home)).code, 0);
    const codexOnly = await runCli(["list", "-n", "listed-codex"], root, home);
    assert.equal(codexOnly.code, 0, codexOnly.stderr);
    assert.match(codexOnly.stdout, /claude-docs\s+http\s+listed-resources@1\.0\.0\s+none/);
    assert.match(codexOnly.stdout, /Stop\s+\*\s+listed-resources@1\.0\.0\s+none/);

    const current = await runCli(["list"], root, home);
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Environment: base/);
    assert.match(current.stdout, /mcp servers\n    none/);
    assert.match(current.stdout, /hooks\n    none/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("CLI exposes environment commands and removes workflow phase commands", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-help-"));
  try {
    const result = await runCliProcess(["--help"], root, path.join(root, "home"));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Usage: woma(?: |$)/m);
    for (const command of ["activate", "create", "deactivate", "doctor", "env", "export", "info", "install", "list", "migrate", "remove", "rename", "run"]) {
      assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
    }
    for (const command of ["bind", "current", "sync", "shell", "onboard", "project", "profile", "switch", "leave", "handoff", "outcome", "stats", "enter", "use", "eval"]) {
      assert.doesNotMatch(result.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
    }
    const removed = await runCliProcess(["bind", "test", "npm", "test"], root, path.join(root, "home"));
    assert.notEqual(removed.code, 0);
    assert.match(removed.stderr, /unknown command ['"]bind['"]/);
    const removedSync = await runCliProcess(["sync"], root, path.join(root, "home"));
    assert.notEqual(removedSync.code, 0);
    assert.match(removedSync.stderr, /unknown command ['"]sync['"]/);
    const envHelp = await runCliProcess(["env", "--help"], root, path.join(root, "home"));
    assert.doesNotMatch(envHelp.stdout, /^  import(?: |$)/m);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI creates Pi and all-target Environments", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-pi-target-"));
  const home = path.join(root, "home");
  try {
    const piOnly = await runCli(["env", "create", "pi-only", "--target", "pi"], root, home);
    assert.equal(piOnly.code, 0, piOnly.stderr);
    assert.match(piOnly.stdout, /targets pi/);
    assert.match(await readFile(path.join(home, "environments", "pi-only", "environment.yaml"), "utf8"), /targets:[\s\S]*- pi/);

    const qoderOnly = await runCli(["env", "create", "qoder-only", "--target", "qoder"], root, home);
    assert.equal(qoderOnly.code, 0, qoderOnly.stderr);
    assert.match(qoderOnly.stdout, /targets qoder/);
    assert.match(await readFile(path.join(home, "environments", "qoder-only", "environment.yaml"), "utf8"), /targets:[\s\S]*- qoder/);

    const all = await runCli(["env", "create", "all-agents", "--target", "all"], root, home);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /targets codex, claude, pi, qoder/);
    assert.match(await readFile(path.join(home, "environments", "all-agents", "view", "view.json"), "utf8"), /"qoder"/);

    const bundle = path.join(root, "all-agents.woma-env");
    assert.equal((await runCli(["env", "export", "--name", "all-agents", "--output", bundle], root, home)).code, 0);
    const imported = await runCli(["create", "--file", bundle, "--name", "all-agents-copy"], root, home);
    assert.equal(imported.code, 0, imported.stderr);
    const metadata = JSON.parse(await readFile(path.join(home, "environments", "all-agents-copy", "view", "view.json"), "utf8"));
    assert.deepEqual(metadata.packages, []);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI info reports Agent executables found on PATH", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-agent-info-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const previousPath = process.env.PATH;
  try {
    await mkdir(bin, { recursive: true });
    for (const command of ["codex", "qodercli"]) {
      const executable = path.join(bin, command);
      await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executable, 0o755);
    }
    process.env.PATH = bin;

    const jsonResult = await runCli(["info", "--json"], root, home);
    assert.equal(jsonResult.code, 0, jsonResult.stderr);
    const context = JSON.parse(jsonResult.stdout) as {
      agentClis: Record<string, { command: string; available: boolean; path: string | null }>;
    };
    assert.deepEqual(context.agentClis.codex, { command: "codex", available: true, path: path.join(bin, "codex") });
    assert.deepEqual(context.agentClis.claude, { command: "claude", available: false, path: null });
    assert.deepEqual(context.agentClis.pi, { command: "pi", available: false, path: null });
    assert.deepEqual(context.agentClis.qoder, { command: "qodercli", available: true, path: path.join(bin, "qodercli") });

    const humanResult = await runCli(["info"], root, home);
    assert.equal(humanResult.code, 0, humanResult.stderr);
    assert.ok(humanResult.stdout.includes(`codex   ${path.join(bin, "codex")}`));
    assert.match(humanResult.stdout, /claude\s+claude not found on PATH/);
    assert.ok(humanResult.stdout.includes(`qoder   ${path.join(bin, "qodercli")}`));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await removeTestTree(root);
  }
});

test("CLI runs a command in a selected Environment and preserves its exit code", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-run-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    const created = await runCli(["--project", project, "create", "-n", "runner", "--target", "codex"], root, home);
    assert.equal(created.code, 0, created.stderr);
    const script = "process.stdout.write(JSON.stringify({ environment: process.env.WOMA_ENV, codex: process.env.CODEX_HOME })); process.exit(7)";
    const result = await runCliProcess(
      ["--project", project, "run", "--name", "runner", process.execPath, "-e", script],
      root,
      home,
    );
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      environment: "runner",
      codex: path.join(home, "environments", "runner", "home", "codex"),
    });
  } finally {
    await removeTestTree(root);
  }
});

test("CLI renames an inactive Environment without losing Agent-owned state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-rename-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.WOMA_ENV;
  try {
    delete process.env.WOMA_ENV;
    assert.equal((await runCli(["--project", project, "create", "-n", "before", "--target", "codex"], root, home)).code, 0);
    const authHome = path.join(home, "environments", "before", "home", "codex", "auth.json");
    await write(authHome, '{"token":"current"}\n');
    const opaque = path.join(home, "environments", "before", "home", "codex", "session.sqlite");
    await write(opaque, "state\n");
    const futureLink = path.join(home, "environments", "before", "home", "codex", "future.json");
    await symlink(path.join(home, "environments", "before", "view", "codex", "future.json"), futureLink);

    const renamed = await runCli(["--project", project, "rename", "--name", "before", "after"], root, home);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.match(renamed.stdout, /Renamed environment before to after/);
    await assert.rejects(access(path.join(home, "environments", "before")), /ENOENT/);
    const renamedAuth = path.join(home, "environments", "after", "home", "codex", "auth.json");
    assert.equal((await lstat(renamedAuth)).isSymbolicLink(), false);
    assert.equal(await readFile(renamedAuth, "utf8"), '{"token":"current"}\n');
    assert.equal(await readFile(path.join(home, "environments", "after", "home", "codex", "session.sqlite"), "utf8"), "state\n");
    assert.equal(
      await readlink(path.join(home, "environments", "after", "home", "codex", "future.json")),
      path.join(home, "environments", "after", "view", "codex", "future.json"),
    );
    assert.match(await readFile(path.join(home, "environments", "after", "environment.yaml"), "utf8"), /name: after/);
    const doctor = await runCli(["--project", project, "doctor", "--name", "after"], root, home);
    assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
    assert.match(doctor.stdout, /\[ok\] view:/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("CLI provides base from an explicit project when invoked in a subdirectory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-base-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "nested");
  try {
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(path.join(project, ".git"), { recursive: true })]);
    const pkg = await packageFixture(root, "base-skill");
    const initial = await runCli(["info", "--json"], project, home);
    assert.equal(initial.code, 0, initial.stderr);
    assert.equal((JSON.parse(initial.stdout) as { environment: { name: string } }).environment.name, "base");
    assert.match(await readFile(path.join(home, "environments", "base", "view", "view.json"), "utf8"), /"environment": "base"/);
    const baseLock = JSON.parse(await readFile(path.join(home, "environments", "base", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseLock.packages), []);

    const install = await runCli(["install", pkg], project, home);
    assert.equal(install.code, 0, install.stderr);
    assert.match(install.stdout, /into base/);
    const activate = await runCli(["--project", project, "activate"], nested, home);
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /Activated environment base/);
    assert.match(await readFile(path.join(home, "environments", "base", "view", "codex", "skills", "base-skill", "SKILL.md"), "utf8"), /base-skill/);
    await assert.rejects(access(path.join(project, "AGENTS.md")), /ENOENT/);

    const current = await runCli(["--project", project, "info", "--json"], nested, home);
    assert.equal(current.code, 0, current.stderr);
    assert.equal((JSON.parse(current.stdout) as { environment: { name: string } }).environment.name, "base");
    const structured = await runCli(["--project", project, "info", "--json"], nested, home);
    assert.equal(structured.code, 0, structured.stderr);
    const context = JSON.parse(structured.stdout) as {
      projectRoot: string;
      environment: { name: string };
      packages: { name: string; skills: string[] }[];
      memory?: unknown;
    };
    assert.equal(context.projectRoot, project);
    assert.equal(context.environment.name, "base");
    assert.deepEqual(context.packages.map((pkg) => pkg.name), ["base-skill"]);
    assert.deepEqual(context.packages[0]?.skills, ["base-skill"]);
    assert.equal(context.memory, undefined);

    assert.equal((await runCli(["--project", project, "env", "create", "research", "--target", "codex"], nested, home)).code, 0);
    assert.equal((await runCli(["--project", project, "activate", "research"], nested, home)).code, 0);
    const activateDefault = await runCli(["--project", project, "activate"], nested, home);
    assert.equal(activateDefault.code, 0, activateDefault.stderr);
    assert.match(activateDefault.stdout, /Activated environment base/);
    const deactivate = await runCli(["--project", project, "deactivate"], nested, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
    assert.match(deactivate.stdout, /Deactivated environment base/);
    assert.doesNotMatch(deactivate.stdout, /using base/);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI activation does not read or create Project Memory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-project-boundary-"));
  const workspace = path.join(root, "workspace");
  const project = path.join(workspace, "project");
  const parentMemory = path.join(workspace, ".woma", "memory", "project.md");
  try {
    await mkdir(project, { recursive: true });
    await write(parentMemory, "# Parent Memory\n");

    const activated = await runCli(["activate"], project, path.join(root, "home"));

    assert.equal(activated.code, 0, activated.stderr);
    await assert.rejects(access(path.join(project, ".woma")), /ENOENT/);
    assert.equal(await readFile(parentMemory, "utf8"), "# Parent Memory\n");
  } finally {
    await removeTestTree(root);
  }
});

test("CLI creates an empty Environment and exposes no Memory option", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-foundations-"));
  const project = path.join(root, "project");
  try {
    const removedOption = await runCliProcess(
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
    assert.doesNotMatch(create.stdout, /foundational|memory/i);
    const activate = await runCli(["--project", project, "activate", "minimal"], root, path.join(root, "home"));
    assert.equal(activate.code, 0, activate.stderr);
    await assert.rejects(access(path.join(project, "AGENTS.md")), /ENOENT/);
    await assert.rejects(access(path.join(project, "CLAUDE.md")), /ENOENT/);
    await assert.rejects(access(path.join(project, ".woma")), /ENOENT/);
    const current = JSON.parse((await runCli(["--project", project, "info", "--json"], root, path.join(root, "home"))).stdout) as {
      packages: { name: string }[];
      memory?: unknown;
    };
    assert.deepEqual(current.packages, []);
    assert.equal(current.memory, undefined);
  } finally {
    await removeTestTree(root);
  }
});

test("CLI installs and activates a complete Package dependency closure", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-environment-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.WOMA_ENV;
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
    const activate = await runCli(["--project", project, "activate", "research"], root, home);
    assert.equal(activate.code, 0, activate.stderr);
    assert.match(activate.stdout, /packages\s+paper-search, auto-research/);
    await assert.rejects(access(path.join(project, ".gitignore")), /ENOENT/);
    await assert.rejects(access(path.join(project, ".woma")), /ENOENT/);
    const researchSkills = path.join(home, "environments", "research", "view", "codex", "skills");
    assert.match(await readFile(path.join(researchSkills, "paper-search", "SKILL.md"), "utf8"), /paper-search/);
    assert.match(await readFile(path.join(researchSkills, "auto-research", "SKILL.md"), "utf8"), /auto-research/);
    await assert.rejects(access(path.join(project, "AGENTS.md")), /ENOENT/);
    process.env.WOMA_ENV = "research";

    const current = await runCli(["--project", project, "info"], root, home);
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Environment: research/);
    assert.match(current.stdout, /roots\s+auto-research/);
    const environmentList = await runCli(["--project", project, "env", "list"], root, home);
    assert.equal(environmentList.code, 0, environmentList.stderr);
    assert.match(environmentList.stdout, /\* research/);
    const list = await runCli(["--project", project, "list", "--name", "research"], root, home);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /paper-search@1\.0\.0/);
    assert.match(list.stdout, /skills\n/);
    assert.match(list.stdout, /paper-search\s+paper-search@1\.0\.0\s+codex/);
    assert.match(list.stdout, /auto-research\s+auto-research@1\.0\.0\s+codex/);
    const activeList = await runCli(["--project", project, "list"], root, home);
    assert.equal(activeList.code, 0, activeList.stderr);
    assert.match(activeList.stdout, /Environment: research \(active\)/);
    const paperSearchLock = lock.packages["paper-search"];
    assert.ok(paperSearchLock);
    await rm(path.join(home, "packages", "paper-search", paperSearchLock.cacheKey), { recursive: true, force: true });
    const listWithMissingCache = await runCli(["--project", project, "list", "--name", "research"], root, home);
    assert.equal(listWithMissingCache.code, 0, listWithMissingCache.stderr);
    assert.match(listWithMissingCache.stdout, /packages\s+.*paper-search@1\.0\.0/);
    assert.match(listWithMissingCache.stdout, /unavailable packages\n\s+paper-search@1\.0\.0\s+Package paper-search@1\.0\.0 is not cached/);
    assert.doesNotMatch(listWithMissingCache.stdout, /\[unavailable\]/);
    assert.match(listWithMissingCache.stdout, /auto-research\s+auto-research@1\.0\.0\s+codex/);
    const repair = await runCli(["--project", project, "install", "-n", "research", methodPackage], root, home);
    assert.equal(repair.code, 0, repair.stderr);
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

    const deactivate = await runCli(["--project", project, "deactivate"], root, home);
    assert.equal(deactivate.code, 0, deactivate.stderr);
    process.env.WOMA_ENV = "base";
    const baseSkills = path.join(home, "environments", "base", "view", "codex", "skills");
    await assert.rejects(readFile(path.join(baseSkills, "paper-search", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(baseSkills, "auto-research", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(baseSkills, "idea-gen", "SKILL.md")), /ENOENT/);
    await assert.rejects(access(path.join(baseSkills, "woma-project-memory")), /ENOENT/);
    await assert.rejects(access(path.join(baseSkills, "woma-package-builder")), /ENOENT/);
    await assert.rejects(access(path.join(project, "AGENTS.md")), /ENOENT/);
    await assert.rejects(access(path.join(project, ".woma")), /ENOENT/);
    const removeEnvironment = await runCli(["--project", project, "env", "remove", "research"], root, home);
    assert.equal(removeEnvironment.code, 0, removeEnvironment.stderr);
    await assert.rejects(readFile(path.join(home, "environments", "research", "environment.yaml")), /ENOENT/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("CLI atomically switches environments", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-switch-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.WOMA_ENV;
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
    process.env.WOMA_ENV = "first";

    const installActive = await runCli(["--project", project, "install", second], root, home);
    assert.equal(installActive.code, 0, installActive.stderr);
    assert.match(await readFile(path.join(home, "environments", "first", "view", "codex", "skills", "first-skill", "SKILL.md"), "utf8"), /first-skill/);
    const switched = await runCli(["--project", project, "activate", "second"], root, home);
    assert.equal(switched.code, 0, switched.stderr);
    process.env.WOMA_ENV = "second";
    assert.match(await readFile(path.join(home, "environments", "first", "view", "codex", "skills", "first-skill", "SKILL.md"), "utf8"), /first-skill/);
    assert.match(await readFile(path.join(home, "environments", "second", "view", "codex", "skills", "second-skill", "SKILL.md"), "utf8"), /second-skill/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("CLI uninstalls from active and explicitly named inactive Environments with a dry-run preview", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-uninstall-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const previousEnvironment = process.env.WOMA_ENV;
  try {
    const removable = await packageFixture(root, "removable-package");
    for (const name of ["active-tools", "inactive-tools"]) {
      const create = await runCli(["--project", project, "env", "create", name], root, home);
      assert.equal(create.code, 0, create.stderr);
      const install = await runCli(["--project", project, "install", "-n", name, removable], root, home);
      assert.equal(install.code, 0, install.stderr);
    }
    const inactiveRecipe = path.join(home, "environments", "inactive-tools", "environment.yaml");
    const beforePreview = await readFile(inactiveRecipe, "utf8");

    const preview = await runCli(
      ["--project", project, "uninstall", "removable-package", "-n", "inactive-tools", "-d"],
      root,
      home,
    );
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /Removal plan for removable-package from inactive-tools/);
    assert.match(preview.stdout, /remove root\s+removable-package/);
    assert.match(preview.stdout, /prune packages\s+removable-package/);
    assert.match(preview.stdout, /remove Skills\s+removable-package/);
    assert.match(preview.stdout, /No changes made\./);
    assert.equal(await readFile(inactiveRecipe, "utf8"), beforePreview);

    const inactive = await runCli(
      ["--project", project, "remove", "removable-package", "--name", "inactive-tools"],
      root,
      home,
    );
    assert.equal(inactive.code, 0, inactive.stderr);
    assert.match(inactive.stdout, /Removed removable-package from inactive-tools/);
    await assert.rejects(
      access(path.join(home, "environments", "inactive-tools", "view", "codex", "skills", "removable-package")),
      /ENOENT/,
    );

    process.env.WOMA_ENV = "active-tools";
    const active = await runCli(["--project", project, "uninstall", "removable-package"], root, home);
    assert.equal(active.code, 0, active.stderr);
    assert.match(active.stdout, /Removed removable-package from active-tools/);
    await assert.rejects(
      access(path.join(home, "environments", "active-tools", "view", "claude", "skills", "removable-package")),
      /ENOENT/,
    );

    const baseInstall = await runCli(["--project", project, "install", "--name", "base", removable], root, home);
    assert.equal(baseInstall.code, 0, baseInstall.stderr);
    const base = await runCli(["--project", project, "uninstall", "--name", "base", "removable-package"], root, home);
    assert.equal(base.code, 0, base.stderr);
    assert.match(base.stdout, /Removed removable-package from base/);
    const baseLock = JSON.parse(await readFile(path.join(home, "environments", "base", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(baseLock.packages), []);
  } finally {
    if (previousEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});
