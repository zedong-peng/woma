import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { createEnvironment, doctorEnvironment, installIntoEnvironment, syncEnvironment } from "../src/environment.js";
import { environmentViewPath, reconcileRuntimeState } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("global Environment views link Skills, merge adapters, and share runtime state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-view-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    harnessEnvironment: process.env.HARNESS_ENV,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "harness-home");
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "user", ".claude");
  process.env.HARNESS_HOME = home;
  process.env.HARNESS_ENV = "tools";
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
    assert.equal((await lstat(environmentViewPath("tools"))).isSymbolicLink(), true);
    const firstGeneration = await readlink(environmentViewPath("tools"));
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
    await rm(path.join(codexHome, "installation_id"));
    await rm(path.join(view, "codex", "installation_id"));
    await write(path.join(view, "codex", "installation_id"), "replacement-installation\n");
    await reconcileRuntimeState("tools");
    assert.equal(await readFile(path.join(codexHome, "installation_id"), "utf8"), "replacement-installation\n");
    assert.equal((await lstat(path.join(view, "codex", "installation_id"))).isSymbolicLink(), true);
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
    const binaryRuntime = Buffer.from([0, 255, 254, 128, 1, 2, 3, 0]);
    await writeFile(path.join(view, "codex", "runtime-binary.db"), binaryRuntime);
    claudeState.runtimeMarker = "preserve-me";
    await writeFile(path.join(view, "claude", ".claude.json"), `${JSON.stringify(claudeState, null, 2)}\n`, "utf8");
    await reconcileRuntimeState("tools", "isolated");
    const isolatedClaudeState = JSON.parse(
      await readFile(path.join(environmentViewPath("isolated"), "claude", ".claude.json"), "utf8"),
    ) as Record<string, any>;
    assert.equal(isolatedClaudeState.runtimeMarker, "preserve-me");
    assert.equal(isolatedClaudeState.mcpServers.existing.command, "keep");
    assert.equal(isolatedClaudeState.mcpServers["view-server"], undefined);
    const duringPublication = Buffer.from([222, 173, 190, 239, 0, 255]);
    await installIntoEnvironment(root, "tools", packageRoot, process.cwd(), {
      onViewPrepared: async () => {
        await writeFile(path.join(view, "codex", "written-during-publication.bin"), duringPublication);
      },
      onResourcesApplied: async () => {
        assert.equal((await lstat(environmentViewPath("tools"))).isSymbolicLink(), true);
        assert.match(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8"), /view-package/);
        assert.match(await readFile(path.join(environmentViewPath("tools"), "codex", "skills", "view-skill", "SKILL.md"), "utf8"), /View fixture/);
      },
    });
    assert.notEqual(await readlink(environmentViewPath("tools")), firstGeneration);
    assert.equal(await readFile(path.join(view, "codex", "runtime-created.db"), "utf8"), "runtime state\n");
    assert.deepEqual(await readFile(path.join(view, "codex", "runtime-binary.db")), binaryRuntime);
    assert.deepEqual(await readFile(path.join(view, "codex", "written-during-publication.bin")), duringPublication);
    assert.equal(
      JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")).runtimeMarker,
      "preserve-me",
    );
    const stateWithoutMarker = JSON.parse(
      await readFile(path.join(environmentViewPath("isolated"), "claude", ".claude.json"), "utf8"),
    ) as Record<string, unknown>;
    delete stateWithoutMarker.runtimeMarker;
    await writeFile(
      path.join(environmentViewPath("isolated"), "claude", ".claude.json"),
      `${JSON.stringify(stateWithoutMarker, null, 2)}\n`,
      "utf8",
    );
    await reconcileRuntimeState("isolated", "tools");
    assert.equal(JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")).runtimeMarker, undefined);

    await rm(path.join(view, "view.json"), { force: true });
    const driftedClaude = JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")) as Record<string, any>;
    driftedClaude.mcpServers["view-server"].command = "drifted";
    await writeFile(path.join(view, "claude", ".claude.json"), `${JSON.stringify(driftedClaude, null, 2)}\n`, "utf8");
    await syncEnvironment(root, "tools");
    assert.deepEqual(await readFile(path.join(view, "codex", "runtime-binary.db")), binaryRuntime);
    assert.equal(
      JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")).mcpServers["view-server"].command,
      "node",
    );
    const codexConfigPath = path.join(view, "codex", "config.toml");
    await writeFile(codexConfigPath, (await readFile(codexConfigPath, "utf8")).replace('command = "node"', 'command = "other"'), "utf8");
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "fail");

    await syncEnvironment(root, "tools");
    const codexHooksPath = path.join(view, "codex", "hooks.json");
    const injectedHooks = JSON.parse(await readFile(codexHooksPath, "utf8")) as Record<string, any>;
    injectedHooks.hooks.Stop = [{ hooks: [{ type: "command", command: "injected" }] }];
    await writeFile(codexHooksPath, `${JSON.stringify(injectedHooks, null, 2)}\n`, "utf8");
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "fail");
    await syncEnvironment(root, "tools");

    const claudeStatePath = path.join(view, "claude", ".claude.json");
    const injectedMcp = JSON.parse(await readFile(claudeStatePath, "utf8")) as Record<string, any>;
    injectedMcp.mcpServers.injected = { type: "stdio", command: "injected", args: [] };
    await writeFile(claudeStatePath, `${JSON.stringify(injectedMcp, null, 2)}\n`, "utf8");
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "fail");
    await syncEnvironment(root, "tools");

    const outsideRuntime = path.join(root, "outside-auth.json");
    await write(outsideRuntime, "outside\n");
    await rm(path.join(view, "codex", "auth.json"), { force: true });
    await symlink(outsideRuntime, path.join(view, "codex", "auth.json"));
    await assert.rejects(reconcileRuntimeState("tools"), /unexpected target/);
    assert.equal(await readFile(outsideRuntime, "utf8"), "outside\n");
    await rm(path.join(view, "codex", "auth.json"), { force: true });
    await reconcileRuntimeState("tools");

    await writeFile(path.join(environmentViewPath("isolated"), "codex", "inactive-only.bin"), Buffer.from([9, 8, 7]));
    await installIntoEnvironment(root, "isolated", packageRoot);
    await assert.rejects(readFile(path.join(home, "runtime", "codex", "inactive-only.bin")), /ENOENT/);
    await syncEnvironment(root, "isolated");
    await assert.rejects(readFile(path.join(home, "runtime", "codex", "inactive-only.bin")), /ENOENT/);

    await rm(path.join(view, "view.json"), { force: true });
    await write(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: view-package
  version: 2.0.0
  description: Global view fixture without MCP.
spec:
  platforms: [codex, claude]
  skills:
    - name: view-skill
      path: ./skills/view-skill
`,
    );
    await installIntoEnvironment(root, "tools", packageRoot);
    const upgradedClaude = JSON.parse(await readFile(path.join(view, "claude", ".claude.json"), "utf8")) as Record<string, any>;
    assert.equal(upgradedClaude.mcpServers["view-server"], undefined);
    assert.equal(upgradedClaude.mcpServers.existing.command, "keep");
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
