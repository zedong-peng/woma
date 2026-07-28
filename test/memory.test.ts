import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localMemoryPath,
  packageMemoryPath,
  packageMemoryRoot,
  projectMemoryPath,
} from "../src/memory.js";
import { removeTestTree } from "./helpers.js";

test("Project Memory paths do not initialize project files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-memory-"));
  try {
    assert.equal(projectMemoryPath(root), path.join(root, ".harness", "memory", "project.md"));
    assert.equal(packageMemoryRoot(root), path.join(root, ".harness", "memory", "packages"));
    await assert.rejects(access(path.join(root, ".harness")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("Project Memory scopes explicitly authored package and machine-local context to validated paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-project-memory-paths-"));
  try {
    const packagePath = packageMemoryPath(root, "performance-engineering");
    assert.equal(packagePath, path.join(root, ".harness", "memory", "packages", "performance-engineering.md"));
    assert.equal(localMemoryPath(root), path.join(root, ".harness", "local", "memory.md"));
    assert.notEqual(path.dirname(packagePath), path.dirname(localMemoryPath(root)));
    assert.throws(() => packageMemoryPath(root, "../../outside"), /must use lowercase letters/);

    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, "# Performance adaptation\n", "utf8");
    assert.equal(await readFile(packagePath, "utf8"), "# Performance adaptation\n");
  } finally {
    await removeTestTree(root);
  }
});
