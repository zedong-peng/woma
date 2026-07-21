import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEnvironment,
  ensureBaseEnvironment,
  environmentSnapshot,
  environmentLockPath,
  environmentPath,
  parseEnvironment,
  deactivateEnvironment,
  activateEnvironment,
  doctorEnvironment,
  installIntoEnvironment,
  listEnvironments,
  readEnvironment,
  readEnvironmentLock,
  removeEnvironment,
  syncEnvironment,
} from "../src/environment.js";
import { environmentAgentHomePath, environmentViewPath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";
import { initializeProjectMemory, packageMemoryPath, projectMemoryPath } from "../src/memory.js";
import { migrateExistingSkills } from "../src/migrate-skills.js";

async function environmentPackageFixture(
  root: string,
  directory: string,
  version: string,
  content: string,
  mcpCommand?: string,
): Promise<string> {
  const packageRoot = path.join(root, directory);
  await mkdir(path.join(packageRoot, "skills", "upgrade-skill"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: upgrade-package
  version: ${version}
  description: Active install transaction fixture.
spec:
  platforms: [codex]
  skills:
    - name: upgrade-skill
      path: ./skills/upgrade-skill
${mcpCommand ? `  mcpServers:\n    - name: occupied\n      transport: stdio\n      command: ${mcpCommand}\n` : ""}`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "skills", "upgrade-skill", "SKILL.md"),
    `---\nname: upgrade-skill\ndescription: Upgrade fixture.\n---\n\n${content}\n`,
    "utf8",
  );
  return packageRoot;
}

test("environment paths reject traversal names", () => {
  assert.throws(() => environmentPath("/tmp/project", "../../outside"), /must use lowercase letters/);
  assert.throws(() => environmentLockPath("/tmp/project", "../outside"), /must use lowercase letters/);
});

test("Skill migration dry-run does not initialize an absent base Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-migration-base-preview-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const home = path.join(root, "home");
    const codex = path.join(root, "codex");
    await mkdir(path.join(codex, "skills", "preview-skill"), { recursive: true });
    await writeFile(
      path.join(codex, "skills", "preview-skill", "SKILL.md"),
      "---\nname: preview-skill\ndescription: Preview Skill.\n---\nPreview.\n",
    );
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "claude");

    const result = await migrateExistingSkills({ projectRoot: root, environment: "base", from: "codex", dryRun: true });
    assert.equal(result.environment, "base");
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.packages.map((pkg) => pkg.name), ["preview-skill"]);
    await assert.rejects(access(home), /ENOENT/);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("explicit Skill migration snapshots existing Skills into only the selected Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-existing-skills-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const home = path.join(root, "home");
    const codex = path.join(root, "codex");
    const claude = path.join(root, "claude");
    const sharedSkill = path.join(root, "shared-skill");
    await mkdir(sharedSkill, { recursive: true });
    const legacySkill = "---\nname: existing-review\ndescription: Existing review Skill: keep compatible.\n---\nReview.\n";
    await writeFile(path.join(sharedSkill, "SKILL.md"), legacySkill);
    await mkdir(path.join(codex, "skills"), { recursive: true });
    await symlink(sharedSkill, path.join(codex, "skills", "existing-review"));
    await mkdir(path.join(sharedSkill, ".git"), { recursive: true });
    await writeFile(path.join(sharedSkill, ".git", "codex-only"), "ignored\n");
    await mkdir(path.join(codex, "skills", ".system"), { recursive: true });
    await writeFile(path.join(codex, "skills", ".system", ".codex-system-skills.marker"), "managed\n");
    await mkdir(path.join(claude, "skills", "existing-review"), { recursive: true });
    await writeFile(
      path.join(claude, "skills", "existing-review", "SKILL.md"),
      legacySkill,
    );
    await mkdir(path.join(claude, "skills", "existing-review", "node_modules"), { recursive: true });
    await writeFile(path.join(claude, "skills", "existing-review", "node_modules", "claude-only"), "ignored\n");
    await mkdir(path.join(claude, "skills", "claude-notes"), { recursive: true });
    await writeFile(
      path.join(claude, "skills", "claude-notes", "SKILL.md"),
      "---\nname: claude-notes\ndescription: Existing notes Skill.\n---\nTake notes.\n",
    );
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = claude;

    const base = await ensureBaseEnvironment(root);
    assert.deepEqual(base.spec.roots.map((item) => item.name), ["harness-project-memory", "harness-package-builder"]);
    const codexSkills = path.join(environmentViewPath("base"), "codex", "skills");
    await assert.rejects(readFile(path.join(codexSkills, "existing-review", "SKILL.md")), /ENOENT/);
    const system = path.join(codexSkills, ".system");
    assert.equal((await lstat(system)).isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(system), await readlink(system)),
      path.join(home, "environments", "base", "home", "codex-system-skills"),
    );
    await writeFile(path.join(system, "updated-by-codex"), "updated\n");
    assert.equal(
      await readFile(path.join(home, "environments", "base", "home", "codex-system-skills", "updated-by-codex"), "utf8"),
      "updated\n",
    );
    await assert.rejects(readFile(path.join(codex, "skills", ".system", "updated-by-codex")), /ENOENT/);

    await createEnvironment(root, "clean", ["codex"]);
    const planned = await migrateExistingSkills({ projectRoot: root, environment: "clean", from: "both", dryRun: true });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.packages.length, 2);
    assert.deepEqual(planned.packages.find((pkg) => pkg.name === "existing-review")?.sources, ["codex", "claude"]);
    assert.deepEqual(planned.normalized, ["existing-review"]);
    const cleanLock = await readEnvironmentLock(root, "clean");
    assert.deepEqual(Object.keys(cleanLock.packages), ["harness-project-memory", "harness-package-builder"]);
    await assert.rejects(access(path.join(home, "migrations")), /ENOENT/);

    const migrated = await migrateExistingSkills({ projectRoot: root, environment: "clean", from: "both" });
    assert.equal(migrated.unchanged, false);
    assert.deepEqual(
      Object.keys((await readEnvironmentLock(root, "clean")).packages),
      ["harness-project-memory", "harness-package-builder", "claude-notes", "existing-review"],
    );
    const existingReview = migrated.packages.find((pkg) => pkg.name === "existing-review");
    assert.ok(existingReview);
    const snapshotRoot = existingReview.source.slice("file:".length);
    for (const snapshotPath of [
      snapshotRoot,
      path.join(snapshotRoot, "harness.yaml"),
      path.join(snapshotRoot, "skills"),
      path.join(snapshotRoot, "skills", "existing-review"),
      path.join(snapshotRoot, "skills", "existing-review", "SKILL.md"),
    ]) {
      assert.equal((await lstat(snapshotPath)).mode & 0o222, 0, `${snapshotPath} must be read-only`);
    }
    assert.match(
      await readFile(path.join(environmentViewPath("clean"), "codex", "skills", "existing-review", "SKILL.md"), "utf8"),
      /description: "Existing review Skill: keep compatible\."/,
    );
    assert.match(
      await readFile(path.join(environmentViewPath("clean"), "codex", "skills", "claude-notes", "SKILL.md"), "utf8"),
      /Take notes/,
    );
    assert.equal(await readFile(path.join(sharedSkill, "SKILL.md"), "utf8"), legacySkill);
    assert.equal((await lstat(path.join(codex, "skills", "existing-review"))).isSymbolicLink(), true);
    await assert.rejects(readFile(path.join(codexSkills, "existing-review", "SKILL.md")), /ENOENT/);

    const repeated = await migrateExistingSkills({ projectRoot: root, environment: "clean", from: "both" });
    assert.equal(repeated.unchanged, true);
    assert.deepEqual(repeated.packages, migrated.packages.map((pkg) => ({ ...pkg, unchanged: true })));

    await mkdir(path.join(codex, "skills", "new-codex-skill"), { recursive: true });
    await writeFile(
      path.join(codex, "skills", "new-codex-skill", "SKILL.md"),
      "---\nname: new-codex-skill\ndescription: New Skill.\n---\nNew.\n",
    );
    const upgraded = await migrateExistingSkills({ projectRoot: root, environment: "clean", from: "both" });
    assert.equal(
      upgraded.packages.find((pkg) => pkg.name === "existing-review")?.version,
      existingReview.version,
    );
    assert.equal(upgraded.packages.find((pkg) => pkg.name === "existing-review")?.unchanged, true);
    assert.equal(upgraded.packages.find((pkg) => pkg.name === "new-codex-skill")?.unchanged, false);
    await access(existingReview.source.slice("file:".length));
    assert.match(
      await readFile(path.join(environmentViewPath("clean"), "codex", "skills", "new-codex-skill", "SKILL.md"), "utf8"),
      /New Skill/,
    );
    assert.equal((await lstat(path.join(environmentViewPath("clean"), "codex", "skills", ".system"))).isSymbolicLink(), true);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("explicit Skill migration rejects source conflicts without changing the Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-existing-skill-conflict-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const home = path.join(root, "home");
    const codex = path.join(root, "codex");
    const claude = path.join(root, "claude");
    for (const [agent, body] of [[codex, "Codex"], [claude, "Claude"]] as const) {
      const skill = path.join(agent, "skills", "review");
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), `---\nname: review\ndescription: Review Skill.\n---\n${body}\n`);
    }
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = claude;
    await ensureBaseEnvironment(root);
    const before = await readFile(environmentLockPath(root, "base"));
    await assert.rejects(
      migrateExistingSkills({ projectRoot: root, environment: "base", from: "both" }),
      /differs between Codex and Claude/,
    );
    assert.deepEqual(await readFile(environmentLockPath(root, "base")), before);
    await assert.rejects(access(path.join(home, "migrations")), /ENOENT/);
    const codexOnly = await migrateExistingSkills({ projectRoot: root, environment: "base", from: "codex" });
    assert.deepEqual(codexOnly.packages.map((pkg) => pkg.name), ["review"]);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("explicit Skill migration rejects target ownership conflicts before publishing", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-existing-skill-owner-conflict-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const home = path.join(root, "home");
    const codex = path.join(root, "codex");
    const skill = path.join(codex, "skills", "occupied-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: occupied-skill\ndescription: Existing Skill.\n---\nExisting.\n",
    );
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "claude");

    await createEnvironment(root, "tools", ["codex"]);
    const packageRoot = path.join(root, "owner-package");
    await mkdir(path.join(packageRoot, "skills", "occupied-skill"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: owner-package
  version: 1.0.0
  description: Target ownership conflict fixture.
spec:
  platforms: [codex]
  skills:
    - name: occupied-skill
      path: ./skills/occupied-skill
`,
    );
    await writeFile(
      path.join(packageRoot, "skills", "occupied-skill", "SKILL.md"),
      "---\nname: occupied-skill\ndescription: Owned Skill.\n---\nOwned.\n",
    );
    await installIntoEnvironment(root, "tools", packageRoot);
    const beforeRecipe = await readFile(environmentPath(root, "tools"));
    const beforeLock = await readFile(environmentLockPath(root, "tools"));
    const beforeView = await readFile(
      path.join(environmentViewPath("tools"), "codex", "skills", "occupied-skill", "SKILL.md"),
    );

    await assert.rejects(
      migrateExistingSkills({ projectRoot: root, environment: "tools", from: "codex" }),
      /Skill occupied-skill is already provided by Package owner-package in Environment tools/,
    );
    assert.deepEqual(await readFile(environmentPath(root, "tools")), beforeRecipe);
    assert.deepEqual(await readFile(environmentLockPath(root, "tools")), beforeLock);
    assert.deepEqual(
      await readFile(path.join(environmentViewPath("tools"), "codex", "skills", "occupied-skill", "SKILL.md")),
      beforeView,
    );
    await assert.rejects(access(path.join(home, "migrations")), /ENOENT/);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("explicit Skill migration does not replace a user Package with the Skill name", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-migration-package-name-conflict-"));
  const previous = {
    home: process.env.HARNESS_HOME,
    codex: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claude: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const home = path.join(root, "home");
    const codex = path.join(root, "codex");
    await mkdir(path.join(codex, "skills", "incoming-skill"), { recursive: true });
    await writeFile(
      path.join(codex, "skills", "incoming-skill", "SKILL.md"),
      "---\nname: incoming-skill\ndescription: Incoming Skill.\n---\nIncoming.\n",
    );
    process.env.HARNESS_HOME = home;
    process.env.HARNESS_ORIGINAL_CODEX_HOME = codex;
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "claude");

    await createEnvironment(root, "tools", ["codex"]);
    const packageRoot = path.join(root, "reserved-name-package");
    await mkdir(path.join(packageRoot, "skills", "unrelated-skill"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: incoming-skill
  version: 9.0.0
  description: Unrelated user Package using the reserved name.
spec:
  platforms: [codex]
  skills:
    - name: unrelated-skill
      path: ./skills/unrelated-skill
`,
    );
    await writeFile(
      path.join(packageRoot, "skills", "unrelated-skill", "SKILL.md"),
      "---\nname: unrelated-skill\ndescription: Unrelated Skill.\n---\nUnrelated.\n",
    );
    await installIntoEnvironment(root, "tools", packageRoot);
    const beforeRecipe = await readFile(environmentPath(root, "tools"));
    const beforeLock = await readFile(environmentLockPath(root, "tools"));

    await assert.rejects(
      migrateExistingSkills({ projectRoot: root, environment: "tools", from: "codex" }),
      /Package name incoming-skill is already installed .* in Environment tools/,
    );
    assert.deepEqual(await readFile(environmentPath(root, "tools")), beforeRecipe);
    assert.deepEqual(await readFile(environmentLockPath(root, "tools")), beforeLock);
    await assert.rejects(access(path.join(home, "migrations")), /ENOENT/);
  } finally {
    if (previous.home === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.home;
    if (previous.codex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claude;
    await removeTestTree(root);
  }
});

test("environment recipes reject duplicate roots", () => {
  assert.throws(
    () =>
      parseEnvironment(`
apiVersion: harness.conda/environment-v1
kind: HarnessEnvironment
metadata:
  name: research
spec:
  targets: [codex]
  roots:
    - name: auto-research
      source: gh:owner/auto-research#v1.0.0
    - name: auto-research
      source: gh:owner/auto-research#v2.0.0
`),
    /duplicate root package auto-research/,
  );
});

test("environment recipes reject legacy command bindings", () => {
  assert.throws(
    () =>
      parseEnvironment(`
apiVersion: harness.conda/environment-v1
kind: HarnessEnvironment
metadata:
  name: research
spec:
  targets: [codex]
  bindings:
    test: npm test
`),
    /spec.*Unrecognized key.*bindings/s,
  );
});

test("removing an environment preserves user-owned Project Memory", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-memory-lifecycle-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await initializeProjectMemory(root);
    await writeFile(projectMemoryPath(root), "# Shared knowledge\n", "utf8");
    const scoped = packageMemoryPath(root, "auto-research");
    await writeFile(scoped, "# Research adaptation\n", "utf8");

    await removeEnvironment(root, "research");

    assert.equal(await readFile(projectMemoryPath(root), "utf8"), "# Shared knowledge\n");
    assert.equal(await readFile(scoped, "utf8"), "# Research adaptation\n");
  } finally {
    await removeTestTree(root);
  }
});

test("global environments are shared across projects while Project Memory remains isolated", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-global-environment-"));
  const home = path.join(root, "home");
  const firstProject = path.join(root, "first-project");
  const secondProject = path.join(root, "second-project");
  process.env.HARNESS_HOME = home;
  try {
    await Promise.all([mkdir(firstProject, { recursive: true }), mkdir(secondProject, { recursive: true })]);
    const base = await ensureBaseEnvironment(firstProject);
    assert.deepEqual(base.spec.roots.map((item) => item.name), ["harness-project-memory", "harness-package-builder"]);
    assert.equal(environmentPath(secondProject, "base"), path.join(home, "environments", "base", "environment.yaml"));
    await assert.rejects(createEnvironment(firstProject, "base", ["codex"]), /exists implicitly/);
    await assert.rejects(removeEnvironment(firstProject, "base"), /cannot be removed/);

    await createEnvironment(firstProject, "research", ["codex"]);
    await installIntoEnvironment(firstProject, "research", "builtin:paper-search");
    assert.deepEqual(await readEnvironmentLock(secondProject, "research"), await readEnvironmentLock(firstProject, "research"));
    await activateEnvironment(firstProject, "research");
    await activateEnvironment(secondProject, "research");
    await assert.rejects(access(path.join(firstProject, ".harness", "state.json")));
    await assert.rejects(access(path.join(secondProject, ".harness", "state.json")));
    const sharedSkill = path.join(environmentViewPath("research"), "codex", "skills", "paper-search");
    assert.equal((await lstat(sharedSkill)).isSymbolicLink(), true);
    assert.match(await readlink(sharedSkill), /packages\/paper-search\//);
    await installIntoEnvironment(secondProject, "research", "builtin:idea-gen");
    assert.match(
      await readFile(path.join(environmentViewPath("research"), "codex", "skills", "idea-gen", "SKILL.md"), "utf8"),
      /idea-gen/,
    );
    await assert.rejects(readFile(path.join(firstProject, ".agents", "skills", "idea-gen", "SKILL.md"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(secondProject, ".agents", "skills", "idea-gen", "SKILL.md"), "utf8"), /ENOENT/);
    await writeFile(projectMemoryPath(firstProject), "# First project\n", "utf8");

    assert.equal(await readFile(projectMemoryPath(firstProject), "utf8"), "# First project\n");
    assert.match(await readFile(projectMemoryPath(secondProject), "utf8"), /Project Memory/);
    assert.notEqual(packageMemoryPath(firstProject, "paper-search"), packageMemoryPath(secondProject, "paper-search"));
  } finally {
    await removeTestTree(root);
  }
});

test("activation validates an Environment before creating project files", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-activation-preflight-"));
  const project = path.join(root, "project");
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await mkdir(project, { recursive: true });

    await assert.rejects(activateEnvironment(project, "missing"), /Unknown environment: missing/);

    await assert.rejects(access(path.join(project, ".harness")));
    await assert.rejects(access(path.join(project, ".gitignore")));
    await assert.rejects(access(path.join(project, "AGENTS.md")));
  } finally {
    await removeTestTree(root);
  }
});

test("activation depends only on the validated target Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-invalid-current-"));
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await mkdir(project, { recursive: true });
    await createEnvironment(project, "tools", ["codex"]);
    process.env.HARNESS_ENV = "../../victim";

    await activateEnvironment(project, "tools");

    assert.match(await readFile(path.join(project, "AGENTS.md"), "utf8"), /Harness Project Memory/);
    assert.equal((await lstat(environmentAgentHomePath("tools", "codex"))).isDirectory(), true);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await removeTestTree(root);
  }
});

test("unknown target activation does not touch the current stable Agent home", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-runtime-preflight-"));
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await mkdir(project, { recursive: true });
    await createEnvironment(project, "current", ["codex"]);
    const opaque = path.join(environmentAgentHomePath("current", "codex"), "future.sqlite");
    await writeFile(opaque, "opaque-current-state\n", "utf8");
    process.env.HARNESS_ENV = "current";

    await assert.rejects(activateEnvironment(project, "missing"), /Unknown environment: missing/);

    assert.equal(await readFile(opaque, "utf8"), "opaque-current-state\n");
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await removeTestTree(root);
  }
});

test("activation keeps both Agent discovery files stable across target changes", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-stable-discovery-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "both", ["codex", "claude"]);
    await createEnvironment(root, "codex-only", ["codex"]);
    await activateEnvironment(root, "both");
    const claudePath = path.join(root, "CLAUDE.md");
    await writeFile(claudePath, `${await readFile(claudePath, "utf8")}\n# User Claude instructions\n`, "utf8");
    const before = await readFile(claudePath, "utf8");

    await activateEnvironment(root, "codex-only");

    assert.equal(await readFile(claudePath, "utf8"), before);
    assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /Harness Project Memory/);
  } finally {
    await removeTestTree(root);
  }
});

test("failed discovery validation leaves project initialization unchanged", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-project-rollback-"));
  const project = path.join(root, "project");
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await mkdir(project, { recursive: true });
    await ensureBaseEnvironment(project);
    const invalid = "<!-- >>> harness-conda:project-memory -->\nmodified\n<!-- <<< harness-conda:project-memory -->\n";
    await writeFile(path.join(project, "CLAUDE.md"), invalid, "utf8");

    await assert.rejects(activateEnvironment(project, "base"), /discovery block was modified/);

    assert.equal(await readFile(path.join(project, "CLAUDE.md"), "utf8"), invalid);
    await assert.rejects(access(path.join(project, ".harness")));
    await assert.rejects(access(path.join(project, ".gitignore")));
    await assert.rejects(access(path.join(project, "AGENTS.md")));
  } finally {
    await removeTestTree(root);
  }
});

