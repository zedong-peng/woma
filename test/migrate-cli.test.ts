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
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-migrate-skills-"));
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
      WOMA_HOME: home,
      WOMA_ENV: "tools",
      WOMA_ORIGINAL_CODEX_HOME: codex,
      WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
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
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-migrate-sessions-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const codex = path.join(root, "codex");
  try {
    await write(path.join(codex, "sessions", "old.jsonl"), "old session\n");
    const cli = path.resolve("dist/src/cli.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: await isolatedProcessPath(root),
      WOMA_HOME: home,
      WOMA_ENV: "tools",
      WOMA_ORIGINAL_CODEX_HOME: codex,
      WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
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

test("CLI immediately lists a Claude-installed Skill shared with Codex in the Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-environment-skill-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    const cli = path.resolve("dist/src/cli.js");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: await isolatedProcessPath(root),
      WOMA_HOME: home,
      WOMA_ENV: "tools",
      WOMA_ORIGINAL_CODEX_HOME: path.join(root, "codex"),
      WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    };
    delete env.NODE_TEST_CONTEXT;

    await run(process.execPath, [cli, "--project", project, "env", "create", "tools", "--target", "both"], { cwd: root, env });
    const skills = path.join(home, "environments", "tools", "home", "claude", "skills");
    await write(
      path.join(skills, "installed-in-window", "SKILL.md"),
      "---\nname: installed-in-window\ndescription: Installed from a Claude Code window.\n---\nWindow Skill.\n",
    );
    await write(path.join(skills, ".system", ".codex-system-skills.marker"), "runtime\n");
    assert.match(
      await readFile(path.join(home, "environments", "tools", "home", "codex", "skills", "installed-in-window", "SKILL.md"), "utf8"),
      /Claude Code window/,
    );

    const listed = await run(process.execPath, [cli, "--project", project, "list", "--name", "tools"], { cwd: root, env });
    assert.match(listed.stdout, /installed-in-window\s+external\s+codex, claude/);
    assert.doesNotMatch(listed.stdout, /\.system/);

    const info = await run(process.execPath, [cli, "--project", project, "info", "--json"], { cwd: root, env });
    const context = JSON.parse(info.stdout) as {
      packages: { name: string }[];
      environmentSkills: { name: string; origin: string; platform: string; platforms: string[] }[];
    };
    assert.deepEqual(context.environmentSkills, [
      {
        name: "installed-in-window",
        description: "Installed from a Claude Code window.",
        entry: "installed-in-window",
        path: path.join(home, "environments", "tools", "home", "skills", "installed-in-window"),
        origin: "external",
        platform: "environment",
        platforms: ["codex", "claude"],
      },
    ]);

    const doctor = await run(process.execPath, [cli, "--project", project, "doctor", "--name", "tools"], {
      cwd: root,
      env: { ...env, WOMA_ENV: "base" },
    });
    assert.match(doctor.stdout, /\[ok\] environment-skill:installed-in-window: external at/);

    const lock = JSON.parse(await readFile(path.join(home, "environments", "tools", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(lock.packages), []);
    assert.equal((await lstat(path.join(skills, "installed-in-window"))).isDirectory(), true);
    assert.equal(await readFile(path.join(skills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime\n");
  } finally {
    await removeTestTree(root);
  }
});
