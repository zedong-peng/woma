import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installPackageSource, installPackageTree, loadCachedPackage, repairLockedPackage } from "../src/package.js";
import { createEnvironment, installIntoEnvironment, readEnvironmentLock } from "../src/environment.js";
import { removeTestTree } from "./helpers.js";

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
  await write(path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"), "---\nname: integrity-skill\ndescription: Test.\n---\nTest.\n");
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

test("the built-in auto-research Package installs its documented component Skills", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-method-"));
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
    await removeTestTree(root);
  }
});

test("the built-in Harness Package Builder is a valid general authoring Package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-package-builder-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:harness-package-builder");
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["harness-package-builder"]);
    assert.deepEqual(installation.root.lock.dependencies, []);
    assert.deepEqual(installation.root.manifest.spec.requirements.commands, []);
    assert.deepEqual(installation.root.manifest.spec.entrypoints, [
      {
        name: "create-package",
        skill: "harness-package-builder",
        description: "Create or update a validated Harness Package containing the requested resources and dependencies.",
      },
    ]);
    const instructions = await readFile(path.join(installation.root.root, "skills", "harness-package-builder", "SKILL.md"), "utf8");
    assert.match(instructions, /harness inspect <source>/);
    assert.match(instructions, /wrap existing Skills, MCP definitions, or hooks/);
    assert.match(instructions, /dependency Packages/);
    assert.match(instructions, /coordinating Skill only when/);
    assert.match(instructions, /Package as the only distribution type/);
    const reference = await readFile(
      path.join(installation.root.root, "skills", "harness-package-builder", "references", "package-format.md"),
      "utf8",
    );
    assert.match(reference, /A dependency-only Package may omit Skills and entrypoints/);
    assert.match(reference, /For MCP servers and hooks/);
    const agentMetadata = await readFile(
      path.join(installation.root.root, "skills", "harness-package-builder", "agents", "openai.yaml"),
      "utf8",
    );
    assert.match(agentMetadata, /display_name: "Harness Package Builder"/);
    assert.match(agentMetadata, /\$harness-package-builder/);
  } finally {
    await removeTestTree(root);
  }
});

test("the built-in Project Memory manager is a normal installable Skill package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-project-memory-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:harness-project-memory");
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["harness-project-memory"]);
    assert.deepEqual(installation.root.lock.dependencies, []);
    assert.deepEqual(installation.root.manifest.spec.skills.map((skill) => skill.name), ["harness-project-memory"]);
    const instructions = await readFile(
      path.join(installation.root.root, "skills", "harness-project-memory", "SKILL.md"),
      "utf8",
    );
    assert.match(instructions, /harness info --json/);
    assert.match(instructions, /even if the user does not explicitly ask to remember it/);
    assert.match(instructions, /before using another active Skill/);
    assert.match(instructions, /--project <project-root> info --json/);
    assert.doesNotMatch(instructions, /current project or a nested directory/);
  } finally {
    await removeTestTree(root);
  }
});

test("the built-in performance method does not require command bindings", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-builtin-performance-memory-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const installation = await installPackageTree("builtin:performance-engineering");
    assert.deepEqual(installation.root.manifest.spec.requirements, { env: [], commands: ["git", "node"] });
  } finally {
    await removeTestTree(root);
  }
});

test("installing a Package resolves transitive dependencies in dependency-first order", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await dependencyFixture(root, "paper-search", "1.2.0");
    await dependencyFixture(root, "idea-gen", "2.0.0", [
      { name: "paper-search", version: "^1.0.0", source: "../paper-search" },
    ]);
    const methodPackage = await dependencyFixture(root, "auto-research", "1.0.0", [
      { name: "idea-gen", version: "^2.0.0", source: "../idea-gen" },
    ]);

    const installation = await installPackageTree(methodPackage);
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["paper-search", "idea-gen", "auto-research"]);
    assert.deepEqual(installation.root.lock.dependencies, ["idea-gen"]);
    assert.deepEqual(installation.packages[1]?.lock.dependencies, ["paper-search"]);

  } finally {
    await removeTestTree(root);
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
    await removeTestTree(root);
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
    await removeTestTree(root);
  }
});