test("environment removal is guarded by the current shell only", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-shell-removal-"));
  const previousEnvironment = process.env.HARNESS_ENV;
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    process.env.HARNESS_ENV = "tools";
    await assert.rejects(removeEnvironment(root, "tools"), /active in this shell/);

    process.env.HARNESS_ENV = "base";
    await removeEnvironment(root, "tools");
    await assert.rejects(readEnvironment(root, "tools"), /Unknown environment: tools/);
    await activateEnvironment(root, "base");
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("global Environment reads reject missing foundational packages", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-global-environment-contract-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    const recipePath = environmentPath(root, "tools");
    const recipe = await readFile(recipePath, "utf8");
    await writeFile(
      recipePath,
      recipe.replace(/    - name: harness-package-builder\n      source: builtin:harness-package-builder\n/, ""),
      "utf8",
    );
    await assert.rejects(readEnvironment(root, "tools"), /missing foundational root package harness-package-builder/);
  } finally {
    await removeTestTree(root);
  }
});

test("concurrent first reads initialize the implicit base Environment once", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-concurrent-init-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const [environment, lock] = await Promise.all([
      readEnvironment(root, "base"),
      readEnvironmentLock(root, "base"),
    ]);
    assert.equal(environment.metadata.name, "base");
    assert.deepEqual(environment.spec.roots.map((item) => item.name), ["harness-project-memory", "harness-package-builder"]);
    assert.deepEqual(Object.keys(lock.packages), ["harness-project-memory", "harness-package-builder"]);
  } finally {
    await removeTestTree(root);
  }
});

