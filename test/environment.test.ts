import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindEnvironment,
  createEnvironment,
  environmentLockPath,
  environmentPath,
  parseEnvironment,
  deactivateEnvironment,
  activateEnvironment,
  doctorEnvironment,
  installIntoEnvironment,
  readEnvironmentLock,
  syncEnvironment,
} from "../src/environment.js";
import { activatePackage } from "../src/activation.js";
import { installPackageSource } from "../src/package.js";
import { putLock, readState, statePath } from "../src/store.js";

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

test("invalid bindings do not corrupt an environment recipe", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-schema-"));
  try {
    await createEnvironment(root, "research", ["codex"]);
    const filePath = environmentPath(root, "research");
    const before = await readFile(filePath, "utf8");
    await assert.rejects(bindEnvironment(root, "research", "../test", "npm test"), /must use lowercase letters/);
    assert.equal(await readFile(filePath, "utf8"), before);
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

test("doctor reports active environment state that diverges from its recipe and lock", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-doctor-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "research", ["codex"]);
    await installIntoEnvironment(root, "research", "builtin:paper-search");
    await activateEnvironment(root, "research");
    const state = await readState(root);
    const activation = state.activations["paper-search"]!;
    state.activeEnvironment = { ...state.activeEnvironment!, packages: [], targets: ["claude"] };
    state.activations["paper-search"] = { ...activation, packageVersion: "9.9.9", targets: ["claude"] };
    state.activations.foreign = { ...activation, packageName: "foreign" };
    await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const checks = await doctorEnvironment(root, "research");
    for (const label of ["active-environment", "active-targets", "active:paper-search", "foreign:foreign"]) {
      assert.equal(checks.find((check) => check.label === label)?.status, "fail", label);
    }
  } finally {
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

    assert.match(await readFile(path.join(root, ".agents", "skills", "upgrade-skill", "SKILL.md"), "utf8"), /Version two/);
    assert.equal((await readEnvironmentLock(root, "tools")).packages["upgrade-package"]?.version, "2.0.0");
    assert.equal((await readState(root)).activations["upgrade-package"]?.packageVersion, "2.0.0");
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active install restores project state when the new package conflicts after removal", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-rollback-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const conflicting = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.", "node");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(path.join(root, ".codex", "config.toml"), '[mcp_servers.occupied]\ncommand = "other"\n', "utf8");
    await activateEnvironment(root, "tools");
    const trackedPaths = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      statePath(root),
      path.join(root, ".codex", "config.toml"),
      path.join(root, ".agents", "skills", "upgrade-skill", "SKILL.md"),
    ];
    const before = await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8")));

    await assert.rejects(installIntoEnvironment(root, "tools", conflicting), /Refusing to overwrite MCP server occupied/);

    assert.deepEqual(await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
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
    await activateEnvironment(root, "tools");
    const trackedPaths = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      statePath(root),
      path.join(root, ".agents", "skills", "upgrade-skill", "SKILL.md"),
    ];
    const before = await Promise.all(trackedPaths.map((filePath) => readFile(filePath, "utf8")));
    let interruptedAfterMutation = false;

    await assert.rejects(
      installIntoEnvironment(root, "tools", v2, process.cwd(), {
        onResourcesApplied: async () => {
          interruptedAfterMutation = true;
          assert.match(await readFile(trackedPaths[3]!, "utf8"), /Version two/);
          assert.equal((await readState(root)).activations["upgrade-package"]?.packageVersion, "2.0.0");
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

test("active install rejects managed-file drift before changing the environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-active-preflight-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const v1 = await environmentPackageFixture(root, "upgrade-v1", "1.0.0", "Version one.");
    const v2 = await environmentPackageFixture(root, "upgrade-v2", "2.0.0", "Version two.");
    await createEnvironment(root, "tools", ["codex"]);
    await installIntoEnvironment(root, "tools", v1);
    await activateEnvironment(root, "tools");
    const skillPath = path.join(root, ".agents", "skills", "upgrade-skill", "SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}User edit.\n`, "utf8");
    const recipeBefore = await readFile(environmentPath(root, "tools"), "utf8");
    const lockBefore = await readFile(environmentLockPath(root, "tools"), "utf8");
    const stateBefore = await readFile(statePath(root), "utf8");

    await assert.rejects(installIntoEnvironment(root, "tools", v2), /modified or missing managed files/);

    assert.match(await readFile(skillPath, "utf8"), /User edit/);
    assert.equal(await readFile(environmentPath(root, "tools"), "utf8"), recipeBefore);
    assert.equal(await readFile(environmentLockPath(root, "tools"), "utf8"), lockBefore);
    assert.equal(await readFile(statePath(root), "utf8"), stateBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deactivate cleans legacy profile packages and routing blocks without the old workflow engine", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-environment-migration-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource("builtin:paper-search");
    await putLock(root, pkg.lock);
    await activatePackage(pkg, root, ["codex"]);
    const block = "<!-- >>> harness-conda:active-profile -->\nlegacy\n<!-- <<< harness-conda:active-profile -->";
    await writeFile(path.join(root, "AGENTS.md"), `${block}\n`, "utf8");
    const state = await readState(root);
    state.profile = {
      name: "research",
      packages: ["paper-search"],
      targets: ["codex"],
      activatedAt: new Date().toISOString(),
      instructions: [{ path: "AGENTS.md", block }],
    };
    await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await deactivateEnvironment(root);
    assert.deepEqual((await readState(root)).activations, {});
    assert.equal((await readState(root)).profile, undefined);
    await assert.rejects(readFile(path.join(root, ".agents", "skills", "paper-search", "SKILL.md")), /ENOENT/);
    await assert.rejects(readFile(path.join(root, "AGENTS.md")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
