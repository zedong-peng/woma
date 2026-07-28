import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportEnvironmentBundle, importEnvironmentBundle } from "../src/environment-bundle.js";
import { createEnvironment, environmentPath, environmentSnapshot, installIntoEnvironment } from "../src/environment.js";
import { loadCachedPackage } from "../src/package.js";
import { environmentAgentHomePath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string | Buffer, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, mode === undefined ? undefined : { mode });
}

async function portablePackage(root: string): Promise<string> {
  const packageRoot = path.join(root, "local-performance");
  await write(
    path.join(packageRoot, "woma.yaml"),
    `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: local-performance
  version: 1.2.3
  description: Offline migration fixture.
spec:
  platforms: [codex, claude]
  requirements:
    env:
      - name: PERF_TOKEN
        optional: true
  skills:
    - name: local-performance
      path: ./skills/local-performance
  mcpServers:
    - name: local-tools
      transport: stdio
      command: node
      args: [server.mjs]
      env: [PERF_TOKEN]
  hooks:
    - event: PostToolUse
      command: git diff --check
`,
  );
  await write(
    path.join(packageRoot, "skills", "local-performance", "SKILL.md"),
    "---\nname: local-performance\ndescription: Offline fixture.\n---\nRun locally.\n",
  );
  await write(path.join(packageRoot, "skills", "local-performance", "data.bin"), Buffer.from([0, 255, 128, 1, 2, 0]));
  await write(path.join(packageRoot, "skills", "local-performance", "run.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  await write(path.join(packageRoot, ".harness", "local", "memory.md"), "legacy-private-memory\n");
  return packageRoot;
}

function rewriteBundle(input: Buffer, mutate: (document: any) => void): Buffer {
  const document = JSON.parse(gunzipSync(input).toString("utf8"));
  mutate(document);
  return gzipSync(Buffer.from(JSON.stringify(document), "utf8"), { level: 9 });
}

test("Environment bundle restores a local Package offline into a fresh Store", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-roundtrip-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  try {
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const source = await portablePackage(root);
    const bundle = path.join(root, "performance.woma-env");
    await write(path.join(originalCodex, "auth.json"), '{"token":"must-not-export"}\n');
    await write(path.join(projectA, ".woma", "memory", "project.md"), "private project memory\n");
    process.env.WOMA_HOME = path.join(root, "home-a");
    process.env.WOMA_ENV = "base";
    process.env.WOMA_ORIGINAL_CODEX_HOME = originalCodex;
    process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
    await createEnvironment(projectA, "performance", ["codex", "claude"]);
    await installIntoEnvironment(projectA, "performance", source);
    await write(
      path.join(environmentAgentHomePath("performance", "codex"), "skills", ".system", "private-runtime-skill", "SKILL.md"),
      "must-not-export-system-skill\n",
    );
    const before = await environmentSnapshot(projectA, "performance");
    const first = await exportEnvironmentBundle(projectA, "performance", bundle);
    assert.equal(first.packages, 1);

    const secondBundle = path.join(root, "performance-copy.woma-env");
    await exportEnvironmentBundle(projectA, "performance", secondBundle);
    assert.deepEqual(await readFile(bundle), await readFile(secondBundle));
    const unchanged = await readFile(bundle);
    await assert.rejects(exportEnvironmentBundle(projectA, "performance", bundle), /Refusing to overwrite/);
    assert.deepEqual(await readFile(bundle), unchanged);
    const document = gunzipSync(await readFile(bundle)).toString("utf8");
    assert.doesNotMatch(document, /must-not-export|private project memory|legacy-private-memory|auth\.json|private-runtime-skill/);

    await rm(source, { recursive: true, force: true });
    await removeTestTree(process.env.WOMA_HOME);
    process.env.WOMA_HOME = path.join(root, "home-b");
    const imported = await importEnvironmentBundle(projectB, bundle);
    assert.equal(imported.snapshot.environment.metadata.name, "performance");
    assert.deepEqual(imported.snapshot.environment.spec, before.environment.spec);
    assert.deepEqual(imported.snapshot.lock, before.lock);

    const localLock = imported.snapshot.lock.packages["local-performance"]!;
    const local = await loadCachedPackage(localLock);
    assert.deepEqual(
      await readFile(path.join(local.root, "skills", "local-performance", "data.bin")),
      Buffer.from([0, 255, 128, 1, 2, 0]),
    );
    assert.equal((await readFile(path.join(local.root, "skills", "local-performance", "run.sh"), "utf8")).startsWith("#!/bin/sh"), true);
    assert.match(await readFile(path.join(process.env.WOMA_HOME, "environments", "performance", "view", "codex", "config.toml"), "utf8"), /local-tools/);
    assert.match(await readFile(path.join(process.env.WOMA_HOME, "environments", "performance", "view", "claude", "settings.json"), "utf8"), /git diff --check/);
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.womaEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previous.womaEnvironment;
    if (previous.codexHome === undefined) delete process.env.WOMA_ORIGINAL_CODEX_HOME;
    else process.env.WOMA_ORIGINAL_CODEX_HOME = previous.codexHome;
    if (previous.claudeHome === undefined) delete process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claudeHome;
    await removeTestTree(root);
  }
});

test("Environment bundle migration drops legacy implicit helpers before Store import", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-legacy-helpers-"));
  const previousHome = process.env.WOMA_HOME;
  try {
    const source = await portablePackage(root);
    const memory = path.join(root, "legacy-memory");
    await write(
      path.join(memory, "woma.yaml"),
      `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: woma-project-memory
  version: 0.1.0
  description: Legacy bundle migration fixture.
spec:
  platforms: [codex, claude]
  skills:
    - name: woma-project-memory
      path: ./skills/woma-project-memory
`,
    );
    await write(
      path.join(memory, "skills", "woma-project-memory", "SKILL.md"),
      "---\nname: woma-project-memory\ndescription: Legacy bundle fixture.\n---\nLegacy.\n",
    );
    const bundle = path.join(root, "source.woma-env");
    const legacyBundle = path.join(root, "legacy.woma-env");
    process.env.WOMA_HOME = path.join(root, "source-home");
    await createEnvironment(root, "source", ["codex", "claude"]);
    await installIntoEnvironment(root, "source", source);
    await installIntoEnvironment(root, "source", "builtin:woma-package-builder");
    await installIntoEnvironment(root, "source", memory);
    await exportEnvironmentBundle(root, "source", bundle);
    await writeFile(
      legacyBundle,
      rewriteBundle(await readFile(bundle), (document) => {
        document.environment.apiVersion = "woma.dev/environment-v1";
        const memoryRoot = document.environment.spec.roots.find((item: any) => item.name === "woma-project-memory");
        memoryRoot.source = "builtin:woma-project-memory";
        document.lock.packages["woma-project-memory"].source = "builtin:woma-project-memory";
      }),
    );

    const destinationHome = path.join(root, "destination-home");
    process.env.WOMA_HOME = destinationHome;
    const imported = await importEnvironmentBundle(root, legacyBundle, "restored");

    assert.equal(imported.packages, 1);
    assert.equal(imported.snapshot.environment.apiVersion, "woma.dev/environment-v2");
    assert.deepEqual(imported.snapshot.environment.spec.roots.map((item) => item.name), ["local-performance"]);
    assert.deepEqual(Object.keys(imported.snapshot.lock.packages), ["local-performance"]);
    await assert.rejects(access(path.join(destinationHome, "packages", "woma-project-memory")), /ENOENT/);
    await assert.rejects(access(path.join(destinationHome, "packages", "woma-package-builder")), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previousHome;
    await removeTestTree(root);
  }
});

test("Environment bundle import supports rename and refuses destructive conflicts", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-name-"));
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const source = await portablePackage(root);
    const bundle = path.join(root, "environment.woma-env");
    await createEnvironment(root, "source", ["codex"]);
    await installIntoEnvironment(root, "source", source);
    await exportEnvironmentBundle(root, "source", bundle);
    await importEnvironmentBundle(root, bundle, "restored");
    const before = await readFile(environmentPath(root, "restored"));
    await assert.rejects(importEnvironmentBundle(root, bundle, "restored"), /Environment already exists/);
    assert.deepEqual(await readFile(environmentPath(root, "restored")), before);
    await assert.rejects(importEnvironmentBundle(root, bundle, "base"), /base environment.*cannot be imported/i);
  } finally {
    await removeTestTree(root);
  }
});

