import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEnvironment,
  doctorEnvironment,
  environmentLockPath,
  environmentPath,
  installIntoEnvironment,
  readEnvironment,
  readEnvironmentLock,
  uninstallFromEnvironment,
} from "../src/environment.js";
import { environmentAgentHomePath, environmentViewPath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

interface DependencyFixture {
  name: string;
  source: string;
}

async function packageFixture(
  root: string,
  name: string,
  dependencies: DependencyFixture[] = [],
  sharedResource?: string,
): Promise<string> {
  const packageRoot = path.join(root, name);
  const dependencyYaml = dependencies.length === 0
    ? ""
    : `  dependencies:\n${dependencies
        .map((dependency) =>
          `    - name: ${dependency.name}\n      version: ^1.0.0\n      source: ${JSON.stringify(dependency.source)}`,
        )
        .join("\n")}\n`;
  await mkdir(path.join(packageRoot, "skills", name), { recursive: true });
  await writeFile(
    path.join(packageRoot, "woma.yaml"),
    `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: ${name}
  version: 1.0.0
  description: ${name} uninstall fixture.
spec:
  platforms: [codex, claude, pi]
${dependencyYaml}  skills:
    - name: ${name}
      path: ./skills/${name}
  mcpServers:
    - name: ${name}-server
      transport: stdio
      command: node
      platforms: [codex, claude]
${sharedResource ? `    - name: ${sharedResource}-server
      transport: stdio
      command: node
      platforms: [codex, claude]
` : ""}  hooks:
    - event: PostToolUse
      matcher: ${name}
      command: ${name}-hook
      platforms: [codex, claude]
${sharedResource ? `    - event: PostToolUse
      matcher: ${sharedResource}
      command: ${sharedResource}-hook
      platforms: [codex, claude]
` : ""}`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} uninstall fixture.\n---\n\n${name}.\n`,
    "utf8",
  );
  return packageRoot;
}

test("uninstall prunes orphaned dependencies and resources while retaining shared dependencies", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-uninstall-shared-"));
  const previousHome = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const shared = await packageFixture(root, "shared-package");
    const orphan = await packageFixture(root, "orphan-package");
    const first = await packageFixture(
      root,
      "first-root",
      [
        { name: "shared-package", source: shared },
        { name: "orphan-package", source: orphan },
      ],
      "shared-owned",
    );
    const second = await packageFixture(
      root,
      "second-root",
      [{ name: "shared-package", source: shared }],
      "shared-owned",
    );
    await createEnvironment(root, "tools", ["codex", "claude", "pi"]);
    const installed = await installIntoEnvironment(root, "tools", first);
    await installIntoEnvironment(root, "tools", second);
    const orphanStore = installed.packages.find((pkg) => pkg.lock.name === "orphan-package")!.root;

    const result = await uninstallFromEnvironment(root, "tools", "first-root");

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.packages.map((pkg) => pkg.lock.name), ["first-root", "orphan-package"]);
    assert.deepEqual(result.dependencies.map((pkg) => pkg.lock.name), ["orphan-package"]);
    assert.deepEqual(result.skills, ["first-root", "orphan-package"]);
    assert.deepEqual(result.mcpServers, ["first-root-server", "orphan-package-server"]);
    assert.deepEqual(result.hooks, [
      "PostToolUse (first-root): first-root-hook",
      "PostToolUse (orphan-package): orphan-package-hook",
    ]);
    assert.deepEqual((await readEnvironment(root, "tools")).spec.roots.map((item) => item.name), [
      "woma-project-memory",
      "woma-package-builder",
      "second-root",
    ]);
    assert.deepEqual(Object.keys((await readEnvironmentLock(root, "tools")).packages), [
      "woma-project-memory",
      "woma-package-builder",
      "shared-package",
      "second-root",
    ]);
    for (const platform of ["codex", "claude", "pi"] as const) {
      const skills = path.join(environmentViewPath("tools"), platform, "skills");
      await assert.rejects(access(path.join(skills, "first-root")), /ENOENT/);
      await assert.rejects(access(path.join(skills, "orphan-package")), /ENOENT/);
      await access(path.join(skills, "shared-package", "SKILL.md"));
    }
    const codexHome = environmentAgentHomePath("tools", "codex");
    const codexConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.doesNotMatch(codexConfig, /first-root-server|orphan-package-server/);
    assert.match(codexConfig, /shared-package-server/);
    assert.match(codexConfig, /shared-owned-server/);
    const codexHooks = await readFile(path.join(codexHome, "hooks.json"), "utf8");
    assert.doesNotMatch(codexHooks, /first-root-hook|orphan-package-hook/);
    assert.match(codexHooks, /shared-package-hook/);
    assert.match(codexHooks, /shared-owned-hook/);
    const claudeHome = environmentAgentHomePath("tools", "claude");
    const claudeState = await readFile(path.join(claudeHome, ".claude.json"), "utf8");
    assert.doesNotMatch(claudeState, /first-root-server|orphan-package-server/);
    assert.match(claudeState, /shared-package-server/);
    assert.match(claudeState, /shared-owned-server/);
    const claudeSettings = await readFile(path.join(claudeHome, "settings.json"), "utf8");
    assert.doesNotMatch(claudeSettings, /first-root-hook|orphan-package-hook/);
    assert.match(claudeSettings, /shared-package-hook/);
    assert.match(claudeSettings, /shared-owned-hook/);
    await access(orphanStore);
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});

test("uninstall rejects foundational, dependency-only, and unknown Packages without changing the Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-uninstall-rejections-"));
  const previousHome = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const dependency = await packageFixture(root, "only-dependency");
    const parent = await packageFixture(root, "parent-root", [{ name: "only-dependency", source: dependency }]);
    await createEnvironment(root, "tools", ["codex", "claude", "pi"]);
    await installIntoEnvironment(root, "tools", parent);
    const tracked = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      path.join(environmentViewPath("tools"), "view.json"),
    ];
    const before = await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8")));
    const beforeView = await readlink(environmentViewPath("tools"));

    await assert.rejects(
      uninstallFromEnvironment(root, "tools", "only-dependency"),
      /not a root Package.*required by roots: parent-root/,
    );
    await assert.rejects(
      uninstallFromEnvironment(root, "tools", "woma-project-memory"),
      /Cannot uninstall foundational Package woma-project-memory/,
    );
    await assert.rejects(
      uninstallFromEnvironment(root, "tools", "not-installed"),
      /Package not-installed is not installed in Environment tools/,
    );
    assert.deepEqual(await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});

test("uninstall dry-run reports the complete plan without publishing changes", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-uninstall-dry-run-"));
  const previousHome = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const dependency = await packageFixture(root, "preview-dependency");
    const parent = await packageFixture(root, "preview-root", [{ name: "preview-dependency", source: dependency }]);
    await createEnvironment(root, "tools", ["codex", "claude", "pi"]);
    await installIntoEnvironment(root, "tools", parent);
    const tracked = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      path.join(environmentViewPath("tools"), "view.json"),
      path.join(environmentAgentHomePath("tools", "codex"), "config.toml"),
      path.join(environmentAgentHomePath("tools", "claude"), ".claude.json"),
    ];
    const before = await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8")));
    const beforeView = await readlink(environmentViewPath("tools"));
    let mutationHookCalled = false;

    const result = await uninstallFromEnvironment(root, "tools", "preview-root", {
      dryRun: true,
      onResourcesApplied: () => { mutationHookCalled = true; },
      onViewPrepared: () => { mutationHookCalled = true; },
      onMetadataPrepared: () => { mutationHookCalled = true; },
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.packages.map((pkg) => pkg.lock.name), ["preview-root", "preview-dependency"]);
    assert.deepEqual(result.dependencies.map((pkg) => pkg.lock.name), ["preview-dependency"]);
    assert.deepEqual(result.skills, ["preview-dependency", "preview-root"]);
    assert.deepEqual(result.mcpServers, ["preview-dependency-server", "preview-root-server"]);
    assert.equal(mutationHookCalled, false);
    assert.deepEqual(await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});

test("uninstall dry-run does not initialize an absent base Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-uninstall-absent-base-"));
  const previousHome = process.env.WOMA_HOME;
  const home = path.join(root, "home");
  process.env.WOMA_HOME = home;
  try {
    await assert.rejects(
      uninstallFromEnvironment(root, "base", "not-installed", { dryRun: true }),
      /Unknown environment: base/,
    );
    await assert.rejects(access(home), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});

test("failed uninstall publication restores recipe, lock, stable homes, and view", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-uninstall-rollback-"));
  const previousHome = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const removable = await packageFixture(root, "rollback-root");
    await createEnvironment(root, "tools", ["codex", "claude", "pi"]);
    await installIntoEnvironment(root, "tools", removable);
    const tracked = [
      environmentPath(root, "tools"),
      environmentLockPath(root, "tools"),
      path.join(environmentViewPath("tools"), "view.json"),
      path.join(environmentAgentHomePath("tools", "codex"), "config.toml"),
      path.join(environmentAgentHomePath("tools", "codex"), "hooks.json"),
      path.join(environmentAgentHomePath("tools", "claude"), ".claude.json"),
      path.join(environmentAgentHomePath("tools", "claude"), "settings.json"),
    ];
    const before = await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8")));
    const beforeView = await readlink(environmentViewPath("tools"));
    let reachedFailure = false;

    await assert.rejects(
      uninstallFromEnvironment(root, "tools", "rollback-root", {
        onMetadataPrepared: async () => {
          reachedFailure = true;
          assert.equal((await readEnvironment(root, "tools")).spec.roots.some((item) => item.name === "rollback-root"), false);
          assert.doesNotMatch(
            await readFile(path.join(environmentAgentHomePath("tools", "claude"), ".claude.json"), "utf8"),
            /rollback-root-server/,
          );
          assert.equal(await readlink(environmentViewPath("tools")), beforeView);
          throw new Error("injected uninstall failure");
        },
      }),
      /injected uninstall failure/,
    );

    assert.equal(reachedFailure, true);
    assert.deepEqual(await Promise.all(tracked.map((filePath) => readFile(filePath, "utf8"))), before);
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
    assert.equal((await doctorEnvironment(root, "tools")).some((check) => check.status === "fail"), false);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});
