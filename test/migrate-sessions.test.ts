import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEnvironment, ensureBaseEnvironment } from "../src/environment.js";
import { migrateExistingSessions } from "../src/migrate-sessions.js";
import { environmentAgentHomePath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("session migration is explicit and creates Environment-owned ordinary files", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-migrate-sessions-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "home");
  const codex = path.join(root, "user", ".codex");
  const claude = path.join(root, "user", ".claude");
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = claude;
  try {
    await write(path.join(codex, "sessions", "2026", "old.jsonl"), "codex old\n");
    await write(path.join(codex, "history.jsonl"), "codex history\n");
    await write(path.join(codex, "auth.json"), "secret\n");
    await write(path.join(claude, "projects", "repo", "old.jsonl"), "claude old\n");
    await write(path.join(claude, "todos", "old.json"), "{}\n");
    await write(path.join(claude, "settings.json"), "{}\n");

    await ensureBaseEnvironment(root);
    const codexHome = environmentAgentHomePath("base", "codex");
    const claudeHome = environmentAgentHomePath("base", "claude");
    await assert.rejects(readFile(path.join(codexHome, "sessions", "2026", "old.jsonl")), /ENOENT/);
    await assert.rejects(readFile(path.join(claudeHome, "projects", "repo", "old.jsonl")), /ENOENT/);
    await write(path.join(codexHome, "sessions", "2026", "new.jsonl"), "codex new\n");

    const planned = await migrateExistingSessions({ projectRoot: root, environment: "base", from: "both", dryRun: true });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.unchanged, false);
    await assert.rejects(readFile(path.join(codexHome, "sessions", "2026", "old.jsonl")), /ENOENT/);

    const migrated = await migrateExistingSessions({ projectRoot: root, environment: "base", from: "both" });
    assert.equal(migrated.unchanged, false);
    assert.equal(await readFile(path.join(codexHome, "sessions", "2026", "old.jsonl"), "utf8"), "codex old\n");
    assert.equal(await readFile(path.join(codexHome, "sessions", "2026", "new.jsonl"), "utf8"), "codex new\n");
    assert.equal(await readFile(path.join(claudeHome, "projects", "repo", "old.jsonl"), "utf8"), "claude old\n");
    assert.equal(await readFile(path.join(claudeHome, "todos", "old.json"), "utf8"), "{}\n");
    assert.equal((await lstat(path.join(codexHome, "sessions", "2026", "old.jsonl"))).isFile(), true);
    assert.equal((await lstat(path.join(codexHome, "sessions"))).isSymbolicLink(), false);
    await writeFile(path.join(codexHome, "sessions", "2026", "old.jsonl"), "environment copy\n", "utf8");
    assert.equal(await readFile(path.join(codex, "sessions", "2026", "old.jsonl"), "utf8"), "codex old\n");
    assert.equal(await readFile(path.join(codex, "auth.json"), "utf8"), "secret\n");

    await writeFile(path.join(codexHome, "sessions", "2026", "old.jsonl"), "codex old\n", "utf8");
    const repeated = await migrateExistingSessions({ projectRoot: root, environment: "base", from: "both" });
    assert.equal(repeated.unchanged, true);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("session migration rejects links, conflicts, and unsupported targets before writing", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-migrate-session-conflicts-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const codex = path.join(root, "codex");
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "claude");
  try {
    await write(path.join(codex, "sessions", "old.jsonl"), "source session\n");
    await write(path.join(codex, "history.jsonl"), "source history\n");
    await createEnvironment(root, "codex-only", ["codex"]);
    const target = environmentAgentHomePath("codex-only", "codex");
    await write(path.join(target, "history.jsonl"), "target history\n");
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex" }),
      /conflicts with existing target state/,
    );
    await assert.rejects(readFile(path.join(target, "sessions", "old.jsonl")), /ENOENT/);
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "both", dryRun: true }),
      /does not support claude/,
    );

    await write(path.join(root, "outside.jsonl"), "outside\n");
    await symlink(path.join(root, "outside.jsonl"), path.join(codex, "sessions", "linked.jsonl"));
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex", dryRun: true }),
      /does not support symbolic links/,
    );
    await access(path.join(root, "outside.jsonl"));
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});