test("Environment bundle rejects unsafe paths and tampered Package bytes without publishing an Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-tamper-"));
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const source = await portablePackage(root);
    const bundle = path.join(root, "environment.woma-env");
    await createEnvironment(root, "source", ["codex"]);
    await installIntoEnvironment(root, "source", source);
    await exportEnvironmentBundle(root, "source", bundle);
    const original = await readFile(bundle);

    const traversal = path.join(root, "traversal.woma-env");
    await writeFile(
      traversal,
      rewriteBundle(original, (document) => {
        document.packages[0].files[0].path = "../escape";
      }),
    );
    await assert.rejects(importEnvironmentBundle(root, traversal, "unsafe"), /unsafe Package path/);
    await assert.rejects(readFile(environmentPath(root, "unsafe")), /ENOENT/);
    await assert.rejects(readFile(path.join(root, "escape")), /ENOENT/);

    const windowsTraversal = path.join(root, "windows-traversal.woma-env");
    await writeFile(
      windowsTraversal,
      rewriteBundle(original, (document) => {
        document.packages[0].files[0].path = "..\\escape";
      }),
    );
    await assert.rejects(importEnvironmentBundle(root, windowsTraversal, "windows-unsafe"), /unsafe Package path/);
    await assert.rejects(readFile(environmentPath(root, "windows-unsafe")), /ENOENT/);

    const legacyState = path.join(root, "legacy-state.woma-env");
    await writeFile(
      legacyState,
      rewriteBundle(original, (document) => {
        document.packages[0].files[0].path = ".harness/local/memory.md";
      }),
    );
    await assert.rejects(importEnvironmentBundle(root, legacyState, "legacy-state"), /excluded Package path/);
    await assert.rejects(readFile(environmentPath(root, "legacy-state")), /ENOENT/);

    const corrupted = path.join(root, "corrupted.woma-env");
    await writeFile(
      corrupted,
      rewriteBundle(original, (document) => {
        const target = document.packages.find((pkg: any) => pkg.name === "local-performance").files.find((file: any) => file.path.endsWith("SKILL.md"));
        target.data = Buffer.from("tampered").toString("base64");
      }),
    );
    await assert.rejects(importEnvironmentBundle(root, corrupted, "corrupted"), /integrity mismatch/i);
    await assert.rejects(readFile(environmentPath(root, "corrupted")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("Environment bundle export rejects Package symlinks", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-symlink-"));
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const source = await portablePackage(root);
    await write(path.join(root, "outside.txt"), "outside\n");
    await symlink(path.join(root, "outside.txt"), path.join(source, "package-link"));
    await createEnvironment(root, "source", ["codex"]);
    await installIntoEnvironment(root, "source", source);
    await assert.rejects(
      exportEnvironmentBundle(root, "source", path.join(root, "environment.woma-env")),
      /does not support symbolic links/,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("Environment bundle validates the complete dependency graph before publication", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bundle-rollback-"));
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    const source = await portablePackage(root);
    const bundle = path.join(root, "environment.woma-env");
    await createEnvironment(root, "source", ["codex"]);
    await installIntoEnvironment(root, "source", source);
    await exportEnvironmentBundle(root, "source", bundle);
    const invalid = path.join(root, "invalid-platform.woma-env");
    await writeFile(
      invalid,
      rewriteBundle(await readFile(bundle), (document) => {
        document.environment.spec.roots.find((item: any) => item.name === "local-performance").source = "file:/different-source";
      }),
    );
    await assert.rejects(importEnvironmentBundle(root, invalid, "rollback"), /does not match lock source/);
    await assert.rejects(readFile(environmentPath(root, "rollback")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});
