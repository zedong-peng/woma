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
    await assert.rejects(access(path.join(codexHome, "auth.json")), /ENOENT/);
    await assert.rejects(access(path.join(toolsView, "codex", "auth.json")), /ENOENT/);
    assert.equal((await lstat(path.join(claudeHome, ".credentials.json"))).isSymbolicLink(), false);
    await assert.rejects(access(path.join(toolsView, "claude", ".credentials.json")), /ENOENT/);
    await write(path.join(originalCodex, "auth.json"), '{"api_key":"latest"}\n');
    await write(path.join(originalClaude, ".credentials.json"), '{"oauth":"latest"}\n');
    await assert.rejects(access(path.join(codexHome, "auth.json")), /ENOENT/);
    assert.equal(await readFile(path.join(claudeHome, ".credentials.json"), "utf8"), '{"oauth":"first"}\n');
    await writeFile(path.join(codexHome, "auth.json"), '{"api_key":"environment"}\n');
    const codexAuthInode = (await stat(path.join(codexHome, "auth.json"))).ino;
    await writeFile(path.join(claudeHome, ".credentials.json"), '{"oauth":"environment"}\n');
    for (const [platform, names] of [
      ["codex", ["config.toml", "hooks.json"]],
      ["claude", [".credentials.json", "settings.json"]],
    ] as const) {
      for (const name of names) {
        const link = path.join(environmentAgentHomePath("tools", platform), name);
        assert.equal((await lstat(link)).isSymbolicLink(), false);
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
    assert.equal((await lstat(path.join(codexHome, "auth.json"))).isSymbolicLink(), false);
    assert.equal((await stat(path.join(codexHome, "auth.json"))).ino, codexAuthInode);
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

test("view metadata rejects version fields", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-view-version-field-"));
  process.env.WOMA_HOME = path.join(root, "home");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    const metadataPath = path.join(environmentViewPath("tools"), "view.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.viewVersion = 2;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    await assert.rejects(activateEnvironment(root, "tools"), /unexpected fields.*viewVersion/);
    await assert.rejects(
      installIntoEnvironment(root, "tools", "builtin:woma-package-builder"),
      /unexpected fields.*viewVersion/,
    );
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).viewVersion, 2);
  } finally {
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
    opencodeHome: process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "tools";
  process.env.WOMA_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR = path.join(root, "original-pi");
  process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = path.join(root, "original-qoder");
  process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR = path.join(root, "original-opencode");
  try {
    const targets = ["codex", "claude", "pi", "qoder", "opencode"] as const;
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
    if (previous.opencodeHome === undefined) delete process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR = previous.opencodeHome;
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
    assert.equal((await lstat(settingsLink)).isSymbolicLink(), false);

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
    assert.deepEqual((await readdir(path.join(view, "qoder"))).sort(), ["skills"]);
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

    updated.mcpServers["view-server"].command = "agent-modified";
    await write(settingsLink, `${JSON.stringify(updated, null, 2)}\n`);
    await assert.rejects(
      installIntoEnvironment(root, "qoder-tools", "builtin:woma-package-builder"),
      /Refusing to overwrite Qoder MCP server view-server/,
    );
    const preserved = JSON.parse(await readFile(settingsLink, "utf8"));
    assert.equal(preserved.mcpServers["view-server"].command, "agent-modified");
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.qoderHome === undefined) delete process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR = previous.qoderHome;
    await removeTestTree(root);
  }
});