test("existing base initialization rejects missing lock and view state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-corruption-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await ensureBaseEnvironment(root);
    await rm(environmentLockPath(root, "base"), { force: true });
    await rm(environmentViewPath("base"), { recursive: true, force: true });

    await assert.rejects(ensureBaseEnvironment(root), /base Environment is incomplete or corrupt/i);
  } finally {
    await removeTestTree(root);
  }
});

test("existing base initialization upgrades a legacy view containing Agent state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-legacy-view-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await mkdir(process.env.HARNESS_ORIGINAL_CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.HARNESS_ORIGINAL_CODEX_HOME, "auth.json"), '{"api_key":"latest"}\n', "utf8");
    await ensureBaseEnvironment(root);
    const legacyState = path.join(environmentViewPath("base"), "codex", "goals_1.sqlite");
    await writeFile(legacyState, "legacy runtime state\n", "utf8");

    await ensureBaseEnvironment(root);

    await assert.rejects(access(path.join(environmentViewPath("base"), "codex", "goals_1.sqlite")), /ENOENT/);
    assert.equal(
      await readFile(path.join(environmentAgentHomePath("base", "codex"), "auth.json"), "utf8"),
      '{"api_key":"latest"}\n',
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await removeTestTree(root);
  }
});

test("list and doctor remain useful when current-format base layers are corrupt", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-diagnostics-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await ensureBaseEnvironment(root);
    await createEnvironment(root, "tools", ["codex"]);
    const recipePath = environmentPath(root, "base");
    const lockPath = environmentLockPath(root, "base");
    const recipe = await readFile(recipePath, "utf8");
    const lock = await readFile(lockPath, "utf8");

    await writeFile(recipePath, "not: [valid", "utf8");
    assert.deepEqual(await listEnvironments(root), ["base", "tools"]);
    assert.equal((await doctorEnvironment(root, "base"))[0]?.label, "recipe");
    assert.equal((await doctorEnvironment(root, "base"))[0]?.status, "fail");

    await writeFile(recipePath, recipe, "utf8");
    await writeFile(lockPath, "{}\n", "utf8");
    assert.equal((await doctorEnvironment(root, "base")).find((check) => check.label === "lock")?.status, "fail");

    await writeFile(lockPath, lock, "utf8");
    const parsedLock = JSON.parse(lock) as { packages: Record<string, { cacheKey: string }> };
    const packageName = "harness-project-memory";
    const skillPath = path.join(
      process.env.HARNESS_HOME!,
      "packages",
      packageName,
      parsedLock.packages[packageName]!.cacheKey,
      "skills",
      packageName,
      "SKILL.md",
    );
    await chmod(skillPath, 0o600);
    assert.equal((await doctorEnvironment(root, "base")).find((check) => check.label === `package:${packageName}`)?.status, "fail");
    await chmod(skillPath, 0o444);

    await writeFile(path.join(environmentViewPath("base"), "view.json"), "{}\n", "utf8");
    assert.equal((await doctorEnvironment(root, "base")).find((check) => check.label === "view")?.status, "fail");
  } finally {
    await removeTestTree(root);
  }
});

