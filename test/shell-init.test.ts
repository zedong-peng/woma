import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initializeShell, shellProfilePath } from "../src/shell-init.js";
import { renderShellHook } from "../src/shell.js";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);

test("shell profile paths follow Conda conventions", () => {
  assert.equal(
    shellProfilePath("zsh", { environment: { ZDOTDIR: "/tmp/zsh" }, userHome: "/tmp/home" }),
    path.resolve("/tmp/zsh/.zshrc"),
  );
  assert.equal(shellProfilePath("bash", { platform: "darwin", userHome: "/tmp/home" }), path.resolve("/tmp/home/.bash_profile"));
  assert.equal(shellProfilePath("bash", { platform: "linux", userHome: "/tmp/home" }), path.resolve("/tmp/home/.bashrc"));
});

test("shell initialization installs a static hook without replacing user profile content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-init-"));
  const profileTarget = path.join(root, "shared-profile");
  const profilePath = path.join(root, ".bashrc");
  const stateHome = path.join(root, "state");
  try {
    await writeFile(profileTarget, "# user shell settings\n", { encoding: "utf8", mode: 0o640 });
    await symlink(profileTarget, profilePath);

    const initialized = await initializeShell("bash", { profilePath, harnessHome: stateHome });
    assert.deepEqual(initialized.actions.map((entry) => entry.verb), ["create", "merge"]);
    assert.equal(await readFile(initialized.hookPath, "utf8"), renderShellHook("bash"));
    const profile = await readFile(profilePath, "utf8");
    assert.match(profile, /^# user shell settings/);
    assert.match(profile, /# >>> harness initialize >>>/);
    assert.match(profile, /managed by 'harness init'/);
    assert.ok(profile.includes(`. '${initialized.hookPath}'`));
    assert.doesNotMatch(profile, /eval .*harness|node .*harness/);
    assert.equal((await lstat(profilePath)).isSymbolicLink(), true);
    assert.equal(await readlink(profilePath), profileTarget);
    assert.equal((await stat(profileTarget)).mode & 0o777, 0o640);
    await run("bash", ["-n", initialized.hookPath]);
    await run("bash", ["-n", profilePath]);

    const repeated = await initializeShell("bash", { profilePath, harnessHome: stateHome });
    assert.deepEqual(repeated.actions, []);
    assert.equal(await readFile(profilePath, "utf8"), profile);

    const reversed = await initializeShell("bash", { profilePath, harnessHome: stateHome, reverse: true });
    assert.deepEqual(reversed.actions.map((entry) => entry.verb), ["remove", "merge"]);
    assert.equal(await readFile(profilePath, "utf8"), "# user shell settings\n");
    await assert.rejects(access(initialized.hookPath), { code: "ENOENT" });
    assert.equal((await lstat(profilePath)).isSymbolicLink(), true);
  } finally {
    await removeTestTree(root);
  }
});

test("shell initialization dry-run reports changes without writing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-init-dry-run-"));
  const profilePath = path.join(root, ".zshrc");
  const stateHome = path.join(root, "state");
  try {
    const result = await initializeShell("zsh", { profilePath, harnessHome: stateHome, dryRun: true });
    assert.deepEqual(result.actions.map((entry) => entry.verb), ["create", "create"]);
    await assert.rejects(access(profilePath), { code: "ENOENT" });
    await assert.rejects(access(result.hookPath), { code: "ENOENT" });
  } finally {
    await removeTestTree(root);
  }
});

test("shell initialization rejects malformed managed blocks without changing them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-init-markers-"));
  const profilePath = path.join(root, ".bashrc");
  const original = "# >>> harness initialize >>>\nmodified\n";
  try {
    await writeFile(profilePath, original, "utf8");
    await assert.rejects(
      initializeShell("bash", { profilePath, harnessHome: path.join(root, "state") }),
      /invalid Harness initialization block/,
    );
    assert.equal(await readFile(profilePath, "utf8"), original);
    await assert.rejects(access(path.join(root, "state")), { code: "ENOENT" });
  } finally {
    await removeTestTree(root);
  }
});

test("CLI init installs shell integration and supports reverse", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-init-"));
  const stateHome = path.join(root, "state");
  const profilePath = path.join(root, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
  const cli = path.resolve("dist/src/cli.js");
  const environment = { ...process.env, HOME: root, HARNESS_HOME: stateHome, SHELL: "/bin/bash" };
  try {
    const initialized = await run(process.execPath, [cli, "init", "bash"], { cwd: root, env: environment });
    assert.match(initialized.stdout, /Initialized bash shell integration/);
    assert.match(await readFile(profilePath, "utf8"), /# >>> harness initialize >>>/);
    await access(path.join(stateHome, "shell", "harness.bash"));

    const reversed = await run(process.execPath, [cli, "init", "bash", "--reverse"], { cwd: root, env: environment });
    assert.match(reversed.stdout, /Reversed bash shell initialization/);
    assert.equal(await readFile(profilePath, "utf8"), "");
    await assert.rejects(access(path.join(stateHome, "shell", "harness.bash")), { code: "ENOENT" });
  } finally {
    await removeTestTree(root);
  }
});

test("installation guidance directs users to harness init", async () => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.CI;
  const result = await run(process.execPath, [path.resolve("scripts/postinstall.mjs")], { env: environment });
  assert.match(result.stdout, /Harness Conda installed/);
  assert.match(result.stdout, /harness init/);
});
