import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPackageSource, loadCachedPackage } from "../src/package.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function packageFixture(root: string): Promise<string> {
  const packageRoot = path.join(root, "package");
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: integrity-test
  version: 1.0.0
  description: Integrity fixture.
spec:
  platforms: [codex]
  skills:
    - name: integrity-skill
      path: ./skills/integrity-skill
`,
  );
  await write(path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"), "---\ndescription: Test.\n---\nTest.\n");
  return packageRoot;
}

test("cache integrity detects package mutation", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    await writeFile(path.join(pkg.root, "skills", "integrity-skill", "SKILL.md"), "changed", "utf8");
    await assert.rejects(loadCachedPackage(pkg.lock), /Integrity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packages reject skill symlinks", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    await write(path.join(root, "outside.txt"), "outside");
    await symlink(path.join(root, "outside.txt"), path.join(packageRoot, "skills", "integrity-skill", "outside.txt"));
    await assert.rejects(installPackageSource(packageRoot), /unsupported symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packages reject a symlink used as the skill root", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const skillRoot = path.join(packageRoot, "skills", "integrity-skill");
    const outside = path.join(root, "outside-skill");
    await mkdir(outside, { recursive: true });
    await write(path.join(outside, "SKILL.md"), "---\ndescription: Outside.\n---\nOutside.\n");
    await rm(skillRoot, { recursive: true });
    await symlink(outside, skillRoot);

    await assert.rejects(installPackageSource(packageRoot), /skill root.*symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses to reuse a modified cache entry", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    await writeFile(path.join(pkg.root, "skills", "integrity-skill", "SKILL.md"), "tampered", "utf8");

    await assert.rejects(installPackageSource(packageRoot), /integrity mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
