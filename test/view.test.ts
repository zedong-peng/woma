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
    const codexSkills = path.join(codexHome, "skills");
    assert.equal((await lstat(codexSkills)).isDirectory(), true);
    assert.equal((await lstat(codexSkills)).isSymbolicLink(), false);
    const managedSkill = path.join(codexSkills, "view-skill");
    assert.equal((await lstat(managedSkill)).isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(managedSkill), await readlink(managedSkill)),
      path.join(toolsView, "codex", "skills", "view-skill"),
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

    await installIntoEnvironment(root, "tools", "builtin:harness-project-memory");
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

test("Codex can replace legacy projected system Skills without invalidating the Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-codex-system-skills-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    harnessEnvironment: process.env.HARNESS_ENV,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
  };
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ENV = "tools";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    const packageRoot = await packageFixture(root, "1.0.0", false);
    await installIntoEnvironment(root, "tools", packageRoot);

    const codexHome = environmentAgentHomePath("tools", "codex");
    const homeSkills = path.join(codexHome, "skills");
    const viewSkills = path.join(environmentViewPath("tools"), "codex", "skills");
    const legacySystemRoot = path.join(path.dirname(codexHome), "codex-system-skills");
    await mkdir(legacySystemRoot, { recursive: true });
    await symlink(legacySystemRoot, path.join(viewSkills, ".system"));
    await rm(homeSkills, { recursive: true, force: true });
    await symlink(viewSkills, homeSkills);

    await rm(path.join(viewSkills, ".system"), { force: true });
    await write(path.join(viewSkills, ".system", ".codex-system-skills.marker"), "runtime-v1\n");
    await write(path.join(viewSkills, ".system", "skill-installer", "SKILL.md"), "Codex runtime Skill\n");

    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
    await activateEnvironment(root, "tools");

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

    assert.equal((await lstat(homeSkills)).isDirectory(), true);
    assert.equal((await lstat(homeSkills)).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime-v1\n");
    assert.match(await readFile(path.join(homeSkills, ".system", "skill-installer", "SKILL.md"), "utf8"), /runtime Skill/);
    assert.match(await readFile(path.join(homeSkills, "additional-skill", "SKILL.md"), "utf8"), /additional Skill/);
    assert.equal((await readdir(path.join(environmentViewPath("tools"), "codex", "skills"))).includes(".system"), false);

    await rm(path.join(homeSkills, ".system"), { recursive: true, force: true });
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
    await write(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "runtime-v2\n");
    await write(path.join(homeSkills, "future-codex-runtime", "state.bin"), Buffer.from([0, 255, 39]));
    await installIntoEnvironment(root, "tools", "builtin:harness-project-memory");
    assert.equal(await readFile(path.join(homeSkills, ".system", ".codex-system-skills.marker"), "utf8"), "runtime-v2\n");
    assert.deepEqual(await readFile(path.join(homeSkills, "future-codex-runtime", "state.bin")), Buffer.from([0, 255, 39]));
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");

    const managedSkill = path.join(homeSkills, "harness-project-memory");
    await rm(managedSkill, { force: true });
    await mkdir(managedSkill);
    const drifted = (await doctorEnvironment(root, "tools")).find((check) => check.label === "view");
    assert.equal(drifted?.status, "fail");
    assert.match(drifted?.detail ?? "", /Harness-managed Codex Skill link/);
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.harnessEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previous.harnessEnvironment;
    if (previous.codexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codexHome;
    await removeTestTree(root);
  }
});

