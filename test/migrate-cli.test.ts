import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
