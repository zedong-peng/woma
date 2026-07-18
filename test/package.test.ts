import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installPackageSource, installPackageTree, loadCachedPackage, syncLockedPackage } from "../src/package.js";
import { putLocks, readLock } from "../src/store.js";

const run = promisify(execFile);

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

async function dependencyFixture(
  root: string,
  name: string,
  version: string,
  dependencies: { name: string; version: string; source: string }[] = [],
): Promise<string> {
  const packageRoot = path.join(root, name);
  const dependencyYaml = dependencies.length === 0
    ? "  dependencies: []\n"
    : `  dependencies:\n${dependencies
        .map(
          (dependency) =>
            `    - name: ${dependency.name}\n      version: ${JSON.stringify(dependency.version)}\n      source: ${dependency.source}`,
        )
        .join("\n")}\n`;
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: ${name}
  version: ${version}
  description: ${name} fixture.
spec:
  platforms: [codex]
${dependencyYaml}  entrypoints:
    - name: ${name}
      skill: ${name}
      description: Run ${name}.
  skills:
    - name: ${name}
      path: ./skills/${name}
`,
  );
  await write(path.join(packageRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n${name}.\n`);
  return packageRoot;
}

test("the built-in auto-research meta-skill installs its documented component Skills", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-meta-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:auto-research");
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), [
      "paper-search",
      "idea-gen",
      "exp-design",
      "auto-research",
    ]);
    assert.deepEqual(installation.root.lock.dependencies, ["paper-search", "idea-gen", "exp-design"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the built-in meta-skill builder is a valid installable authoring package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-meta-builder-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:meta-skill-builder");
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["meta-skill-builder"]);
    assert.deepEqual(installation.root.lock.dependencies, []);
    assert.deepEqual(installation.root.manifest.spec.requirements.commands, []);
    assert.deepEqual(installation.root.manifest.spec.entrypoints, [
      {
        name: "create-meta-skill",
        skill: "meta-skill-builder",
        description: "Create and validate an installable meta-skill from a user's method and component Skills.",
      },
    ]);
    const instructions = await readFile(path.join(installation.root.root, "skills", "meta-skill-builder", "SKILL.md"), "utf8");
    assert.match(instructions, /harness inspect <source>/);
    assert.match(instructions, /interruption checkpoints/);
    assert.match(instructions, /Do not introduce a DAG/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the built-in performance method does not require command bindings", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-performance-memory-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:performance-engineering");
    assert.deepEqual(installation.root.manifest.spec.requirements, { env: [], commands: ["git", "node"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installing a meta-skill resolves transitive dependencies in dependency-first order", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await dependencyFixture(root, "paper-search", "1.2.0");
    await dependencyFixture(root, "idea-gen", "2.0.0", [
      { name: "paper-search", version: "^1.0.0", source: "../paper-search" },
    ]);
    const meta = await dependencyFixture(root, "auto-research", "1.0.0", [
      { name: "idea-gen", version: "^2.0.0", source: "../idea-gen" },
    ]);

    const installation = await installPackageTree(meta);
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["paper-search", "idea-gen", "auto-research"]);
    assert.deepEqual(installation.root.lock.dependencies, ["idea-gen"]);
    assert.deepEqual(installation.packages[1]?.lock.dependencies, ["paper-search"]);

    const project = path.join(root, "project");
    await putLocks(project, installation.packages.map((pkg) => pkg.lock));
    assert.deepEqual(Object.keys((await readLock(project)).packages), ["paper-search", "idea-gen", "auto-research"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency installation rejects cycles", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const first = await dependencyFixture(root, "first", "1.0.0", [
      { name: "second", version: "1.0.0", source: "../second" },
    ]);
    await dependencyFixture(root, "second", "1.0.0", [
      { name: "first", version: "1.0.0", source: "../first" },
    ]);
    await assert.rejects(installPackageTree(first), /Package dependency cycle: first -> second -> first/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency installation rejects version and source conflicts", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await dependencyFixture(root, "shared-v1", "1.0.0");
    await dependencyFixture(root, "shared-v2", "2.0.0");
    const v1Manifest = path.join(root, "shared-v1", "harness.yaml");
    const v2Manifest = path.join(root, "shared-v2", "harness.yaml");
    await writeFile(v1Manifest, (await readFile(v1Manifest, "utf8")).replace("name: shared-v1", "name: shared"), "utf8");
    await writeFile(v2Manifest, (await readFile(v2Manifest, "utf8")).replace("name: shared-v2", "name: shared"), "utf8");
    await dependencyFixture(root, "left", "1.0.0", [
      { name: "shared", version: "^1.0.0", source: "../shared-v1" },
    ]);
    await dependencyFixture(root, "right", "1.0.0", [
      { name: "shared", version: ">=1.0.0", source: "../shared-v2" },
    ]);
    const meta = await dependencyFixture(root, "meta", "1.0.0", [
      { name: "left", version: "1.0.0", source: "../left" },
      { name: "right", version: "1.0.0", source: "../right" },
    ]);

    await assert.rejects(installPackageTree(meta), /Conflicting resolutions for shared/);

    const mismatch = await dependencyFixture(root, "mismatch", "1.0.0", [
      { name: "shared", version: "^3.0.0", source: "../shared-v1" },
    ]);
    await assert.rejects(installPackageTree(mismatch), /requires \^3\.0\.0.*resolved to 1\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed dependency resolution leaves the previous lock unchanged", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const stable = await installPackageTree(await dependencyFixture(root, "stable", "1.0.0"));
    await putLocks(project, stable.packages.map((pkg) => pkg.lock));
    const before = await readLock(project);
    const broken = await dependencyFixture(root, "broken", "1.0.0", [
      { name: "missing", version: "1.0.0", source: "../missing" },
    ]);

    await assert.rejects(installPackageTree(broken), /Local source does not exist/);
    assert.deepEqual(await readLock(project), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an install cannot invalidate dependencies already present in the lock", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    await dependencyFixture(root, "shared-v1", "1.0.0");
    await dependencyFixture(root, "shared-v2", "2.0.0");
    for (const version of ["v1", "v2"]) {
      const manifest = path.join(root, `shared-${version}`, "harness.yaml");
      await writeFile(manifest, (await readFile(manifest, "utf8")).replace(`name: shared-${version}`, "name: shared"), "utf8");
    }
    const firstRoot = await dependencyFixture(root, "first-root", "1.0.0", [
      { name: "shared", version: "^1.0.0", source: "../shared-v1" },
    ]);
    const secondRoot = await dependencyFixture(root, "second-root", "1.0.0", [
      { name: "shared", version: "^2.0.0", source: "../shared-v2" },
    ]);
    const first = await installPackageTree(firstRoot);
    await putLocks(project, first.packages.map((pkg) => pkg.lock));
    const before = await readLock(project);
    const second = await installPackageTree(secondRoot);

    await assert.rejects(
      putLocks(project, second.packages.map((pkg) => pkg.lock)),
      /first-root requires shared@\^1\.0\.0, but the lock resolves 2\.0\.0/,
    );
    assert.deepEqual(await readLock(project), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Git package cannot read a local dependency source", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const repository = await dependencyFixture(root, "remote.git", "1.0.0", [
      { name: "local-secret", version: "1.0.0", source: "../local-secret" },
    ]);
    const manifest = path.join(repository, "harness.yaml");
    await writeFile(manifest, (await readFile(manifest, "utf8")).replace("name: remote.git", "name: remote-package"), "utf8");
    await run("git", ["init"], { cwd: repository });
    await run("git", ["add", "."], { cwd: repository });
    await run("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-m", "fixture"], {
      cwd: repository,
    });

    await assert.rejects(
      installPackageTree(repository),
      /remote-package.*cannot use local dependency source \.\.\/local-secret/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("cache loading rejects a lock whose package identity was changed", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    await assert.rejects(loadCachedPackage({ ...pkg.lock, version: "2.0.0" }), /Locked identity mismatch/);
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

test("packages reject a declared skill root symlink", { concurrency: false }, async () => {
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
    await assert.rejects(installPackageSource(packageRoot), /root is an unsupported symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses to reuse a modified content-addressed cache", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    await writeFile(path.join(pkg.root, "skills", "integrity-skill", "SKILL.md"), "tampered", "utf8");
    await assert.rejects(installPackageSource(packageRoot), /Cached package is corrupt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync restores a locked package after cache loss", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    await rm(pkg.root, { recursive: true, force: true });
    const restored = await syncLockedPackage(pkg.lock);
    assert.equal(restored.manifest.metadata.name, "integrity-test");
    assert.equal(restored.root, pkg.root);
    await loadCachedPackage(pkg.lock);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync refuses a local source that drifted from its lock", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    await rm(pkg.root, { recursive: true, force: true });
    await writeFile(path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"), "drifted", "utf8");
    await assert.rejects(syncLockedPackage(pkg.lock), /Locked integrity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
