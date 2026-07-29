import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareLegacyMemoryCleanup } from "../src/legacy-memory-cleanup.js";
import { removeTestTree } from "./helpers.js";

const womaBlock = `<!-- >>> woma:project-memory -->
## Woma Project Memory

At the beginning of the session, use the installed \`woma-project-memory\` Skill. Use that Skill before other Woma-installed Skills and whenever the user provides durable project-specific knowledge.
<!-- <<< woma:project-memory -->`;

test("legacy Memory cleanup has a zero-write fast path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-memory-cleanup-empty-"));
  try {
    const prepared = await prepareLegacyMemoryCleanup(root);
    assert.deepEqual(prepared.actions, []);
    await prepared.apply();
    await assert.rejects(access(path.join(root, "AGENTS.md")), /ENOENT/);
    await assert.rejects(access(path.join(root, "CLAUDE.md")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup removes exact Woma blocks and rolls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-memory-cleanup-blocks-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  const instructions = "# User instructions\n\nKeep this content.\n";
  try {
    await writeFile(agentsPath, `${instructions}\n${womaBlock}\n`, "utf8");
    await writeFile(claudePath, `${womaBlock}\n`, { encoding: "utf8", mode: 0o600 });
    const prepared = await prepareLegacyMemoryCleanup(root);
    assert.deepEqual(prepared.actions.map((action) => action.path), ["AGENTS.md", "CLAUDE.md"]);
    const rollback = await prepared.apply();

    assert.equal(await readFile(agentsPath, "utf8"), instructions);
    await assert.rejects(access(claudePath), /ENOENT/);

    await rollback();
    assert.equal(await readFile(agentsPath, "utf8"), `${instructions}\n${womaBlock}\n`);
    assert.equal(await readFile(claudePath, "utf8"), `${womaBlock}\n`);
    assert.equal((await stat(claudePath)).mode & 0o777, 0o600);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup rejects modified managed blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-memory-cleanup-drift-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), `${womaBlock.replace("At the beginning", "Later")}\n`, "utf8");
    await assert.rejects(prepareLegacyMemoryCleanup(root), /discovery block was modified/);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup preserves instruction symlinks and target modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-memory-cleanup-symlink-"));
  const target = path.join(root, "shared-instructions.md");
  const claudeTarget = path.join(root, "shared-claude.md");
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  const instructions = "# Shared instructions\n";
  try {
    await writeFile(target, `${instructions}\n${womaBlock}\n`, { encoding: "utf8", mode: 0o640 });
    await writeFile(claudeTarget, `${womaBlock}\n`, { encoding: "utf8", mode: 0o600 });
    await symlink(target, agentsPath);
    await symlink(claudeTarget, claudePath);

    await (await prepareLegacyMemoryCleanup(root)).apply();

    assert.equal((await lstat(agentsPath)).isSymbolicLink(), true);
    assert.equal(await readlink(agentsPath), target);
    assert.equal(await readFile(target, "utf8"), instructions);
    assert.equal((await stat(target)).mode & 0o777, 0o640);
    assert.equal((await lstat(claudePath)).isSymbolicLink(), true);
    assert.equal(await readlink(claudePath), claudeTarget);
    assert.equal(await readFile(claudeTarget, "utf8"), "");
    assert.equal((await stat(claudeTarget)).mode & 0o777, 0o600);
  } finally {
    await removeTestTree(root);
  }
});