test("sync repairs a missing base view without requiring a healthy view first", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-sync-repair-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await ensureBaseEnvironment(root);
    await rm(environmentViewPath("base"), { force: true });

    await syncEnvironment(root, "base");

    assert.equal((await lstat(environmentViewPath("base"))).isSymbolicLink(), true);
    await ensureBaseEnvironment(root);
  } finally {
    await removeTestTree(root);
  }
});

test("install can initialize and lock base as the first Harness command", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-first-install-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await installIntoEnvironment(root, "base", "builtin:paper-search");
    assert.deepEqual(Object.keys((await readEnvironmentLock(root, "base")).packages), [
      "harness-project-memory",
      "harness-package-builder",
      "paper-search",
    ]);
  } finally {
    await removeTestTree(root);
  }
});

test("environment locks reject keys that do not match package identities", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-lock-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await installIntoEnvironment(root, "research", "builtin:paper-search");
    const filePath = environmentLockPath(root, "research");
    const lock = JSON.parse(await readFile(filePath, "utf8")) as { packages: Record<string, unknown> };
    lock.packages.alias = lock.packages["paper-search"];
    delete lock.packages["paper-search"];
    await writeFile(filePath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

    await assert.rejects(readEnvironmentLock(root, "research"), /lock key alias does not match package identity paper-search/);
  } finally {
    await removeTestTree(root);
  }
});

