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
