import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMemoryBootstrapTransition, type MemoryBootstrapEnvironment } from "../src/memory-bootstrap.js";

function environment(targets: ("codex" | "claude")[], hasMemoryPackage = true): MemoryBootstrapEnvironment {
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
    assert.match(activated, /\.agents\/skills\/harness-project-memory\/SKILL\.md/);
    assert.match(activated, /Keep this content/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);

    await rollback();
    assert.equal(await readFile(agentsPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory bootstrap switches target adapters and rejects managed-block drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-switch-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  const codex = environment(["codex"]);
  const claude = environment(["claude"]);
  try {
    await (await prepareMemoryBootstrapTransition(root, undefined, codex)).apply();
    await (await prepareMemoryBootstrapTransition(root, codex, claude, { requirePrevious: true })).apply();

    await assert.rejects(readFile(agentsPath, "utf8"), /ENOENT/);
    assert.match(await readFile(claudePath, "utf8"), /\.claude\/skills\/harness-project-memory\/SKILL\.md/);

    await writeFile(claudePath, (await readFile(claudePath, "utf8")).replace("At the beginning", "Later"), "utf8");
    await assert.rejects(
      prepareMemoryBootstrapTransition(root, claude, undefined, { requirePrevious: true }),
      /discovery block was modified/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});
