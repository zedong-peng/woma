import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { createEnvironment, doctorEnvironment, ensureBaseEnvironment, installIntoEnvironment, syncEnvironment } from "../src/environment.js";
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

test("base adopts original Agent sessions once without overwriting stable state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-base-state-import-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "harness-home");
  const originalCodex = path.join(root, "user", ".codex");
  const originalClaude = path.join(root, "user", ".claude");
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_ORIGINAL_CODEX_HOME = originalCodex;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
  try {
    await write(path.join(originalCodex, "sessions", "2026", "old-session.jsonl"), "original codex session\n");
    await write(path.join(originalCodex, "history.jsonl"), "original history\n");
    await write(path.join(originalCodex, "config.toml"), 'model = "original"\n');
    await symlink("sessions", path.join(originalCodex, "session-alias"));
    const outside = path.join(root, "outside-session.jsonl");
    await write(outside, "outside\n");
    await symlink(outside, path.join(originalCodex, "outside-session"));
    await write(path.join(originalClaude, "projects", "project", "old-session.jsonl"), "original claude session\n");
    await write(path.join(originalClaude, "settings.json"), '{"permissions":{"allow":["Read"]}}\n');

    await ensureBaseEnvironment(root);
    const codexHome = environmentAgentHomePath("base", "codex");
    const claudeHome = environmentAgentHomePath("base", "claude");
    assert.equal(await readFile(path.join(codexHome, "sessions", "2026", "old-session.jsonl"), "utf8"), "original codex session\n");
    assert.equal(await readFile(path.join(codexHome, "history.jsonl"), "utf8"), "original history\n");
    assert.equal(await readFile(path.join(claudeHome, "projects", "project", "old-session.jsonl"), "utf8"), "original claude session\n");
    assert.equal((await lstat(path.join(codexHome, "sessions"))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(codexHome, "history.jsonl"))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(claudeHome, "projects"))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(codexHome, "session-alias"))).isSymbolicLink(), true);
    assert.equal(await readlink(path.join(codexHome, "session-alias")), path.join(originalCodex, "session-alias"));
    assert.equal((await lstat(path.join(codexHome, "outside-session"))).isSymbolicLink(), true);
    assert.equal(await readlink(path.join(codexHome, "outside-session")), path.join(originalCodex, "outside-session"));
    assert.equal(await readlink(path.join(originalCodex, "outside-session")), outside);
    assert.equal((await lstat(path.join(codexHome, "config.toml"))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(originalCodex, "history.jsonl"), "utf8"), "original history\n");

    await write(path.join(originalCodex, "sessions", "2026", "late-session.jsonl"), "late original session\n");
    await write(path.join(originalCodex, "late-top-level.bin"), "late top-level state\n");
    await syncEnvironment(root, "base");
    assert.equal(await readFile(path.join(codexHome, "sessions", "2026", "late-session.jsonl"), "utf8"), "late original session\n");
    await assert.rejects(readFile(path.join(codexHome, "late-top-level.bin")), /ENOENT/);

    await rm(path.join(codexHome, "history.jsonl"));
    await write(path.join(codexHome, "history.jsonl"), "stable history\n");
    await rm(path.join(codexHome, ".harness-original-state-adopted"));
    await rm(path.join(claudeHome, ".harness-original-state-adopted"));
    await ensureBaseEnvironment(root);
    assert.equal(await readFile(path.join(codexHome, "history.jsonl"), "utf8"), "stable history\n");
    assert.equal(await readFile(path.join(codexHome, "late-top-level.bin"), "utf8"), "late top-level state\n");

    await createEnvironment(root, "isolated", ["codex", "claude"]);
    await assert.rejects(readFile(path.join(environmentAgentHomePath("isolated", "codex"), "history.jsonl")), /ENOENT/);
    await assert.rejects(
      readFile(path.join(environmentAgentHomePath("isolated", "claude"), "projects", "project", "old-session.jsonl")),
      /ENOENT/,
    );
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.codexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codexHome;
    if (previous.claudeHome === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claudeHome;
    await removeTestTree(root);
  }
});

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
    await write(
      path.join(originalClaude, "settings.json"),
      '{"env":{"ANTHROPIC_BASE_URL":"https://first.invalid","ANTHROPIC_AUTH_TOKEN":"first"},"permissions":{"allow":["Read"]}}\n',
    );
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
    assert.equal(
      await realpath(path.join(codexHome, "auth.json")),
      await realpath(path.join(toolsView, "codex", "auth.json")),
    );
    assert.equal(
      await realpath(path.join(claudeHome, ".credentials.json")),
      await realpath(path.join(toolsView, "claude", ".credentials.json")),
    );
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"latest"}\n');
    await write(path.join(originalClaude, ".credentials.json"), '{"oauth":"latest"}\n');
    assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), '{"api_key":"first"}\n');
    assert.equal(await readFile(path.join(claudeHome, ".credentials.json"), "utf8"), '{"oauth":"first"}\n');
    await writeFile(path.join(codexHome, "auth.json"), '{"api_key":"environment"}\n');
    await writeFile(path.join(claudeHome, ".credentials.json"), '{"oauth":"environment"}\n');
    for (const [platform, names] of [
      ["codex", ["auth.json", "config.toml", "hooks.json", "skills"]],
      ["claude", [".credentials.json", "settings.json", "skills"]],
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
    await writeFile(
      path.join(codexHome, "config.toml"),
      `model_provider = "custom"\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://example.invalid/v1"\n\n${await readFile(path.join(codexHome, "config.toml"), "utf8")}`,
    );
    const claudeSettingsPath = path.join(claudeHome, "settings.json");
    const claudeSettings = JSON.parse(await readFile(claudeSettingsPath, "utf8")) as Record<string, any>;
    assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, "https://first.invalid");
    await write(
      path.join(originalClaude, "settings.json"),
      '{"env":{"ANTHROPIC_BASE_URL":"https://latest.invalid","ANTHROPIC_AUTH_TOKEN":"latest"}}\n',
    );
    assert.equal(
      JSON.parse(await readFile(claudeSettingsPath, "utf8")).env.ANTHROPIC_BASE_URL,
      "https://first.invalid",
    );
    claudeSettings.env = {
      ANTHROPIC_BASE_URL: "https://environment.invalid",
      ANTHROPIC_AUTH_TOKEN: "environment",
    };
    await writeFile(claudeSettingsPath, `${JSON.stringify(claudeSettings, null, 2)}\n`);
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
    assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), '{"api_key":"environment"}\n');
    assert.equal(await readFile(path.join(claudeHome, ".credentials.json"), "utf8"), '{"oauth":"environment"}\n');
    const updatedCodexConfig = parseToml(await readFile(path.join(codexHome, "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(updatedCodexConfig.model_provider, "custom");
    assert.equal(updatedCodexConfig.model_providers.custom.base_url, "https://example.invalid/v1");
    assert.equal(updatedCodexConfig.mcp_servers?.["view-server"], undefined);
    const updatedClaudeSettings = JSON.parse(await readFile(claudeSettingsPath, "utf8")) as Record<string, any>;
    assert.equal(updatedClaudeSettings.env.ANTHROPIC_BASE_URL, "https://environment.invalid");
    assert.equal(updatedClaudeSettings.env.ANTHROPIC_AUTH_TOKEN, "environment");
    assert.equal(updatedClaudeSettings.hooks.PostToolUse[0].hooks[0].command, "git diff --check");
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

test("shared credential links migrate into Environment views", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-credential-link-migration-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const previousCodex = process.env.HARNESS_ORIGINAL_CODEX_HOME;
  const previousClaude = process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
  const originalCodex = path.join(root, "original-codex");
  const originalClaude = path.join(root, "original-claude");
  process.env.HARNESS_ORIGINAL_CODEX_HOME = originalCodex;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
  try {
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"legacy"}\n');
    await write(path.join(originalClaude, ".credentials.json"), '{"oauth":"legacy"}\n');
    await createEnvironment(root, "tools", ["codex", "claude"]);

    const codexCredential = path.join(environmentAgentHomePath("tools", "codex"), "auth.json");
    const claudeCredential = path.join(environmentAgentHomePath("tools", "claude"), ".credentials.json");
    await rm(codexCredential, { force: true });
    await rm(claudeCredential, { force: true });
    await symlink(path.join(originalCodex, "auth.json"), codexCredential);
    await symlink(path.join(originalClaude, ".credentials.json"), claudeCredential);

    await syncEnvironment(root, "tools");

    assert.equal(
      path.resolve(path.dirname(codexCredential), await readlink(codexCredential)),
      path.join(environmentViewPath("tools"), "codex", "auth.json"),
    );
    assert.equal(
      path.resolve(path.dirname(claudeCredential), await readlink(claudeCredential)),
      path.join(environmentViewPath("tools"), "claude", ".credentials.json"),
    );
    assert.equal(await readFile(codexCredential, "utf8"), '{"api_key":"legacy"}\n');
    assert.equal(await readFile(claudeCredential, "utf8"), '{"oauth":"legacy"}\n');
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"original-updated"}\n');
    await write(path.join(originalClaude, ".credentials.json"), '{"oauth":"original-updated"}\n');
    assert.equal(await readFile(codexCredential, "utf8"), '{"api_key":"legacy"}\n');
    assert.equal(await readFile(claudeCredential, "utf8"), '{"oauth":"legacy"}\n');
  } finally {
    if (previousCodex === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previousCodex;
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