test("failed dependency resolution leaves the previous lock unchanged", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    await createEnvironment(project, "stable", ["codex"]);
    await installIntoEnvironment(project, "stable", await dependencyFixture(root, "stable", "1.0.0"));
    const before = await readEnvironmentLock(project, "stable");
    const broken = await dependencyFixture(root, "broken", "1.0.0", [
      { name: "missing", version: "1.0.0", source: "../missing" },
    ]);

    await assert.rejects(installIntoEnvironment(project, "stable", broken), /Local source does not exist/);
    assert.deepEqual(await readEnvironmentLock(project, "stable"), before);
  } finally {
    await removeTestTree(root);
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
    await createEnvironment(project, "tools", ["codex"]);
    await installIntoEnvironment(project, "tools", firstRoot);
    const before = await readEnvironmentLock(project, "tools");

    await assert.rejects(
      installIntoEnvironment(project, "tools", secondRoot),
      /first-root requires shared@\^1\.0\.0, but the lock resolves 2\.0\.0/,
    );
    assert.deepEqual(await readEnvironmentLock(project, "tools"), before);
  } finally {
    await removeTestTree(root);
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
    await removeTestTree(root);
  }
});

test("cache integrity detects package mutation", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    const skillDocument = path.join(pkg.root, "skills", "integrity-skill", "SKILL.md");
    await chmod(skillDocument, 0o600);
    await writeFile(skillDocument, "changed", "utf8");
    await chmod(skillDocument, 0o400);
    await assert.rejects(loadCachedPackage(pkg.lock), /Integrity mismatch/);
  } finally {
    await removeTestTree(root);
  }
});

test("published Package Store entries are read-only through Skill views", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-readonly-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    const skillDocument = path.join(pkg.root, "skills", "integrity-skill", "SKILL.md");
    await assert.rejects(access(skillDocument, constants.W_OK), /EACCES/);
    await assert.rejects(writeFile(skillDocument, "cannot mutate\n", "utf8"), /EACCES/);
    await chmod(skillDocument, 0o600);
    await assert.rejects(loadCachedPackage(pkg.lock), /Cached package is writable/);
  } finally {
    await removeTestTree(root);
  }
});

test("Package validation rejects Skill identity mismatches", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-skill-name-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    await writeFile(
      path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"),
      "---\nname: different-skill\ndescription: Wrong identity.\n---\nWrong.\n",
      "utf8",
    );
    await assert.rejects(installPackageSource(packageRoot), /frontmatter name must match/);
  } finally {
    await removeTestTree(root);
  }
});