test("Codex-installed ordinary Skills immediately belong to only their Environment", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-codex-environment-skill-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    harnessEnvironment: process.env.HARNESS_ENV,
    codexHome: process.env.HARNESS_ORIGINAL_CODEX_HOME,
  };
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ENV = "tools";
  process.env.HARNESS_ORIGINAL_CODEX_HOME = path.join(root, "original-codex");
  try {
    await createEnvironment(root, "tools", ["codex"]);
    await createEnvironment(root, "isolated", ["codex"]);
    const skills = path.join(environmentAgentHomePath("tools", "codex"), "skills");
    const runtimeSkill = path.join(skills, "window-installed");
    await write(
      path.join(runtimeSkill, "SKILL.md"),
      "---\nname: window-installed\ndescription: Installed by Codex in its runtime window.\n---\n\nUse the runtime Skill.\n",
    );
    await write(path.join(runtimeSkill, "data.bin"), Buffer.from([39, 0, 255]));
    await write(path.join(skills, ".system", ".codex-system-skills.marker"), "system-state\n");
    await write(
      path.join(skills, ".hidden-runtime", "SKILL.md"),
      "---\nname: hidden-runtime\ndescription: Hidden runtime state.\n---\nHidden.\n",
    );
    await write(path.join(skills, "broken-local", "SKILL.md"), "missing frontmatter\n");
    await write(
      path.join(skills, "conflicting-local", "SKILL.md"),
      "---\nname: harness-project-memory\ndescription: Conflicts with a managed Skill.\n---\nConflict.\n",
    );
    const lockPath = path.join(process.env.HARNESS_HOME, "environments", "tools", "lock.json");
    const recipePath = path.join(process.env.HARNESS_HOME, "environments", "tools", "environment.yaml");
    const beforeLock = await readFile(lockPath);
    const beforeRecipe = await readFile(recipePath);

    const inventory = await inspectEnvironmentLocalSkills(await readEnvironment(root, "tools"));
    assert.deepEqual(inventory.skills.map((skill) => ({ name: skill.name, origin: skill.origin })), [
      { name: "window-installed", origin: "external" },
    ]);
    assert.deepEqual(inventory.issues.map((issue) => issue.entry), ["broken-local", "conflicting-local"]);
    const context = await environmentInfo(root);
    assert.deepEqual(context.environmentSkills.map((skill) => skill.name), ["window-installed"]);
    assert.deepEqual(context.environmentSkillIssues.map((issue) => issue.entry), ["broken-local", "conflicting-local"]);

    const checks = await doctorEnvironment(root, "tools");
    assert.equal(checks.find((check) => check.label === "environment-skill:window-installed")?.status, "ok");
    assert.equal(checks.find((check) => check.label === "environment-skill:broken-local")?.status, "warn");
    assert.equal(checks.find((check) => check.label === "environment-skill:conflicting-local")?.status, "fail");

    assert.equal((await lstat(runtimeSkill)).isDirectory(), true);
    assert.deepEqual(await readFile(path.join(runtimeSkill, "data.bin")), Buffer.from([39, 0, 255]));
    assert.equal(await readFile(path.join(skills, ".system", ".codex-system-skills.marker"), "utf8"), "system-state\n");
    await access(path.join(skills, ".hidden-runtime", "SKILL.md"));
    await assert.rejects(access(path.join(environmentAgentHomePath("isolated", "codex"), "skills", "window-installed")));
    assert.deepEqual(await readFile(lockPath), beforeLock);
    assert.deepEqual(await readFile(recipePath), beforeRecipe);
    assert.equal((await readEnvironment(root, "tools")).spec.roots.some((item) => item.name === "window-installed"), false);
    await assert.rejects(access(path.join(process.env.HARNESS_HOME, "migrations", "skills", "window-installed")));
    assert.equal((await doctorEnvironment(root, "tools")).find((check) => check.label === "view")?.status, "ok");
    assert.deepEqual((await inspectEnvironmentLocalSkills(await readEnvironment(root, "isolated"))).skills, []);
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.harnessEnvironment === undefined) delete process.env.HARNESS_ENV;
    else process.env.HARNESS_ENV = previous.harnessEnvironment;
    if (previous.codexHome === undefined) delete process.env.HARNESS_ORIGINAL_CODEX_HOME;
    else process.env.HARNESS_ORIGINAL_CODEX_HOME = previous.codexHome;
    await removeTestTree(root);
  }
});

test("Pi uses a stable Agent home with only Skills managed by the Environment view", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-pi-home-"));
  const previous = {
    harnessHome: process.env.HARNESS_HOME,
    piHome: process.env.HARNESS_ORIGINAL_PI_CODING_AGENT_DIR,
  };
  process.env.HARNESS_HOME = path.join(root, "home");
  process.env.HARNESS_ORIGINAL_PI_CODING_AGENT_DIR = path.join(root, "original-pi");
  try {
    await createEnvironment(root, "pi-tools", ["pi"]);
    const home = environmentAgentHomePath("pi-tools", "pi");
    const view = environmentViewPath("pi-tools");
    const skills = path.join(home, "skills");
    assert.equal((await lstat(home)).isDirectory(), true);
    assert.equal((await lstat(skills)).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(skills), await readlink(skills)), path.join(view, "pi", "skills"));

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

    await installIntoEnvironment(root, "pi-tools", "builtin:harness-project-memory");
    assert.equal(await readFile(path.join(home, "settings.json"), "utf8"), '{"theme":"light"}\n');
    assert.match(await readFile(path.join(home, "sessions", "project", "session.jsonl"), "utf8"), /session/);
    assert.equal((await doctorEnvironment(root, "pi-tools")).find((check) => check.label === "view")?.status, "ok");
  } finally {
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    if (previous.piHome === undefined) delete process.env.HARNESS_ORIGINAL_PI_CODING_AGENT_DIR;
    else process.env.HARNESS_ORIGINAL_PI_CODING_AGENT_DIR = previous.piHome;
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

    await installIntoEnvironment(root, "tools", "builtin:harness-project-memory");

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
