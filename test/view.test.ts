import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  activateEnvironment,
  createEnvironment,
  doctorEnvironment,
  environmentInfo,
  installIntoEnvironment,
  readEnvironment,
} from "../src/environment.js";
import { inspectEnvironmentLocalSkills } from "../src/environment-skills.js";
import { environmentAgentHomePath, environmentSkillsPath, environmentViewPath } from "../src/view.js";
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
    path.join(packageRoot, "woma.yaml"),
    `apiVersion: woma.dev/v1
kind: Woma
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

async function projectLegacySkillsLayout(environmentName: string, targets: readonly ("codex" | "claude" | "pi" | "qoder")[]): Promise<void> {
  for (const target of targets) {
    const skills = path.join(environmentAgentHomePath(environmentName, target), "skills");
    await rm(skills, { force: true });
    await symlink(path.join(environmentViewPath(environmentName), target, "skills"), skills);
  }
  await rm(environmentSkillsPath(environmentName), { recursive: true, force: true });
  const metadataPath = path.join(environmentViewPath(environmentName), "view.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.viewVersion = 1;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

test("stable Agent homes isolate opaque state from atomic managed views", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-stable-home-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  const home = path.join(root, "woma-home");
  const originalCodex = path.join(root, "original-codex");
  const originalClaude = path.join(root, "user", ".claude");
  process.env.WOMA_HOME = home;
  process.env.WOMA_ENV = "tools";
  process.env.WOMA_ORIGINAL_CODEX_HOME = originalCodex;
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
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
      ["codex", ["auth.json", "config.toml", "hooks.json"]],
      ["claude", [".credentials.json", "settings.json"]],
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
    const sharedSkills = environmentSkillsPath("tools");
    assert.equal((await lstat(sharedSkills)).isDirectory(), true);
    assert.equal((await lstat(sharedSkills)).isSymbolicLink(), false);
    const codexSkills = path.join(codexHome, "skills");
    const claudeSkills = path.join(claudeHome, "skills");
    for (const skills of [codexSkills, claudeSkills]) {
      assert.equal((await lstat(skills)).isSymbolicLink(), true);
      assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), sharedSkills);
    }
    const managedSkill = path.join(codexSkills, "view-skill");
    assert.equal((await lstat(managedSkill)).isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(managedSkill), await readlink(managedSkill)),
      path.join(toolsView, "skills", "view-skill"),
    );

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
    await write(path.join(codexHome, "skills", ".system", ".codex-system-skills.marker"), "tools\n");

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
    const isolatedSystem = path.join(environmentAgentHomePath("isolated", "codex"), "skills", ".system");
    await write(path.join(isolatedSystem, ".codex-system-skills.marker"), "isolated\n");
    assert.notEqual(await realpath(isolatedSystem), await realpath(path.join(codexHome, "skills", ".system")));
    assert.equal(await readFile(path.join(codexHome, "skills", ".system", ".codex-system-skills.marker"), "utf8"), "tools\n");
    await assert.rejects(access(path.join(toolsView, "codex", "skills", ".system")));

    const updatedClaude = JSON.parse(await readFile(claudeStatePath, "utf8")) as Record<string, any>;
    assert.equal(updatedClaude.runtimeMarker, "original");
    assert.equal(updatedClaude.mcpServers.existing.command, "keep");
    assert.equal(updatedClaude.mcpServers["view-server"], undefined);

    await installIntoEnvironment(root, "tools", "builtin:woma-package-builder");
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

test("Codex can replace legacy projected system Skills without invalidating the Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-codex-system-skills-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "tools";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    const packageRoot = await packageFixture(root, "1.0.0", false);
    await installIntoEnvironment(root, "tools", packageRoot);

    const codexHome = environmentAgentHomePath("tools", "codex");
    const homeSkills = path.join(codexHome, "skills");
    const sharedSkills = environmentSkillsPath("tools");
    const viewSkills = path.join(environmentViewPath("tools"), "codex", "skills");
    await rm(homeSkills, { force: true });
    await rm(sharedSkills, { recursive: true, force: true });
    await symlink(viewSkills, homeSkills);
    await write(path.join(viewSkills, ".system", ".codex-system-skills.marker"), "runtime-v1\n");
    await write(path.join(viewSkills, ".system", "skill-installer", "SKILL.md"), "Codex runtime Skill\n");
    const metadataPath = path.join(environmentViewPath("tools"), "view.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.viewVersion = 1;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");

    const additionalSkill = path.join(root, "additional-skill");
    await write(
      path.join(additionalSkill, "SKILL.md"),
      "---\nname: additional-skill\ndescription: Added after Codex runtime state.\n---\n\nUse the additional Skill.\n",
    );
    const legacyView = await readlink(environmentViewPath("tools"));
    await assert.rejects(
      installIntoEnvironment(root, "tools", additionalSkill, process.cwd(), {
        onMetadataPrepared: () => {
          throw new Error("injected legacy migration failure");
        },
      }),
      /injected legacy migration failure/,
    );
    assert.equal((await lstat(homeSkills)).isSymbolicLink(), true);
    assert.equal(await readlink(environmentViewPath("tools")), legacyView);
    assert.equal(await readFile(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime-v1\n");

    await installIntoEnvironment(root, "tools", additionalSkill);

    assert.equal((await lstat(sharedSkills)).isDirectory(), true);
    assert.equal((await lstat(sharedSkills)).isSymbolicLink(), false);
    assert.equal((await lstat(homeSkills)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(homeSkills), await readlink(homeSkills)), sharedSkills);
    assert.equal(await readFile(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime-v1\n");
    assert.match(await readFile(path.join(homeSkills, ".system", "skill-installer", "SKILL.md"), "utf8"), /runtime Skill/);
    assert.match(await readFile(path.join(homeSkills, "additional-skill", "SKILL.md"), "utf8"), /additional Skill/);
    assert.equal((await readdir(path.join(environmentViewPath("tools"), "codex", "skills"))).includes(".system"), false);

    await rm(path.join(homeSkills, ".system"), { recursive: true, force: true });
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
    await write(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "runtime-v2\n");
    await write(path.join(homeSkills, "future-codex-runtime", "state.bin"), Buffer.from([0, 255, 39]));
    await installIntoEnvironment(root, "tools", "builtin:woma-package-builder");
    assert.equal(await readFile(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime-v2\n");
    assert.deepEqual(await readFile(path.join(homeSkills, "future-codex-runtime", "state.bin")), Buffer.from([0, 255, 39]));
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");

    const managedSkill = path.join(homeSkills, "woma-package-builder");
    await rm(managedSkill, { force: true });
    await mkdir(managedSkill);
    const drifted = (await doctorEnvironment(root, "tools")).find((check) => check.label === "view");
    assert.equal(drifted?.status, "fail");
    assert.match(drifted?.detail ?? "", /Woma-managed shared Skill link/);
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.womaEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previous.womaEnvironment;
    if (previous.codexHome === undefined) delete process.env.WOMA_ORIGINAL_CODEX_HOME;
    else process.env.WOMA_ORIGINAL_CODEX_HOME = previous.codexHome;
    await removeTestTree(root);
  }
});

test("activating a legacy Environment merges Agent-installed Skills into the shared root", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-legacy-shared-skills-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "base";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  try {
    const targets = ["codex", "claude"] as const;
    await createEnvironment(root, "tools", [...targets]);
    await projectLegacySkillsLayout("tools", targets);
    await write(
      path.join(environmentAgentHomePath("tools", "codex"), "skills", "codex-local", "SKILL.md"),
      "---\nname: codex-local\ndescription: Installed by legacy Codex.\n---\nCodex.\n",
    );
    await write(
      path.join(environmentAgentHomePath("tools", "claude"), "skills", "claude-local", "SKILL.md"),
      "---\nname: claude-local\ndescription: Installed by legacy Claude.\n---\nClaude.\n",
    );
    await write(
      path.join(environmentAgentHomePath("tools", "codex"), "skills", ".system", "marker"),
      "codex-system-state\n",
    );

    await activateEnvironment(root, "tools");

    const shared = environmentSkillsPath("tools");
    assert.equal((await lstat(shared)).isDirectory(), true);
    for (const target of targets) {
      const skills = path.join(environmentAgentHomePath("tools", target), "skills");
      assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), shared);
      assert.match(await readFile(path.join(skills, "codex-local", "SKILL.md"), "utf8"), /legacy Codex/);
      assert.match(await readFile(path.join(skills, "claude-local", "SKILL.md"), "utf8"), /legacy Claude/);
    }
    assert.equal(await readFile(path.join(shared, ".system", "marker"), "utf8"), "codex-system-state\n");
    assert.equal(JSON.parse(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8")).viewVersion, 2);
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
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

test("legacy same-name Agent Skills fail without moving either source", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-legacy-shared-skills-conflict-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "base";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  try {
    const targets = ["codex", "claude"] as const;
    await createEnvironment(root, "tools", [...targets]);
    await projectLegacySkillsLayout("tools", targets);
    const codexSkill = path.join(environmentAgentHomePath("tools", "codex"), "skills", "same-name", "SKILL.md");
    const claudeSkill = path.join(environmentAgentHomePath("tools", "claude"), "skills", "same-name", "SKILL.md");
    await write(codexSkill, "---\nname: same-name\ndescription: Codex copy.\n---\nCodex.\n");
    await write(claudeSkill, "---\nname: same-name\ndescription: Claude copy.\n---\nClaude.\n");
    const beforeView = await readlink(environmentViewPath("tools"));

    await assert.rejects(activateEnvironment(root, "tools"), /Skill entry same-name differs between Agent homes/);

    assert.match(await readFile(codexSkill, "utf8"), /Codex copy/);
    assert.match(await readFile(claudeSkill, "utf8"), /Claude copy/);
    await assert.rejects(access(environmentSkillsPath("tools")));
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
    assert.equal(JSON.parse(await readFile(path.join(environmentViewPath("tools"), "view.json"), "utf8")).viewVersion, 1);
    await assert.rejects(access(path.join(root, "AGENTS.md")));
    await assert.rejects(access(path.join(root, "CLAUDE.md")));

    await rm(path.dirname(codexSkill), { recursive: true });
    await rm(path.dirname(claudeSkill), { recursive: true });
    const claudeDirectory = path.join(environmentAgentHomePath("tools", "claude"), "skills", "linked-kind");
    await write(
      path.join(claudeDirectory, "SKILL.md"),
      "---\nname: linked-kind\ndescription: Real directory copy.\n---\nDirectory.\n",
    );
    const codexLink = path.join(environmentAgentHomePath("tools", "codex"), "skills", "linked-kind");
    await symlink(await realpath(claudeDirectory), codexLink);

    await assert.rejects(activateEnvironment(root, "tools"), /Skill entry linked-kind differs between Agent homes/);

    assert.equal((await lstat(codexLink)).isSymbolicLink(), true);
    assert.equal((await lstat(claudeDirectory)).isDirectory(), true);
    await assert.rejects(access(environmentSkillsPath("tools")));
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
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

test("legacy same-name equivalent Agent Skills deduplicate into the shared root", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-legacy-shared-skills-deduplicate-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "base";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  try {
    const targets = ["codex", "claude"] as const;
    await createEnvironment(root, "tools", [...targets]);
    await projectLegacySkillsLayout("tools", targets);
    const codexSkills = path.join(environmentAgentHomePath("tools", "codex"), "skills");
    const codexManagedNames = await readdir(codexSkills);
    await rm(codexSkills, { force: true });
    await mkdir(codexSkills);
    for (const name of codexManagedNames) {
      await symlink(path.join(environmentViewPath("tools"), "codex", "skills", name), path.join(codexSkills, name));
    }
    const linkedSkill = path.join(root, "linked-skill");
    await write(
      path.join(linkedSkill, "SKILL.md"),
      "---\nname: linked-same\ndescription: One Skill linked by both Agents.\n---\nLinked.\n",
    );
    const skillDocument = "---\nname: same-name\ndescription: Identical Agent copy.\n---\nSame.\n";
    for (const target of targets) {
      const targetSkills = path.join(environmentAgentHomePath("tools", target), "skills");
      const skill = path.join(targetSkills, "same-name");
      await write(path.join(skill, "SKILL.md"), skillDocument);
      await write(path.join(skill, "fixtures", "data.bin"), Buffer.from([0, 39, 255]));
      await symlink(path.relative(await realpath(targetSkills), linkedSkill), path.join(targetSkills, "linked-same"));
    }

    const beforeView = await readlink(environmentViewPath("tools"));
    const packageRoot = await packageFixture(root, "1.0.0", false);
    await assert.rejects(
      installIntoEnvironment(root, "tools", packageRoot, process.cwd(), {
        onMetadataPrepared: () => {
          throw new Error("injected duplicate merge failure");
        },
      }),
      /injected duplicate merge failure/,
    );
    assert.equal(await readlink(environmentViewPath("tools")), beforeView);
    await assert.rejects(access(environmentSkillsPath("tools")));
    assert.equal((await lstat(codexSkills)).isSymbolicLink(), false);
    for (const target of targets) {
      const restored = path.join(environmentAgentHomePath("tools", target), "skills", "same-name");
      assert.equal(await readFile(path.join(restored, "SKILL.md"), "utf8"), skillDocument);
      assert.deepEqual(await readFile(path.join(restored, "fixtures", "data.bin")), Buffer.from([0, 39, 255]));
      assert.equal(
        await realpath(path.join(environmentAgentHomePath("tools", target), "skills", "linked-same")),
        await realpath(linkedSkill),
      );
    }
    assert.equal(
      (await readdir(path.dirname(environmentSkillsPath("tools")))).some((name) => name.startsWith(".skills-merge-backup-")),
      false,
    );

    await activateEnvironment(root, "tools");

    const shared = environmentSkillsPath("tools");
    assert.equal(await readFile(path.join(shared, "same-name", "SKILL.md"), "utf8"), skillDocument);
    assert.deepEqual(await readFile(path.join(shared, "same-name", "fixtures", "data.bin")), Buffer.from([0, 39, 255]));
    const sharedEntries = await readdir(shared);
    assert.equal(sharedEntries.filter((name) => name === "same-name").length, 1);
    assert.equal(sharedEntries.filter((name) => name === "linked-same").length, 1);
    assert.equal((await lstat(path.join(shared, "same-name"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(shared, "linked-same"))).isSymbolicLink(), true);
    assert.equal(await realpath(path.join(shared, "linked-same")), await realpath(linkedSkill));
    for (const target of targets) {
      assert.equal(
        await realpath(path.join(environmentAgentHomePath("tools", target), "skills", "same-name")),
        await realpath(path.join(shared, "same-name")),
      );
    }
    assert.equal((await readdir(path.dirname(shared))).some((name) => name.startsWith(".skills-merge-backup-")), false);
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
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

test("a Skill installed by any Agent is immediately visible to every target in only that Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shared-environment-skill-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    codexHome: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claudeHome: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
    piHome: process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR,
    qoderHome: process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "tools";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR = path.join(root, "original-pi");
  process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = path.join(root, "original-qoder");
  try {
    const targets = ["codex", "claude", "pi", "qoder"] as const;
    await createEnvironment(root, "tools", [...targets]);
    await createEnvironment(root, "isolated", [...targets]);
    for (const platform of targets) {
      const skills = path.join(environmentAgentHomePath("tools", platform), "skills");
      const runtimeSkill = path.join(skills, `${platform}-installed`);
      await write(
        path.join(runtimeSkill, "SKILL.md"),
        `---\nname: ${platform}-installed\ndescription: Installed by ${platform} in its runtime window.\n---\n\nUse the runtime Skill.\n`,
      );
      await write(path.join(runtimeSkill, "data.bin"), Buffer.from([39, 0, targets.indexOf(platform)]));
    }
    const codexSkills = path.join(environmentAgentHomePath("tools", "codex"), "skills");
    await write(path.join(codexSkills, ".system", ".codex-system-skills.marker"), "system-state\n");
    await write(
      path.join(codexSkills, ".hidden-runtime", "SKILL.md"),
      "---\nname: hidden-runtime\ndescription: Hidden runtime state.\n---\nHidden.\n",
    );
    await write(path.join(codexSkills, "broken-local", "SKILL.md"), "missing frontmatter\n");
    await write(
      path.join(codexSkills, "conflicting-local", "SKILL.md"),
      "---\nname: woma-project-memory\ndescription: Ordinary external Skill with a formerly reserved name.\n---\nExternal.\n",
    );
    const lockPath = path.join(process.env.WOMA_HOME, "environments", "tools", "lock.json");
    const recipePath = path.join(process.env.WOMA_HOME, "environments", "tools", "environment.yaml");
    const beforeLock = await readFile(lockPath);
    const beforeRecipe = await readFile(recipePath);

    const inventory = await inspectEnvironmentLocalSkills(await readEnvironment(root, "tools"));
    const externalSkillNames = [...targets.map((platform) => `${platform}-installed`), "woma-project-memory"].sort();
    assert.deepEqual(inventory.skills.map((skill) => skill.name), externalSkillNames);
    assert.equal(inventory.skills.every((skill) => skill.origin === "external" && skill.platform === "environment"), true);
    assert.deepEqual(inventory.skills[0]?.platforms, targets);
    assert.deepEqual(inventory.issues.map((issue) => issue.entry), ["broken-local"]);
    const context = await environmentInfo(root);
    assert.deepEqual(context.environmentSkills.map((skill) => skill.name), externalSkillNames);
    assert.deepEqual(context.environmentSkillIssues.map((issue) => issue.entry), ["broken-local"]);

    const checks = await doctorEnvironment(root, "tools");
    for (const skillName of externalSkillNames) {
      assert.equal(checks.find((check) => check.label === `environment-skill:${skillName}`)?.status, "ok");
    }
    assert.equal(checks.find((check) => check.label === "environment-skill:broken-local")?.status, "warn");

    for (const source of targets) {
      for (const target of targets) {
        assert.deepEqual(
          await readFile(path.join(environmentAgentHomePath("tools", target), "skills", `${source}-installed`, "data.bin")),
          Buffer.from([39, 0, targets.indexOf(source)]),
        );
      }
      await assert.rejects(access(path.join(environmentAgentHomePath("isolated", "codex"), "skills", `${source}-installed`)));
    }
    assert.equal(await readFile(path.join(codexSkills, ".system", ".codex-system-skills.marker"), "utf8"), "system-state\n");
    await access(path.join(codexSkills, ".hidden-runtime", "SKILL.md"));
    assert.deepEqual(await readFile(lockPath), beforeLock);
    assert.deepEqual(await readFile(recipePath), beforeRecipe);
    assert.equal((await readEnvironment(root, "tools")).spec.roots.some((item) => item.name.endsWith("-installed")), false);
    await assert.rejects(access(path.join(process.env.WOMA_HOME, "migrations", "skills", "codex-installed")));
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
    assert.deepEqual((await inspectEnvironmentLocalSkills(await readEnvironment(root, "isolated"))).skills, []);
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.womaEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previous.womaEnvironment;
    if (previous.codexHome === undefined) delete process.env.WOMA_ORIGINAL_CODEX_HOME;
    else process.env.WOMA_ORIGINAL_CODEX_HOME = previous.codexHome;
    if (previous.claudeHome === undefined) delete process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = previous.claudeHome;
    if (previous.piHome === undefined) delete process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR;
    else process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR = previous.piHome;
    if (previous.qoderHome === undefined) delete process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = previous.qoderHome;
    await removeTestTree(root);
  }
});

test("Pi uses a stable Agent home with only Skills managed by the Environment view", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-pi-home-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    piHome: process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR = path.join(root, "original-pi");
  try {
    await createEnvironment(root, "pi-tools", ["pi"]);
    const home = environmentAgentHomePath("pi-tools", "pi");
    const view = environmentViewPath("pi-tools");
    const skills = path.join(home, "skills");
    assert.equal((await lstat(home)).isDirectory(), true);
    assert.equal((await lstat(skills)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), environmentSkillsPath("pi-tools"));

    await write(path.join(home, "settings.json"), '{"theme":"light"}\n');
    await write(path.join(home, "auth.json"), '{"openai":{"type":"api_key","key":"environment"}}\n');
    await write(path.join(home, "sessions", "project", "session.jsonl"), '{"type":"session"}\n');
    const rawSkill = path.join(root, "pi-review");
    await write(
      path.join(rawSkill, "SKILL.md"),
      "---\nname: pi-review\ndescription: Review code with Pi.\n---\n\nReview the code.\n",
    );
    await installIntoEnvironment(root, "pi-tools", rawSkill);

    assert.match(await readFile(path.join(skills, "pi-review", "SKILL.md"), "utf8"), /Review code with Pi/);
    assert.equal(await readFile(path.join(home, "settings.json"), "utf8"), '{"theme":"light"}\n');
    assert.match(await readFile(path.join(home, "auth.json"), "utf8"), /environment/);
    assert.match(await readFile(path.join(home, "sessions", "project", "session.jsonl"), "utf8"), /session/);
    assert.deepEqual((await readdir(path.join(view, "pi"))).sort(), ["skills"]);

    await installIntoEnvironment(root, "pi-tools", "builtin:woma-package-builder");
    assert.equal(await readFile(path.join(home, "settings.json"), "utf8"), '{"theme":"light"}\n');
    assert.match(await readFile(path.join(home, "sessions", "project", "session.jsonl"), "utf8"), /session/);
    assert.equal((await doctorEnvironment(root, "pi-tools")).find((check) => check.label === "view")?.status, "ok");
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.piHome === undefined) delete process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR;
    else process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR = previous.piHome;
    await removeTestTree(root);
  }
});

test("Qoder merges MCP servers and Hooks into a managed settings.json view", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-qoder-home-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    qoderHome: process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  const originalQoder = path.join(root, "original-qoder");
  process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = originalQoder;
  try {
    await write(
      path.join(originalQoder, "settings.json"),
      '{"model":{"name":"ultimate"},"mcpServers":{"existing":{"type":"stdio","command":"keep","args":[],"env":{}}}}\n',
    );
    await createEnvironment(root, "qoder-tools", ["qoder"]);
    const home = environmentAgentHomePath("qoder-tools", "qoder");
    const view = environmentViewPath("qoder-tools");
    const skills = path.join(home, "skills");
    const settingsLink = path.join(home, "settings.json");
    assert.equal((await lstat(skills)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), environmentSkillsPath("qoder-tools"));
    assert.equal((await lstat(settingsLink)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(settingsLink), await readlink(settingsLink)), path.join(view, "qoder", "settings.json"));

    const packageRoot = path.join(root, "qoder-package");
    await write(
      path.join(packageRoot, "woma.yaml"),
      `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: qoder-package
  version: 1.0.0
  description: Qoder adapter fixture.
