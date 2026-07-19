import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
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
  readEnvironment,
  readEnvironmentLock,
  removeEnvironment,
  syncEnvironment,
} from "../src/environment.js";
import { environmentViewPath } from "../src/view.js";
import { initializeProjectMemory, packageMemoryPath, projectMemoryPath } from "../src/memory.js";

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
    await rm(root, { recursive: true, force: true });
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
    assert.deepEqual(base.spec.roots.map((item) => item.name), ["harness-project-memory", "meta-skill-builder"]);
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("activation rejects an invalid current Environment before runtime or project mutation", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-invalid-current-"));
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await mkdir(project, { recursive: true });
    await createEnvironment(project, "tools", ["codex"]);
    const sharedAuth = path.join(process.env.HARNESS_HOME, "runtime", "codex", "auth.json");
    await writeFile(sharedAuth, '{"auth":"keep"}\n', "utf8");
    process.env.HARNESS_ENV = "../../victim";

    await assert.rejects(activateEnvironment(project, "tools"), /Invalid Environment name/);

    assert.equal(await readFile(sharedAuth, "utf8"), '{"auth":"keep"}\n');
    await assert.rejects(access(path.join(project, ".harness")));
    await assert.rejects(access(path.join(project, ".gitignore")));
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown target activation does not reconcile the current runtime", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-runtime-preflight-"));
  const project = path.join(root, "project");
  const previousEnvironment = process.env.HARNESS_ENV;
  const previousCodexHome = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await mkdir(project, { recursive: true });
    await createEnvironment(project, "current", ["codex"]);
    const viewAuth = path.join(environmentViewPath("current"), "codex", "auth.json");
    const sharedAuth = path.join(process.env.HARNESS_HOME, "runtime", "codex", "auth.json");
    await writeFile(viewAuth, '{"auth":"shared-old"}\n', "utf8");
    await rm(viewAuth);
    await writeFile(viewAuth, '{"auth":"unreconciled-new"}\n', "utf8");
    process.env.HARNESS_ENV = "current";

    await assert.rejects(activateEnvironment(project, "missing"), /Unknown environment: missing/);

    assert.equal(await readFile(sharedAuth, "utf8"), '{"auth":"shared-old"}\n');
    assert.equal((await lstat(viewAuth)).isSymbolicLink(), false);
    assert.equal(await readFile(viewAuth, "utf8"), '{"auth":"unreconciled-new"}\n');
  } finally {
    if (previousEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previousEnvironment;
    if (previousCodexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
      recipe.replace(/    - name: meta-skill-builder\n      source: builtin:meta-skill-builder\n/, ""),
      "utf8",
    );
    await assert.rejects(readEnvironment(root, "tools"), /missing foundational root package meta-skill-builder/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    assert.deepEqual(environment.spec.roots.map((item) => item.name), ["harness-project-memory", "meta-skill-builder"]);
    assert.deepEqual(Object.keys(lock.packages), ["harness-project-memory", "meta-skill-builder"]);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("install can initialize and lock base as the first Harness command", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-first-install-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await installIntoEnvironment(root, "base", "builtin:paper-search");
    assert.deepEqual(Object.keys((await readEnvironmentLock(root, "base")).packages), [
      "harness-project-memory",
      "meta-skill-builder",
      "paper-search",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
      onResourcesApplied: async () => {
        enterCommit();
        await release;
      },
    });
    await entered;
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
          assert.match(await readFile(trackedPaths[2]!, "utf8"), /Version two/);
          assert.match(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8"), /"version": "2.0.0"/);
          assert.equal((await readEnvironmentLock(root, "tools")).packages["upgrade-package"]?.version, "1.0.0");
          throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );

    assert.equal(interruptedAfterMutation, true);
    assert.deepEqual(await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});