test("install and sync reject unreachable lock packages before resolving their sources", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-unreachable-lock-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await installIntoEnvironment(root, "research", "builtin:paper-search");
    const filePath = environmentLockPath(root, "research");
    const lock = JSON.parse(await readFile(filePath, "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    lock.packages.rogue = {
      ...lock.packages["paper-search"],
      name: "rogue",
      source: "file:/source-that-must-not-be-resolved",
    };
    await writeFile(filePath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

    await assert.rejects(syncEnvironment(root, "research"), /packages unreachable from its roots: rogue/);
    await assert.rejects(
      installIntoEnvironment(root, "research", "builtin:idea-gen"),
      /packages unreachable from its roots: rogue/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("doctor derives activation exclusively from the shell Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-doctor-"));
  const previousEnvironment = process.env.HARNESS_ENV;
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await installIntoEnvironment(root, "research", "builtin:paper-search");
    process.env.HARNESS_ENV = "research";

    const checks = await doctorEnvironment(root, "research");
    assert.equal(checks.find((check) => check.label === "activation")?.status, "ok");
    assert.equal(checks.some((check) => check.label === "active-targets"), false);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("doctor reports modified Agent Memory discovery instructions", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-context-doctor-"));
  const previousEnvironment = process.env.HARNESS_ENV;
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await installIntoEnvironment(root, "research", "builtin:harness-project-memory");
    await installIntoEnvironment(root, "research", "builtin:paper-search");
    await activateEnvironment(root, "research");
    process.env.HARNESS_ENV = "research";
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("At the beginning", "Later"), "utf8");

    const checks = await doctorEnvironment(root, "research");

    assert.equal(checks.find((check) => check.label === "memory-bootstrap")?.status, "fail");
    await assert.rejects(deactivateEnvironment(root), /discovery block was modified/);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    await removeTestTree(root);
  }
});

