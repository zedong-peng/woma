import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scaffoldHarness } from "../src/scaffold.js";
import { removeTestTree } from "./helpers.js";

test("init publishes a complete scaffold into an existing empty directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-scaffold-empty-"));
  try {
    await scaffoldHarness(root, "demo");
    assert.match(await readFile(path.join(root, "harness.yaml"), "utf8"), /name: demo/);
    assert.match(await readFile(path.join(root, "skills", "demo-workflow", "SKILL.md"), "utf8"), /name: demo-workflow/);
  } finally {
    await removeTestTree(root);
  }
});

test("init refuses to overwrite an existing workflow Skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-scaffold-"));
  try {
    const skill = path.join(root, "skills", "demo-workflow", "SKILL.md");
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, "user content\n", "utf8");
    await assert.rejects(scaffoldHarness(root, "demo"), /Refusing to overwrite/);
    assert.equal(await readFile(skill, "utf8"), "user content\n");
    await assert.rejects(readFile(path.join(root, "harness.yaml")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("init refuses to overwrite an existing manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-scaffold-"));
  try {
    const manifest = path.join(root, "harness.yaml");
    await writeFile(manifest, "user manifest\n", "utf8");
    await assert.rejects(scaffoldHarness(root, "demo"), /Refusing to overwrite/);
    assert.equal(await readFile(manifest, "utf8"), "user manifest\n");
  } finally {
    await removeTestTree(root);
  }
});
