import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { createEnvironment, doctorEnvironment, installIntoEnvironment } from "../src/environment.js";
import { environmentViewPath, reconcileRuntimeState } from "../src/view.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("global Environment views link Skills, merge adapters, and share runtime state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-view-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "harness-home");
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "user", ".claude");
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_ORIGINAL_CODEX_HOME = codexHome;
  process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = claudeHome;
  try {
    await write(path.join(codexHome, "config.toml"), 'model = "gpt-test"\n');
    await write(path.join(codexHome, "hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"true"}]}]}}\n');
    await write(path.join(codexHome, "installation_id"), "existing-installation\n");
    await write(path.join(claudeHome, "settings.json"), '{"permissions":{"allow":["Read"]}}\n');
    await write(path.join(path.dirname(claudeHome), ".claude.json"), '{"runtimeMarker":"from-default-state","mcpServers":{"existing":{"type":"stdio","command":"keep","args":[],"env":{}}}}\n');
    await mkdir(path.join(claudeHome, "projects"), { recursive: true });

    const packageRoot = path.join(root, "package");
    await write(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: view-package
  version: 1.0.0
  description: Global view fixture.
spec:
  platforms: [codex, claude]
  requirements:
    env:
      - name: VIEW_TOKEN
        optional: false
  skills:
    - name: view-skill
      path: ./skills/view-skill
  mcpServers:
    - name: view-server
      transport: stdio
      command: node
      args: [server.mjs]
      env: [VIEW_TOKEN]
  hooks:
    - event: PostToolUse
      matcher: Edit
      command: git diff --check
`,
    );
    await write(path.join(packageRoot, "skills", "view-skill", "SKILL.md"), "---\nname: view-skill\ndescription: View fixture.\n---\n\nUse the view.\n");

    await createEnvironment(root, "tools", ["codex", "claude"]);
    await installIntoEnvironment(root, "tools", packageRoot);
    await createEnvironment(root, "isolated", ["codex", "claude"]);

    const view = environmentViewPath("tools");
    const codexSkill = path.join(view, "codex", "skills", "view-skill");
    const claudeSkill = path.join(view, "claude", "skills", "view-skill");
    assert.equal((await lstat(codexSkill)).isSymbolicLink(), true);
    assert.equal((await lstat(claudeSkill)).isSymbolicLink(), true);
    assert.match(await realpath(codexSkill), /packages\/view-package\//);
    await assert.rejects(readFile(path.join(environmentViewPath("isolated"), "codex", "skills", "view-skill", "SKILL.md")), /ENOENT/);

    const codex = parseToml(await readFile(path.join(view, "codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(codex.model, "gpt-test");
    assert.deepEqual(codex.mcp_servers["view-server"], {
      command: "node",
      args: ["server.mjs"],
      env_vars: ["VIEW_TOKEN"],
    });
    const codexHooks = JSON.parse(await readFile(path.join(view, "codex", "hooks.json"), "utf8")) as Record<string, any>;
    assert.equal(codexHooks.hooks.SessionStart[0].hooks[0].command, "true");
    assert.equal(codexHooks.hooks.PostToolUse[0].hooks[0].command, "git diff --check");
    assert.equal((await lstat(path.join(view, "codex", "installation_id"))).isSymbolicLink(), true);
    assert.equal(await realpath(path.join(view, "codex", "installation_id")), path.join(codexHome, "installation_id"));
    await write(path.join(view, "codex", "auth.json"), '{"auth":"created-after-views"}\n');
    assert.equal(
      await readFile(path.join(environmentViewPath("isolated"), "codex", "auth.json"), "utf8"),
      '{"auth":"created-after-views"}\n',
    );
    await rm(path.join(view, "codex", "auth.json"));
    await write(path.join(view, "codex", "auth.json"), '{"auth":"atomically-replaced"}\n');
    await reconcileRuntimeState("tools");
    assert.equal((await lstat(path.join(view, "codex", "auth.json"))).isSymbolicLink(), true);
    assert.equal(
      await readFile(path.join(environmentViewPath("isolated"), "codex", "auth.json"), "utf8"),
      '{"auth":"atomically-replaced"}\n',
    );
    await rm(path.join(environmentViewPath("isolated"), "codex", "auth.json"));
    await reconcileRuntimeState("isolated");
    assert.equal(
      await readFile(path.join(environmentViewPath("isolated"), "codex", "auth.json"), "utf8"),
      '{"auth":"atomically-replaced"}\n',
    );

    const claudeState = JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")) as Record<string, any>;
    assert.equal(claudeState.runtimeMarker, "from-default-state");
    assert.equal(claudeState.mcpServers.existing.command, "keep");
    assert.equal(claudeState.mcpServers["view-server"].env.VIEW_TOKEN, "${VIEW_TOKEN}");
    const claudeSettings = JSON.parse(await readFile(path.join(view, "claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(claudeSettings.permissions, { allow: ["Read"] });
    assert.equal(claudeSettings.hooks.PostToolUse[0].hooks[0].command, "git diff --check");
    assert.equal((await lstat(path.join(view, "claude", "projects"))).isSymbolicLink(), true);
    await write(path.join(view, "claude", "projects", "late-session.json"), '{"session":"shared"}\n');
    assert.equal(
      await readFile(path.join(environmentViewPath("isolated"), "claude", "projects", "late-session.json"), "utf8"),
      '{"session":"shared"}\n',
    );

    await write(path.join(view, "codex", "runtime-created.db"), "runtime state\n");
    claudeState.runtimeMarker = "preserve-me";
    await writeFile(path.join(view, "claude", ".claude.json"), `${JSON.stringify(claudeState, null, 2)}\n`, "utf8");
    await reconcileRuntimeState("tools", "isolated");
    const isolatedClaudeState = JSON.parse(
      await readFile(path.join(environmentViewPath("isolated"), "claude", ".claude.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(isolatedClaudeState.runtimeMarker, "preserve-me");
    assert.equal(isolatedClaudeState.mcpServers.existing.command, "keep");
    assert.equal(isolatedClaudeState.mcpServers["view-server"], undefined);
    await installIntoEnvironment(root, "tools", packageRoot);
    assert.equal(await readFile(path.join(view, "codex", "runtime-created.db"), "utf8"), "runtime state\n");
    assert.equal(
      JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")).runtimeMarker,
      "preserve-me",
    );
    const codexConfigPath = path.join(view, "codex", "config.toml");
    await writeFile(codexConfigPath, (await readFile(codexConfigPath, "utf8")).replace('command = "node"', 'command = "other"'), "utf8");
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "fail");
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.codexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codexHome;
    if (previous.claudeHome === undefined) delete process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claudeHome;
    await rm(root, { recursive: true, force: true });
  }
});