test("doctor checks commands required by stdio MCP servers", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-mcp-command-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = path.join(root, "mcp-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: mcp-package
  version: 1.0.0
  description: MCP command fixture.
spec:
  platforms: [codex]
  mcpServers:
    - name: missing-command
      transport: stdio
      command: harness-command-that-does-not-exist
`,
      "utf8",
    );
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", packageRoot);

    const checks = await doctorEnvironment(root, "tools");
    assert.deepEqual(checks.find((check) => check.label === "command:harness-command-that-does-not-exist"), {
      status: "fail",
      label: "command:harness-command-that-does-not-exist",
      detail: "not found on PATH",
    });
  } finally {
    await removeTestTree(root);
  }
});

test("doctor ignores stdio MCP commands outside the environment targets", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-targeted-mcp-command-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = path.join(root, "mcp-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: targeted-mcp-package
  version: 1.0.0
  description: Targeted MCP command fixture.
spec:
  platforms: [codex, claude]
  mcpServers:
    - name: claude-only
      transport: stdio
      command: harness-claude-command-that-does-not-exist
      platforms: [claude]
`,
      "utf8",
    );
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", packageRoot);

    const checks = await doctorEnvironment(root, "tools");
    assert.equal(checks.some((check) => check.label === "command:harness-claude-command-that-does-not-exist"), false);
  } finally {
    await removeTestTree(root);
  }
});

