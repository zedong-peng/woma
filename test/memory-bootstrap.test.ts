import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMemoryBootstrapTransition, type MemoryBootstrapEnvironment } from "../src/memory-bootstrap.js";
import type { Platform } from "../src/types.js";
import { removeTestTree } from "./helpers.js";

function environment(targets: Platform[], hasMemoryPackage = true): MemoryBootstrapEnvironment {
  return { targets, hasMemoryPackage };
}

test("Memory bootstrap points to the normally activated Skill and preserves user instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const original = "# User instructions\n\nKeep this content.\n";
  try {
    await writeFile(agentsPath, original, "utf8");
    const prepared = await prepareMemoryBootstrapTransition(root, undefined, environment(["codex"]));
    const rollback = await prepared.apply();

    const activated = await readFile(agentsPath, "utf8");
    assert.match(activated, /installed `harness-project-memory` Skill/);
    assert.match(activated, /Keep this content/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);

    await rollback();
    assert.equal(await readFile(agentsPath, "utf8"), original);
  } finally {
    await removeTestTree(root);
  }
});

test("Pi discovers Project Memory through AGENTS.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-pi-"));
  try {
    await (await prepareMemoryBootstrapTransition(root, undefined, environment(["pi"]))).apply();
    assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("Memory bootstrap never removes another target's stable discovery pointer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-switch-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  const codex = environment(["codex"]);
  const claude = environment(["claude"]);
  try {
    await (await prepareMemoryBootstrapTransition(root, undefined, codex)).apply();
    await (await prepareMemoryBootstrapTransition(root, codex, claude, { requirePrevious: true })).apply();

    assert.match(await readFile(agentsPath, "utf8"), /Harness Project Memory/);
    assert.match(await readFile(claudePath, "utf8"), /installed `harness-project-memory` Skill/);

    await writeFile(claudePath, (await readFile(claudePath, "utf8")).replace("At the beginning", "Later"), "utf8");
    await assert.rejects(
      prepareMemoryBootstrapTransition(root, claude, undefined, { requirePrevious: true }),
      /discovery block was modified/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("Memory bootstrap preserves instruction symlinks and their targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-symlink-"));
  const target = path.join(root, "shared-instructions.md");
  const claudePath = path.join(root, "CLAUDE.md");
  try {
    await writeFile(target, "# Shared instructions\n", { encoding: "utf8", mode: 0o640 });
    await symlink(target, claudePath);

    await (await prepareMemoryBootstrapTransition(root, undefined, environment(["claude"]))).apply();

    assert.equal((await lstat(claudePath)).isSymbolicLink(), true);
    assert.equal(await readlink(claudePath), target);
    assert.match(await readFile(target, "utf8"), /Shared instructions[\s\S]*Harness Project Memory/);
    assert.equal((await stat(target)).mode & 0o777, 0o640);
  } finally {
    await removeTestTree(root);
  }
});

test("Memory bootstrap is absent when the ordinary Memory package is not active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-opt-out-"));
  try {
    const prepared = await prepareMemoryBootstrapTransition(root, undefined, environment(["codex", "claude"], false));
    assert.deepEqual(prepared.actions, []);
    await prepared.apply();
    await assert.rejects(readFile(path.join(root, "AGENTS.md"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});