test("OpenCode projects shared Skills and MCP into a Woma-owned config overlay", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-opencode-view-"));
  const previous = {
    womaHome: process.env.WOMA_HOME,
    womaEnvironment: process.env.WOMA_ENV,
    opencodeHome: process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR,
  };
  process.env.WOMA_HOME = path.join(root, "home");
  process.env.WOMA_ENV = "opencode-tools";
  const originalOpenCode = path.join(root, "original-opencode");
  process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR = originalOpenCode;
  try {
    const externalConfig = `{
  // OpenCode-owned native configuration remains outside the Woma overlay.
  "model": "user/model",
  "mcp": {
    "external-tools": { "type": "local", "command": ["node", "external.mjs"] },
  },
}
`;
    const externalConfigPath = path.join(originalOpenCode, "opencode.jsonc");
    await write(externalConfigPath, externalConfig);
    await createEnvironment(root, "opencode-tools", ["opencode"]);
    const home = environmentAgentHomePath("opencode-tools", "opencode");
    const view = environmentViewPath("opencode-tools");
    const configLink = path.join(home, "opencode.json");
    const skills = path.join(home, "skills");
    assert.equal((await lstat(configLink)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(configLink), await readlink(configLink)), path.join(view, "opencode", "opencode.json"));
    assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), environmentSkillsPath("opencode-tools"));

    const packageRoot = path.join(root, "opencode-package");
    await write(
      path.join(packageRoot, "woma.yaml"),
      `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: opencode-package
  version: 1.0.0
  description: OpenCode adapter fixture.
spec:
  platforms: [opencode]
  requirements:
    env:
      - name: API_TOKEN
  skills:
    - name: opencode-skill
      path: ./skills/opencode-skill
  mcpServers:
    - name: local-tools
      transport: stdio
      command: node
      args: [server.mjs]
      env: [API_TOKEN]
    - name: remote-tools
      transport: http
      url: https://example.invalid/mcp
      headers:
        Authorization: API_TOKEN
`,
    );
    await write(
      path.join(packageRoot, "skills", "opencode-skill", "SKILL.md"),
      "---\nname: opencode-skill\ndescription: OpenCode fixture.\n---\n\nUse the fixture.\n",
    );
    await write(path.join(home, "storage", "session.db"), Buffer.from([0, 7, 30, 255]));
    await installIntoEnvironment(root, "opencode-tools", packageRoot);

    assert.match(await readFile(path.join(skills, "opencode-skill", "SKILL.md"), "utf8"), /OpenCode fixture/);
    const config = JSON.parse(await readFile(configLink, "utf8"));
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.model, undefined);
    assert.deepEqual(config.mcp["local-tools"], {
      type: "local",
      command: ["node", "server.mjs"],
      enabled: true,
      environment: { API_TOKEN: "{env:API_TOKEN}" },
    });
    assert.deepEqual(config.mcp["remote-tools"], {
      type: "remote",
      url: "https://example.invalid/mcp",
      enabled: true,
      headers: { Authorization: "{env:API_TOKEN}" },
    });
    assert.equal(config.mcp["external-tools"], undefined);
    assert.equal(await readFile(externalConfigPath, "utf8"), externalConfig);
    assert.deepEqual((await environmentInfo(root)).environmentMcpServers, [
      { name: "external-tools", origin: "external", platforms: ["opencode"] },
    ]);
    assert.deepEqual(await readFile(path.join(home, "storage", "session.db")), Buffer.from([0, 7, 30, 255]));
    const metadata = JSON.parse(await readFile(path.join(view, "view.json"), "utf8"));
    assert.deepEqual(metadata.resources.opencodeMcpServers, ["local-tools", "remote-tools"]);

    const conflictingRoot = path.join(root, "opencode-conflict");
    await write(
      path.join(conflictingRoot, "woma.yaml"),
      `apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: opencode-conflict
  version: 1.0.0
  description: OpenCode external ownership conflict fixture.
spec:
  platforms: [opencode]
  mcpServers:
    - name: external-tools
      transport: stdio
      command: node
      args: [managed.mjs]
`,
    );
    const beforeConfig = await readFile(configLink);
    await assert.rejects(
      installIntoEnvironment(root, "opencode-tools", conflictingRoot),
      /OpenCode MCP server external-tools conflicts with an external native configuration/,
    );
    assert.deepEqual(await readFile(configLink), beforeConfig);
    assert.equal(await readFile(externalConfigPath, "utf8"), externalConfig);
    assert.equal((await doctorEnvironment(root, "opencode-tools")).find((check) => check.label === "view")?.status, "ok");
  } finally {
    if (previous.womaHome === undefined) delete process.env.WOMA_HOME;
    else process.env.WOMA_HOME = previous.womaHome;
    if (previous.womaEnvironment === undefined) delete process.env.WOMA_ENV;
    else process.env.WOMA_ENV = previous.womaEnvironment;
    if (previous.opencodeHome === undefined) delete process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR;
    else process.env.WOMA_ORIGINAL_OPENCODE_CONFIG_DIR = previous.opencodeHome;
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