test("install atomically upgrades a package in the active environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-upgrade-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const v2 = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await activateEnvironment(root, "tools");

    await installIntoEnvironment(root, "tools", v2);

    assert.match(await readFile(path.join(environmentViewPath("tools"), "codex", "skills", "upgrade-skill", "SKILL.md"), "utf8"), /Version two/);
    assert.equal((await readEnvironmentLock(root, "tools")).packages["upgrade-package"]?.version, "2.0.0");
    await assert.rejects(access(path.join(root, ".harness", "state.json")));
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    await removeTestTree(root);
  }
});

test("Environment snapshots wait for an in-progress metadata commit", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-snapshot-lock-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const fixture = await environmentPackageFixture(root, "snapshot-package", "1.0.0", "Snapshot package.");
    await createEnvironment(root, "tools", ["codex"]);
    let enterCommit!: () => void;
    let releaseCommit!: () => void;
    const entered = new Promise<void>((resolve) => (enterCommit = resolve));
    const release = new Promise<void>((resolve) => (releaseCommit = resolve));
    const installing = installIntoEnvironment(root, "tools", fixture, process.cwd(), {
      onMetadataPrepared: async () => {
        enterCommit();
        await release;
      },
    });
    await entered;
    assert.equal(JSON.parse(await readFile(environmentLockPath(root, "tools"), "utf8")).packages["upgrade-package"].version, "1.0.0");
    assert.doesNotMatch(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8"), /upgrade-package/);
    let snapshotSettled = false;
    const snapshotPromise = environmentSnapshot(root, "tools").then((snapshot) => {
      snapshotSettled = true;
      return snapshot;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(snapshotSettled, false);

    releaseCommit();
    await installing;
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.environment.spec.roots.some((item) => item.name === "upgrade-package"), true);
    assert.equal(snapshot.lock.packages["upgrade-package"]?.version, "1.0.0");
  } finally {
    await removeTestTree(root);
  }
});

test("active install restores project state when the new package conflicts after removal", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-rollback-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "user-codex");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const conflicting = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.", "node");
    await mkdir(process.env.HARNESS_ORIGINAL_CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.HARNESS_ORIGINAL_CODEX_HOME, "config.toml"), '[mcp_servers.occupied]\ncommand = "other"\n', "utf8");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await installIntoEnvironment(root, "tools", "builtin:harness-project-memory");
    await activateEnvironment(root, "tools");
    const trackedPaths = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      path.join(environmentViewPath("tools"), "view.json"),
      path.join(environmentViewPath("tools"), "codex", "skills", "upgrade-skill", "SKILL.md"),
      path.join(root, "AGENTS.md"),
    ];
    const before = await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8")));

    await assert.rejects(installIntoEnvironment(root, "tools", conflicting), /Refusing to overwrite Codex MCP server occupied/);

    assert.deepEqual(await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    await removeTestTree(root);
  }
});