test("Package validation rejects MCP targets outside Package platforms", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-mcp-platform-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = path.join(root, "package");
    await mkdir(packageRoot);
    await writeFile(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: targeted-mcp
  version: 1.0.0
  description: Target validation fixture.
spec:
  platforms: [codex]
  mcpServers:
    - name: claude-only
      transport: stdio
      command: node
      platforms: [claude]
`,
      "utf8",
    );
    await assert.rejects(installPackageSource(packageRoot), /targets claude, which is not listed/);
  } finally {
    await removeTestTree(root);
  }
});

test("Package validation rejects Pi MCP servers and hooks until adapters exist", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-pi-resources-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const mcpRoot = path.join(root, "pi-mcp");
    await write(
      path.join(mcpRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: pi-mcp
  version: 1.0.0
  description: Unsupported Pi MCP fixture.
spec:
  platforms: [pi]
  mcpServers:
    - name: server
      transport: stdio
      command: node
`,
    );
    await assert.rejects(installPackageSource(mcpRoot), /Pi adapter currently supports Skills only/);

    const hookRoot = path.join(root, "pi-hook");
    await write(
      path.join(hookRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: pi-hook
  version: 1.0.0
  description: Unsupported Pi Hook fixture.
spec:
  platforms: [pi]
  hooks:
    - event: tool_call
      command: "true"
`,
    );
    await assert.rejects(installPackageSource(hookRoot), /Pi adapter currently supports Skills only/);
  } finally {
    await removeTestTree(root);
  }
});

test("cache loading rejects a lock whose package identity was changed", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    await assert.rejects(loadCachedPackage({ ...pkg.lock, version: "2.0.0" }), /Locked identity mismatch/);
  } finally {
    await removeTestTree(root);
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
    await removeTestTree(root);
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
    await removeTestTree(root);
  }
});

test("install repairs a modified content-addressed cache", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    await chmod(path.join(pkg.root, "skills", "integrity-skill", "SKILL.md"), 0o600);
    await writeFile(path.join(pkg.root, "skills", "integrity-skill", "SKILL.md"), "tampered", "utf8");
    const repaired = await installPackageSource(packageRoot);
    assert.match(await readFile(path.join(repaired.root, "skills", "integrity-skill", "SKILL.md"), "utf8"), /name: integrity-skill/);
  } finally {
    await removeTestTree(root);
  }
});

test("repair restores a locked package after cache loss", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(await packageFixture(root));
    await removeTestTree(pkg.root);
    const restored = await repairLockedPackage(pkg.lock);
    assert.equal(restored.manifest.metadata.name, "integrity-test");
    assert.equal(restored.root, pkg.root);
    await loadCachedPackage(pkg.lock);
  } finally {
    await removeTestTree(root);
  }
});

test("repair refuses a local source that drifted from its lock", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    await removeTestTree(pkg.root);
    await writeFile(
      path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"),
      "---\nname: integrity-skill\ndescription: Drifted.\n---\nDrifted.\n",
      "utf8",
    );
    await assert.rejects(repairLockedPackage(pkg.lock), /Locked integrity mismatch/);
  } finally {
    await removeTestTree(root);
  }
});

test("failed repair preserves the last locked cache bytes", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-preserve-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    const skillPath = path.join(pkg.root, "skills", "integrity-skill", "SKILL.md");
    const before = await readFile(skillPath);
    await chmod(skillPath, 0o600);
    await rm(packageRoot, { recursive: true, force: true });
    await assert.rejects(repairLockedPackage(pkg.lock), /Local source does not exist/);
    assert.deepEqual(await readFile(skillPath), before);
  } finally {
    await removeTestTree(root);
  }
});

test("identity and integrity mismatches preserve the old cache", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-mismatch-preserve-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const manifestPath = path.join(packageRoot, "harness.yaml");
    const sourceManifest = await readFile(manifestPath, "utf8");
    const pkg = await installPackageSource(packageRoot);
    const cachedSkill = path.join(pkg.root, "skills", "integrity-skill", "SKILL.md");
    const before = await readFile(cachedSkill);
    await chmod(cachedSkill, 0o600);

    await writeFile(manifestPath, sourceManifest.replace("name: integrity-test", "name: other-package"), "utf8");
    await assert.rejects(repairLockedPackage(pkg.lock), /Locked identity mismatch/);
    assert.deepEqual(await readFile(cachedSkill), before);

    await writeFile(manifestPath, sourceManifest, "utf8");
    await writeFile(
      path.join(packageRoot, "skills", "integrity-skill", "SKILL.md"),
      "---\nname: integrity-skill\ndescription: Drifted.\n---\nDrifted.\n",
      "utf8",
    );
    await assert.rejects(repairLockedPackage(pkg.lock), /Locked integrity mismatch/);
    assert.deepEqual(await readFile(cachedSkill), before);
  } finally {
    await removeTestTree(root);
  }
});

test("cache repair never makes shared Skill paths disappear", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-package-observer-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = await packageFixture(root);
    const pkg = await installPackageSource(packageRoot);
    const skillPath = path.join(pkg.root, "skills", "integrity-skill", "SKILL.md");
    await chmod(skillPath, 0o600);
    const reads = Promise.all(Array.from({ length: 200 }, () => readFile(skillPath, "utf8")));
    await Promise.all([reads, installPackageSource(packageRoot)]);
    for (const content of await reads) assert.match(content, /name: integrity-skill/);
  } finally {
    await removeTestTree(root);
  }
});

test("Git locators and refs reject option-like arguments", { concurrency: false }, async () => {
  await assert.rejects(installPackageSource("-c.git"), /Unsafe Git source or ref/);
  await assert.rejects(installPackageSource("gh:owner/repository#--upload-pack=bad"), /Unsafe Git source or ref/);
});
