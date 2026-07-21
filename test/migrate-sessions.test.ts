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
    const sourceHistory = [
      '{"session_id":"source","text":"source later","ts":30}',
      '{"session_id":"shared","text":"same","ts":10}',
    ].join("\n") + "\n";
    const targetHistory = [
      '{"text":"target middle","ts":20,"session_id":"target"}',
      '{"text":"same","session_id":"shared","ts":10}',
    ].join("\n") + "\n";
    const sourceClaudeHistory = '{"display":"source","timestamp":30,"sessionId":"source"}\n';
    const targetClaudeHistory = '{"sessionId":"target","timestamp":20,"display":"target"}\n';
    await write(path.join(codex, "sessions", "2026", "old.jsonl"), "codex old\n");
    await write(path.join(codex, "history.jsonl"), sourceHistory);
    await write(path.join(codex, "auth.json"), "secret\n");
    await write(path.join(claude, "projects", "repo", "old.jsonl"), "claude old\n");
    await write(path.join(claude, "history.jsonl"), sourceClaudeHistory);
    await write(path.join(claude, "todos", "old.json"), "{}\n");
    await write(path.join(claude, "settings.json"), "{}\n");

    await ensureBaseEnvironment(root);
    const codexHome = environmentAgentHomePath("base", "codex");
    const claudeHome = environmentAgentHomePath("base", "claude");
    await assert.rejects(readFile(path.join(codexHome, "sessions", "2026", "old.jsonl")), /ENOENT/);
    await assert.rejects(readFile(path.join(claudeHome, "projects", "repo", "old.jsonl")), /ENOENT/);
    await write(path.join(codexHome, "sessions", "2026", "new.jsonl"), "codex new\n");
    await write(path.join(codexHome, "history.jsonl"), targetHistory);
    await write(path.join(claudeHome, "history.jsonl"), targetClaudeHistory);

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
    const mergedClaudeHistory = (await readFile(path.join(claudeHome, "history.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sessionId: string; timestamp: number });
    assert.deepEqual(mergedClaudeHistory.map((record) => record.sessionId), ["target", "source"]);
    assert.deepEqual(mergedClaudeHistory.map((record) => record.timestamp), [20, 30]);
    const mergedHistory = (await readFile(path.join(codexHome, "history.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { session_id: string; ts: number });
    assert.deepEqual(mergedHistory.map((record) => record.session_id), ["shared", "target", "source"]);
    assert.deepEqual(mergedHistory.map((record) => record.ts), [10, 20, 30]);
    const historyResult = migrated.entries.find((entry) => entry.platform === "codex" && entry.name === "history.jsonl");
    assert.equal(historyResult?.recordsAdded, 1);
    assert.equal(historyResult?.recordsDeduplicated, 1);
    assert.equal((await lstat(path.join(codexHome, "sessions", "2026", "old.jsonl"))).isFile(), true);
    assert.equal((await lstat(path.join(codexHome, "sessions"))).isSymbolicLink(), false);
    await writeFile(path.join(codexHome, "sessions", "2026", "old.jsonl"), "environment copy\n", "utf8");
    assert.equal(await readFile(path.join(codex, "sessions", "2026", "old.jsonl"), "utf8"), "codex old\n");
    assert.equal(await readFile(path.join(codex, "history.jsonl"), "utf8"), sourceHistory);
    assert.equal(await readFile(path.join(claude, "history.jsonl"), "utf8"), sourceClaudeHistory);
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

test("session migration materializes legacy links to the selected source", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-migrate-session-links-"));
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
    const sourceHistory = '{"session_id":"source","text":"source","ts":10}\n';
    await write(path.join(codex, "history.jsonl"), sourceHistory);
    await write(path.join(codex, "sessions", "2026", "03", "old.jsonl"), "source session\n");
    await createEnvironment(root, "codex-only", ["codex"]);
    const target = environmentAgentHomePath("codex-only", "codex");
    await symlink(path.join(codex, "history.jsonl"), path.join(target, "history.jsonl"));
    await mkdir(path.join(target, "sessions", "2026"), { recursive: true });
    await symlink(path.join(codex, "sessions", "2026", "03"), path.join(target, "sessions", "2026", "03"));

    const planned = await migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex", dryRun: true });
    assert.equal(planned.unchanged, false);
    assert.equal((await lstat(path.join(target, "history.jsonl"))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(target, "sessions", "2026", "03"))).isSymbolicLink(), true);

    await migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex" });
    assert.equal((await lstat(path.join(target, "history.jsonl"))).isFile(), true);
    assert.equal((await lstat(path.join(target, "history.jsonl"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(target, "sessions", "2026", "03"))).isDirectory(), true);
    assert.equal((await lstat(path.join(target, "sessions", "2026", "03"))).isSymbolicLink(), false);
    await writeFile(path.join(target, "history.jsonl"), '{"session_id":"target","text":"target","ts":20}\n', "utf8");
    await writeFile(path.join(target, "sessions", "2026", "03", "old.jsonl"), "target session\n", "utf8");
    assert.equal(await readFile(path.join(codex, "history.jsonl"), "utf8"), sourceHistory);
    assert.equal(await readFile(path.join(codex, "sessions", "2026", "03", "old.jsonl"), "utf8"), "source session\n");
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
    await write(path.join(codex, "sessions", "new.jsonl"), "new source session\n");
    const sourceHistory = '{"session_id":"source","text":"source","ts":20}\n';
    const targetHistory = '{"session_id":"target","text":"target","ts":10}\n';
    await write(path.join(codex, "history.jsonl"), sourceHistory);
    await createEnvironment(root, "codex-only", ["codex"]);
    const target = environmentAgentHomePath("codex-only", "codex");
    await write(path.join(target, "history.jsonl"), targetHistory);
    await write(path.join(target, "sessions", "old.jsonl"), "different target session\n");
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex" }),
      /conflicts with existing target state/,
    );
    await assert.rejects(readFile(path.join(target, "sessions", "new.jsonl")), /ENOENT/);
    assert.equal(await readFile(path.join(target, "history.jsonl"), "utf8"), targetHistory);
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "both", dryRun: true }),
      /does not support claude/,
    );

    await write(path.join(codex, "history.jsonl"), "not json\n");
    await assert.rejects(
      migrateExistingSessions({ projectRoot: root, environment: "codex-only", from: "codex", dryRun: true }),
      /history\.jsonl:1/,
    );
    await write(path.join(codex, "history.jsonl"), sourceHistory);

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
