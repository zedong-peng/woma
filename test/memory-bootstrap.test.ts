import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareMemoryBootstrapCleanup } from "../src/memory-bootstrap.js";
import { removeTestTree } from "./helpers.js";

const legacyBlock = `<!-- >>> harness-conda:project-memory -->
## Harness Project Memory

At the beginning of the session, use the installed \`harness-project-memory\` Skill. Use that Skill before other Harness-installed Skills and whenever the user provides durable project-specific knowledge.
<!-- <<< harness-conda:project-memory -->`;

test("legacy Memory cleanup removes only the managed block and can roll back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const original = "# User instructions\n\nKeep this content.\n";
  try {
    await writeFile(agentsPath, `${original}\n${legacyBlock}\n`, "utf8");
    const prepared = await prepareMemoryBootstrapCleanup(root);
    assert.deepEqual(prepared.actions.map((action) => action.path), ["AGENTS.md"]);
    const rollback = await prepared.apply();

    assert.equal(await readFile(agentsPath, "utf8"), original);
    await rollback();
    assert.equal(await readFile(agentsPath, "utf8"), `${original}\n${legacyBlock}\n`);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup removes instruction files created only for discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-only-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), `${legacyBlock}\n`, "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), `${legacyBlock}\n`, "utf8");
    const prepared = await prepareMemoryBootstrapCleanup(root);
    assert.deepEqual(prepared.actions.map((action) => action.path).sort(), ["AGENTS.md", "CLAUDE.md"]);
    await prepared.apply();
    await assert.rejects(readFile(path.join(root, "AGENTS.md"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup is a no-op without managed discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-none-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# User instructions\n", "utf8");
    const prepared = await prepareMemoryBootstrapCleanup(root);
    assert.deepEqual(prepared.actions, []);
    await prepared.apply();
    assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), "# User instructions\n");
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup refuses a modified managed block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-drift-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), `${legacyBlock.replace("At the beginning", "Later")}\n`, "utf8");
    await assert.rejects(prepareMemoryBootstrapCleanup(root), /discovery block was modified/);
  } finally {
    await removeTestTree(root);
  }
});

test("legacy Memory cleanup preserves instruction symlinks and target modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-memory-bootstrap-symlink-"));
  const target = path.join(root, "shared-instructions.md");
  const agentsPath = path.join(root, "AGENTS.md");
  const original = "# Shared instructions\n";
  try {
    await writeFile(target, `${original}\n${legacyBlock}\n`, { encoding: "utf8", mode: 0o640 });
    await symlink(target, agentsPath);

    await (await prepareMemoryBootstrapCleanup(root)).apply();

    assert.equal((await lstat(agentsPath)).isSymbolicLink(), true);
    assert.equal(await readlink(agentsPath), target);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await stat(target)).mode & 0o777, 0o640);
  } finally {
    await removeTestTree(root);
  }
});
