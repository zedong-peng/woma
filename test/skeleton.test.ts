import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkflowSkeleton } from "../src/skeleton.js";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);

test("workflow skeleton creates an editable Package recipe under the output directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-skeleton-workflow-"));
  try {
    const result = await createWorkflowSkeleton("Research Review", { outputDirectory: root, version: "1.2.3" });
    assert.equal(result.name, "research-review");
    assert.equal(result.root, path.join(root, "research-review"));
    const manifest = await readFile(path.join(result.root, "woma.yaml"), "utf8");
    assert.match(manifest, /name: research-review/);
    assert.match(manifest, /version: 1\.2\.3/);
    assert.match(manifest, /platforms: \[codex, claude, pi, qoder, opencode\]/);
    assert.match(
      await readFile(path.join(result.root, "skills", "research-review-workflow", "SKILL.md"), "utf8"),
      /name: research-review-workflow/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("workflow skeleton publishes into an existing empty destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-skeleton-empty-"));
  try {
    await mkdir(path.join(root, "demo"));
    await createWorkflowSkeleton("demo", { outputDirectory: root });
    assert.match(await readFile(path.join(root, "demo", "woma.yaml"), "utf8"), /name: demo/);
  } finally {
    await removeTestTree(root);
  }
});

test("workflow skeleton refuses non-empty destinations and invalid versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-skeleton-refuse-"));
  try {
    const existing = path.join(root, "demo", "keep.txt");
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, "user content\n", "utf8");
    await assert.rejects(createWorkflowSkeleton("demo", { outputDirectory: root }), /Refusing to overwrite/);
    assert.equal(await readFile(existing, "utf8"), "user content\n");
    await assert.rejects(
      createWorkflowSkeleton("invalid-version", { outputDirectory: root, version: "latest" }),
      /Invalid Package version/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("CLI skeleton follows the provider and output-directory interface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-cli-skeleton-"));
  const cli = path.resolve("dist/src/cli.js");
  try {
    const result = await run(
      process.execPath,
      [cli, "skeleton", "workflow", "demo", "--output-dir", root, "--version", "2.0.0"],
    );
    assert.match(result.stdout, /Created workflow skeleton demo@2\.0\.0/);
    assert.match(await readFile(path.join(root, "demo", "woma.yaml"), "utf8"), /version: 2\.0\.0/);

    const inspected = await run(process.execPath, [cli, "inspect", path.join(root, "demo")]);
    assert.match(inspected.stdout, /^demo@2\.0\.0/);

    const help = await run(process.execPath, [cli, "skeleton", "--help"]);
    assert.match(help.stdout, /workflow\s+generate a Package with a coordinating workflow Skill/);
  } finally {
    await removeTestTree(root);
  }
});