test("active install rolls back when interrupted after resources are applied", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-interruption-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const v2 = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await installIntoEnvironment(root, "tools", "builtin:harness-project-memory");
    await activateEnvironment(root, "tools");
    const trackedPaths = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      path.join(environmentViewPath("tools"), "codex", "skills", "upgrade-skill", "SKILL.md"),
      path.join(root, "AGENTS.md"),
    ];
    const before = await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8")));
    let interruptedAfterMutation = false;

    await assert.rejects(
      installIntoEnvironment(root, "tools", v2, process.cwd(), {
        onResourcesApplied: async () => {
          interruptedAfterMutation = true;
          assert.match(await readFile(trackedPaths[2]!, "utf8"), /Version one/);
          assert.match(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8"), /"version": "1.0.0"/);
          assert.equal((await readEnvironmentLock(root, "tools")).packages["upgrade-package"]?.version, "1.0.0");
          throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );

    assert.equal(interruptedAfterMutation, true);
    assert.deepEqual(await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.deepEqual(
      (await readdir(path.dirname(environmentViewPath("tools")))).filter((name) => /^\.view\.(?:link|rollback)-/.test(name)),
      [],
    );
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    await removeTestTree(root);
  }
});

test("reinstalling a foundational package preserves its recipe, lock, Skill, and startup pointer", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-memory-install-rollback-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "minimal", ["codex"]);
    await activateEnvironment(root, "minimal");
    const trackedPaths = [environmentPath(root, "minimal"), environmentLockPath(root, "minimal")];
    const before = await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8")));

    await installIntoEnvironment(root, "minimal", "builtin:harness-project-memory");

    assert.deepEqual(await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /installed `harness-project-memory` Skill/);
    assert.match(
      await readFile(path.join(environmentViewPath("minimal"), "codex", "skills", "harness-project-memory", "SKILL.md"), "utf8"),
      /Persist stable knowledge automatically/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("install rebuilds a modified global view from immutable Package contents", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-preflight-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const v2 = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await activateEnvironment(root, "tools");
    const skillLink = path.join(environmentViewPath("tools"), "codex", "skills", "upgrade-skill");
    await rm(skillLink, { force: true });
    await installIntoEnvironment(root, "tools", v2);

    assert.equal((await lstat(skillLink)).isSymbolicLink(), true);
    assert.match(await readFile(path.join(skillLink, "SKILL.md"), "utf8"), /Version two/);
    assert.equal((await readEnvironmentLock(root, "tools")).packages["upgrade-package"]?.version, "2.0.0");
    await assert.rejects(access(path.join(root, ".harness", "state.json")));
  } finally {
    await removeTestTree(root);
  }
});

test("activation holds the target Environment lock through the project transition", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-activation-remove-lock-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_ENV = "base";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    let entered!: () => void;
    let release!: () => void;
    const projectApplied = new Promise<void>((resolve) => (entered = resolve));
    const continueActivation = new Promise<void>((resolve) => (release = resolve));
    const activation = activateEnvironment(root, "tools", {
      onProjectApplied: async () => {
        entered();
        await continueActivation;
      },
    });
    await projectApplied;
    let removed = false;
    const removal = removeEnvironment(root, "tools").then(() => {
      removed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(removed, false);

    release();
    await activation;
    await removal;
    assert.equal(removed, true);
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await removeTestTree(root);
  }
});

test("project initialization failure leaves stable Agent state unchanged", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-activation-runtime-rollback-"));
  const project = path.join(root, "project");
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_ENV = "base";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await ensureBaseEnvironment(project);
    await createEnvironment(project, "tools", ["codex"]);
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, ".harness"), "blocks memory initialization\n", "utf8");
    const opaque = path.join(environmentAgentHomePath("base", "codex"), "opaque.sqlite");
    await writeFile(opaque, "stable\n", "utf8");

    await assert.rejects(activateEnvironment(project, "tools"), /ENOTDIR|not a directory/);

    assert.equal(await readFile(opaque, "utf8"), "stable\n");
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await removeTestTree(root);
  }
});

test("managed Agent home drift is rejected before project activation", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runtime-preflight-rollback-"));
  const project = path.join(root, "project");
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  const previousClaudeHome = process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
  process.env.HARNESS_ENV = "base";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  try {
    await mkdir(project, { recursive: true });
    await ensureBaseEnvironment(project);
    await createEnvironment(project, "tools", ["codex", "claude"]);
    const baseOpaque = path.join(environmentAgentHomePath("base", "codex"), "opaque.sqlite");
    await writeFile(baseOpaque, "stable\n", "utf8");
    const toolsSkills = path.join(environmentAgentHomePath("tools", "claude"), "skills");
    await rm(toolsSkills, { force: true });
    await mkdir(toolsSkills);

    await assert.rejects(activateEnvironment(project, "tools"), /Managed Agent home link is missing/);

    assert.equal(await readFile(baseOpaque, "utf8"), "stable\n");
    await assert.rejects(access(path.join(project, ".harness")));
    await assert.rejects(access(path.join(project, "AGENTS.md")));
    await assert.rejects(access(path.join(project, "CLAUDE.md")));
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    if (previousClaudeHome === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previousClaudeHome;
    await removeTestTree(root);
  }
});

test("foundational Package names cannot be replaced by user sources", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-foundational-identity-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const replacement = path.join(root, "replacement");
    await mkdir(path.join(replacement, "skills", "harness-project-memory"), { recursive: true });
    await writeFile(
      path.join(replacement, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: harness-project-memory
  version: 9.0.0
  description: Untrusted replacement.
spec:
  platforms: [codex]
  skills:
    - name: harness-project-memory
      path: ./skills/harness-project-memory
`,
      "utf8",
    );
    await writeFile(
      path.join(replacement, "skills", "harness-project-memory", "SKILL.md"),
      "---\nname: harness-project-memory\ndescription: Replacement.\n---\nReplacement.\n",
      "utf8",
    );
    await createEnvironment(root, "tools", ["codex"]);

    await assert.rejects(installIntoEnvironment(root, "tools", replacement), /can only be installed from builtin:/);
    assert.equal((await readEnvironmentLock(root, "tools")).packages["harness-project-memory"]?.source, "builtin:harness-project-memory");
  } finally {
    await removeTestTree(root);
  }
});

test("doctor rejects undeclared extra Skills in an Environment view", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-view-extra-skill-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    await mkdir(path.join(environmentViewPath("tools"), "codex", "skills", "undeclared"));

    const viewCheck = (await doctorEnvironment(root, "tools")).find((check) => check.label === "view");
    assert.equal(viewCheck?.status, "fail");
    assert.match(viewCheck?.detail ?? "", /visibility differs from the lock/);
  } finally {
    await removeTestTree(root);
  }
});
