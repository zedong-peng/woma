import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { createEnvironment, doctorEnvironment, installIntoEnvironment, syncEnvironment } from "../src/environment.js";
import { environmentAgentHomePath, environmentViewPath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function packageFixture(root: string, version: string, withMcp: boolean): Promise<string> {
  const packageRoot = path.join(root, "view-package");
  const mcp = withMcp
    ? `  mcpServers:
    - name: view-server
      transport: stdio
      command: node
      args: [server.mjs]
`
    : "";
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: view-package
  version: ${version}
  description: Stable Agent home fixture.
spec:
  platforms: [codex, claude]
  skills:
    - name: view-skill
      path: ./skills/view-skill
${mcp}  hooks:
    - event: PostToolUse
      matcher: Edit
      command: git diff --check
`,
  );
  await write(
    path.join(packageRoot, "skills", "view-skill", "SKILL.md"),
    "---\nname: view-skill\ndescription: Stable home fixture.\n---\n\nUse the fixture.\n",
  );
  return packageRoot;
}

test("stable Agent homes isolate opaque state from atomic managed views", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stable-home-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    harnessEnvironment: process.env.HARNESS_ENV,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "harness-home");
  const originalCodex = path.join(root, "original-codex");
  const originalClaude = path.join(root, "user", ".claude");
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_ENV = "tools";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = originalCodex;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
  try {
    await write(path.join(originalCodex, "config.toml"), 'model = "gpt-test"\n');
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"first"}\n');
    await write(path.join(originalCodex, "hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"true"}]}]}}\n');
    await write(path.join(originalClaude, ".credentials.json"), '{"oauth":"first"}\n');
    await write(path.join(originalClaude, "settings.json"), '{"permissions":{"allow":["Read"]}}\n');
    await write(
      path.join(path.dirname(originalClaude), ".claude.json"),
      '{"runtimeMarker":"original","mcpServers":{"existing":{"type":"stdio","command":"keep","args":[],"env":{}}}}\n',
    );

    await createEnvironment(root, "tools", ["codex", "claude"]);
    await createEnvironment(root, "isolated", ["codex", "claude"]);
    const packageRoot = await packageFixture(root, "1.0.0", true);
    await installIntoEnvironment(root, "tools", packageRoot);

    const toolsView = environmentViewPath("tools");
    const firstGeneration = await readlink(toolsView);
    const codexHome = environmentAgentHomePath("tools", "codex");
    const claudeHome = environmentAgentHomePath("tools", "claude");
    assert.equal((await lstat(codexHome)).isDirectory(), true);
    assert.equal((await lstat(claudeHome)).isDirectory(), true);
    assert.equal(await realpath(path.join(codexHome, "auth.json")), path.join(originalCodex, "auth.json"));
    assert.equal(await realpath(path.join(claudeHome, ".credentials.json")), path.join(originalClaude, ".credentials.json"));
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"latest"}\n');
    assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), '{"api_key":"latest"}\n');
    for (const [platform, names] of [
      ["codex", ["config.toml", "hooks.json", "skills"]],
      ["claude", ["settings.json", "skills"]],
    ] as const) {
      for (const name of names) {
        const link = path.join(environmentAgentHomePath("tools", platform), name);
        assert.equal((await lstat(link)).isSymbolicLink(), true);
        assert.equal(
          path.resolve(path.dirname(link), await readlink(link)),
          path.join(environmentViewPath("tools"), platform, name),
        );
      }
    }

    const codexConfig = parseToml(await readFile(path.join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(codexConfig.model, "gpt-test");
    assert.equal(codexConfig.mcp_servers["view-server"].command, "node");
    assert.match(await readFile(path.join(codexHome, "skills", "view-skill", "SKILL.md"), "utf8"), /Stable home fixture/);
    assert.equal(
      await realpath(path.join(codexHome, "skills", ".system")),
      path.join(home, "environments", "tools", "home", "codex-system-skills"),
    );

    const claudeStatePath = path.join(claudeHome, ".claude.json");
    const claudeState = JSON.parse(await readFile(claudeStatePath, "utf8")) as Record<string, any>;
    assert.equal(claudeState.runtimeMarker, "original");
    assert.equal(claudeState.mcpServers.existing.command, "keep");
    assert.equal(claudeState.mcpServers["view-server"].command, "node");

    const sqlite = Buffer.from("SQLite format 3\0opaque-main", "binary");
    const wal = Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 1, 2, 3]);
    const shm = Buffer.from([0x18, 0xe2, 0x2d, 0, 9, 8, 7, 6]);
    const unknown = Buffer.from([0, 255, 128, 64, 32]);
    await write(path.join(codexHome, "goals_1.sqlite"), sqlite);
    await write(path.join(codexHome, "goals_1.sqlite-wal"), wal);
    await write(path.join(codexHome, "goals_1.sqlite-shm"), shm);
    await write(path.join(codexHome, "future-runtime.bin"), unknown);
    await write(path.join(claudeHome, "future-state.bin"), unknown);
    const unreadable = path.join(codexHome, "future-private-state.bin");
    await write(unreadable, unknown);
    await chmod(unreadable, 0o000);
    const sqliteInodes = await Promise.all(
      ["goals_1.sqlite", "goals_1.sqlite-wal", "goals_1.sqlite-shm"].map(async (name) => (await stat(path.join(codexHome, name))).ino),
    );

    await packageFixture(root, "2.0.0", false);
    await installIntoEnvironment(root, "tools", packageRoot);
    assert.notEqual(await readlink(toolsView), firstGeneration);
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite")), sqlite);
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite-wal")), wal);
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite-shm")), shm);
    assert.deepEqual(
      await Promise.all(
        ["goals_1.sqlite", "goals_1.sqlite-wal", "goals_1.sqlite-shm"].map(async (name) => (await stat(path.join(codexHome, name))).ino),
      ),
      sqliteInodes,
    );
    assert.deepEqual(await readFile(path.join(codexHome, "future-runtime.bin")), unknown);
    assert.deepEqual(await readFile(path.join(claudeHome, "future-state.bin")), unknown);
    await assert.rejects(readFile(path.join(toolsView, "codex", "goals_1.sqlite")), /ENOENT/);
    await assert.rejects(readFile(path.join(environmentAgentHomePath("isolated", "codex"), "goals_1.sqlite")), /ENOENT/);
    assert.notEqual(
      await realpath(path.join(environmentViewPath("isolated"), "codex", "skills", ".system")),
      await realpath(path.join(toolsView, "codex", "skills", ".system")),
    );

    const updatedClaude = JSON.parse(await readFile(claudeStatePath, "utf8")) as Record<string, any>;
    assert.equal(updatedClaude.runtimeMarker, "original");
    assert.equal(updatedClaude.mcpServers.existing.command, "keep");
    assert.equal(updatedClaude.mcpServers["view-server"], undefined);

    await syncEnvironment(root, "tools");
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite")), sqlite);
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite-wal")), wal);
    assert.deepEqual(await readFile(path.join(codexHome, "goals_1.sqlite-shm")), shm);
    assert.deepEqual(
      await Promise.all(
        ["goals_1.sqlite", "goals_1.sqlite-wal", "goals_1.sqlite-shm"].map(async (name) => (await stat(path.join(codexHome, name))).ino),
      ),
      sqliteInodes,
    );
    await chmod(unreadable, 0o600);
    assert.deepEqual(await readFile(unreadable), unknown);
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.harnessEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previous.harnessEnvironment;
    if (previous.codexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codexHome;
    if (previous.claudeHome === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claudeHome;
    await removeTestTree(root);
  }
});

test("failed publication rolls stable Agent home metadata back without touching opaque state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stable-home-rollback-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousClaude = process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  try {
    await createEnvironment(root, "tools", ["codex", "claude"]);
    const packageRoot = await packageFixture(root, "1.0.0", false);
    await installIntoEnvironment(root, "tools", packageRoot);
    const home = environmentAgentHomePath("tools", "codex");
    const state = Buffer.from([1, 3, 3, 7, 0, 255]);
    await write(path.join(home, "opaque.db"), state);
    const claudeStatePath = path.join(environmentAgentHomePath("tools", "claude"), ".claude.json");
    const beforeClaude = await readFile(claudeStatePath);
    const beforeView = await readlink(environmentViewPath("tools"));

    await packageFixture(root, "2.0.0", true);
    await assert.rejects(
      installIntoEnvironment(root, "tools", packageRoot, process.cwd(), {
        onMetadataPrepared: () => {
          throw new Error("injected publication failure");
        },
      }),
      /injected publication failure/,
    );
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
    assert.deepEqual(await readFile(claudeStatePath), beforeClaude);
    assert.deepEqual(await readFile(path.join(home, "opaque.db")), state);
  } finally {
    if (previousClaude === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previousClaude;
    await removeTestTree(root);
  }
});

test("doctor rejects managed home drift but ignores opaque Agent files", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stable-home-doctor-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    const home = environmentAgentHomePath("tools", "codex");
    await write(path.join(home, "unrecognized.sqlite"), Buffer.from([11, 22, 33]));
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");

    await rm(path.join(home, "config.toml"), { force: true });
    await writeFile(path.join(home, "config.toml"), "not a link\n");
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "fail");
  } finally {
    await removeTestTree(root);
  }
});
