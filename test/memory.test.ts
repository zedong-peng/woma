import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeProjectMemory,
  localMemoryPath,
  packageMemoryPath,
  packageMemoryRoot,
  projectMemoryPath,
  readPackageMemory,
  readProjectMemory,
} from "../src/memory.js";
import { removeTestTree } from "./helpers.js";

test("Project Memory initializes shared and isolated package storage without overwriting content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-project-memory-"));
  try {
    await initializeProjectMemory(root);
    assert.match(await readProjectMemory(root), /stable, project-wide knowledge/);
    await access(packageMemoryRoot(root));

    await writeFile(projectMemoryPath(root), "# Confirmed project knowledge\n", "utf8");
    await initializeProjectMemory(root);
    assert.equal(await readProjectMemory(root), "# Confirmed project knowledge\n");
  } finally {
    await removeTestTree(root);
  }
});

test("Project Memory scopes package and machine-local context to validated paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-project-memory-paths-"));
  try {
    await initializeProjectMemory(root);
    const packagePath = packageMemoryPath(root, "performance-engineering");
    assert.equal(packagePath, path.join(root, ".woma", "memory", "packages", "performance-engineering.md"));
    assert.equal(localMemoryPath(root), path.join(root, ".woma", "local", "memory.md"));
    assert.notEqual(path.dirname(packagePath), path.dirname(localMemoryPath(root)));
    assert.throws(() => packageMemoryPath(root, "../../outside"), /must use lowercase letters/);
    assert.equal(await readPackageMemory(root, "performance-engineering"), "");
  } finally {
    await removeTestTree(root);
  }
});