spec:
  platforms: [qoder]
  skills:
    - name: qoder-skill
      path: ./skills/qoder-skill
  mcpServers:
    - name: view-server
      transport: stdio
      command: node
      args: [server.mjs]
  hooks:
    - event: PostToolUse
      matcher: Edit
      command: git diff --check
`,
    );
    await write(
      path.join(packageRoot, "skills", "qoder-skill", "SKILL.md"),
      "---\nname: qoder-skill\ndescription: Qoder fixture.\n---\n\nUse the fixture.\n",
    );
    await write(path.join(home, "sessions", "project", "session.jsonl"), '{"type":"session"}\n');
    await installIntoEnvironment(root, "qoder-tools", packageRoot);

    assert.match(await readFile(path.join(skills, "qoder-skill", "SKILL.md"), "utf8"), /Qoder fixture/);
    const settings = JSON.parse(await readFile(settingsLink, "utf8"));
    assert.deepEqual(settings.model, { name: "ultimate" });
    assert.equal(settings.mcpServers.existing.command, "keep");
    assert.deepEqual(settings.mcpServers["view-server"], { type: "stdio", command: "node", args: ["server.mjs"] });
    assert.deepEqual(settings.hooks.PostToolUse, [
      { matcher: "Edit", hooks: [{ type: "command", command: "git diff --check" }] },
    ]);
    assert.deepEqual((await readdir(path.join(view, "qoder"))).sort(), ["settings.json", "skills"]);
    const metadata = JSON.parse(await readFile(path.join(view, "view.json"), "utf8"));
    assert.deepEqual(metadata.resources.qoderMcpServers, ["view-server"]);

    await installIntoEnvironment(root, "qoder-tools", "builtin:woma-package-builder");
    const updated = JSON.parse(await readFile(settingsLink, "utf8"));
    assert.deepEqual(updated.mcpServers["view-server"], { type: "stdio", command: "node", args: ["server.mjs"] });
    assert.deepEqual(updated.hooks.PostToolUse, [
      { matcher: "Edit", hooks: [{ type: "command", command: "git diff --check" }] },
    ]);
    assert.match(await readFile(path.join(home, "sessions", "project", "session.jsonl"), "utf8"), /session/);
    assert.equal((await doctorEnvironment(root, "qoder-tools")).find((check) => check.label === "view")?.status, "ok");
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.qoderHome === undefined) delete process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = previous.qoderHome;
    await removeTestTree(root);
  }
});

test("failed publication rolls stable Agent home metadata back without touching opaque state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-stable-home-rollback-"));
  process.env.WOMA_HOME = path.join(root, "home");
  const previousClaude = process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
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
    if (previousClaude === undefined) delete process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = previousClaude;
    await removeTestTree(root);
  }
});

test("shared credential links migrate into Environment views", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-credential-link-migration-"));
  process.env.WOMA_HOME = path.join(root, "home");
  const previousCodex = process.env.WOMA_ORIGINAL_CODEX_HOME;
  const previousClaude = process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
  const originalCodex = path.join(root, "original-codex");
  const originalClaude = path.join(root, "original-claude");
  process.env.WOMA_ORIGINAL_CODEX_HOME = originalCodex;
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = originalClaude;
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

    await installIntoEnvironment(root, "tools", "builtin:woma-package-builder");

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
    if (previousCodex === undefined) delete process.env.WOMA_ORIGINAL_CODEX_HOME;
    else process.env.WOMA_ORIGINAL_CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = previousClaude;
    await removeTestTree(root);
  }
});

test("doctor rejects managed home drift but ignores opaque Agent files", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-stable-home-doctor-"));
  process.env.WOMA_HOME = path.join(root, "home");
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
