import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function isolatedProcessPath(root: string): Promise<string> {
  const executable = path.join(root, "test-bin", "ps");
  await write(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`;
}

test("CLI explicitly migrates existing Skills into the active Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-migrate-skills-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const codex = path.join(root, "codex");
  try {
    await write(
      path.join(codex, "skills", "legacy-review", "SKILL.md"),
      "---\nname: legacy-review\ndescription: Legacy review Skill.\n---\nReview.\n",
    );
    await write(
      path.join(codex, "skills", "quick-notes", "SKILL.md"),
      "---\nname: quick-notes\ndescription: Quick notes Skill.\n---\nNotes.\n",
    );
    const cli = path.resolve("dist/src/cli.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: await isolatedProcessPath(root),
      HARNESS_HOME: home,
      HARNESS_ENV: "tools",
      HARNESS_ORIGINAL_CODEX_HOME: codex,
      HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    };
    delete env.NODE_TEST_CONTEXT;

    await run(process.execPath, [cli, "--project", project, "env", "create", "tools", "--target", "codex"], { cwd: root, env });

    const planned = await run(
      process.execPath,
      [cli, "--project", project, "migrate", "skills", "--from", "codex", "--dry-run"],
      { cwd: root, env },
    );
    assert.equal(planned.stderr, "");
    await assert.rejects(access(path.join(home, "migrations")), /ENOENT/);

    const migrated = await run(process.execPath, [cli, "--project", project, "migrate", "skills", "--from", "codex"], {
      cwd: root,
      env,
    });
    assert.equal(migrated.stderr, "");
    const lock = JSON.parse(await readFile(path.join(home, "environments", "tools", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(lock.packages), [
      "harness-project-memory",
      "harness-package-builder",
      "legacy-review",
      "quick-notes",
    ]);
    assert.match(
      await readFile(path.join(home, "environments", "tools", "view", "codex", "skills", "legacy-review", "SKILL.md"), "utf8"),
      /Legacy review Skill/,
    );
    assert.match(
      await readFile(path.join(home, "environments", "tools", "view", "codex", "skills", "quick-notes", "SKILL.md"), "utf8"),
      /Quick notes Skill/,
    );
    const repeated = await run(process.execPath, [cli, "--project", project, "migrate", "skills", "--from", "codex"], {
      cwd: root,
      env,
    });
    assert.equal(repeated.stderr, "");
  } finally {
    await removeTestTree(root);
  }
});

test("CLI explicitly migrates existing sessions into the active Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-migrate-sessions-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const codex = path.join(root, "codex");
  try {
    await write(path.join(codex, "sessions", "old.jsonl"), "old session\n");
    const cli = path.resolve("dist/src/cli.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: await isolatedProcessPath(root),
      HARNESS_HOME: home,
      HARNESS_ENV: "tools",
      HARNESS_ORIGINAL_CODEX_HOME: codex,
      HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    };
    delete env.NODE_TEST_CONTEXT;

    await run(process.execPath, [cli, "--project", project, "env", "create", "tools", "--target", "codex"], { cwd: root, env });
    const planned = await run(
      process.execPath,
      [cli, "--project", project, "migrate", "sessions", "--from", "codex", "--dry-run"],
      { cwd: root, env },
    );
    assert.equal(planned.stderr, "");
    await assert.rejects(readFile(path.join(home, "environments", "tools", "home", "codex", "sessions", "old.jsonl")), /ENOENT/);

    const migrated = await run(process.execPath, [cli, "--project", project, "migrate", "sessions", "--from", "codex"], {
      cwd: root,
      env,
    });
    assert.equal(migrated.stderr, "");
    assert.equal(
      await readFile(path.join(home, "environments", "tools", "home", "codex", "sessions", "old.jsonl"), "utf8"),
      "old session\n",
    );
  } finally {
    await removeTestTree(root);
  }
});

test("CLI sync adopts ordinary Skills installed by Codex into the selected Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cli-sync-runtime-skill-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    const cli = path.resolve("dist/src/cli.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: await isolatedProcessPath(root),
      HARNESS_HOME: home,
      HARNESS_ENV: "tools",
      HARNESS_ORIGINAL_CODEX_HOME: path.join(root, "codex"),
      HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    };
    delete env.NODE_TEST_CONTEXT;

    await run(process.execPath, [cli, "--project", project, "env", "create", "tools", "--target", "codex"], { cwd: root, env });
    const skills = path.join(home, "environments", "tools", "home", "codex", "skills");
    await write(
      path.join(skills, "installed-in-window", "SKILL.md"),
      "---\nname: installed-in-window\ndescription: Installed from a Codex window.\n---\nWindow Skill.\n",
    );
    await write(path.join(skills, ".system", ".codex-system-skills.marker"), "runtime\n");

    const synchronized = await run(process.execPath, [cli, "--project", project, "sync", "--name", "tools"], {
      cwd: root,
      env,
    });
    assert.match(synchronized.stdout, /Adopting 1 Codex runtime Skill into tools/);
    assert.match(synchronized.stdout, /installed-in-window@0\.0\.0-migrate\./);
    assert.match(synchronized.stdout, /Synced tools: 3 packages/);

    const lock = JSON.parse(await readFile(path.join(home, "environments", "tools", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(lock.packages), [
      "harness-project-memory",
      "harness-package-builder",
      "installed-in-window",
    ]);
    assert.equal((await lstat(path.join(skills, "installed-in-window"))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(skills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime\n");

    const listed = await run(process.execPath, [cli, "--project", project, "list", "--name", "tools"], { cwd: root, env });
    assert.match(listed.stdout, /installed-in-window\s+installed-in-window@0\.0\.0-migrate\.[a-f0-9]+\s+codex/);
  } finally {
    await removeTestTree(root);
  }
});
