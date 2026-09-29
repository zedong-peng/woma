import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { describeAgents } from "../src/agents.js";
import { cachePath } from "../src/content.js";
import { addMcpServer, createEnvironment, doctorEnvironment, exportEnvironment, installPackages, packEnvironment, readEnvironment, removeEnvironment, removeMcpServers, removePackages } from "../src/environment.js";
import { readNativeConfig } from "../src/native.js";
import { commandOutput } from "../src/process.js";
import { runInEnvironment } from "../src/run.js";
import { selectedEnvironment } from "../src/selection.js";
import { fixture, plugin, removeTestTree, skill } from "./helpers.js";

const toml = async (file: string) => readNativeConfig("toml", await readFile(file, "utf8"));
const json = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

test("one environment shares Skills across Claude Code and Codex, and agents can be added or removed", async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.root, "review"));
  const prefix = await createEnvironment({ name: "research" }, { agents: ["claude", "codex"], sources: [source] });
  for (const agent of ["claude", "codex"]) assert.match(await readFile(path.join(prefix, `home/${agent}/skills/review/SKILL.md`), "utf8"), /Original content/);
  const env = selectedEnvironment(prefix, await readEnvironment(prefix), { PATH: "/usr/bin" });
  assert.equal(env.CLAUDE_CONFIG_DIR, `${prefix}/home/claude`);
  assert.equal(env.CODEX_HOME, `${prefix}/home/codex`);
  const claudeOnly = await skill(path.join(f.root, "claude-only"));
  await writeFile(path.join(claudeOnly, "woma.yaml"), "harnesses:\n  claude: '>=2'\n");
  await installPackages(prefix, [claudeOnly, await plugin(path.join(f.root, "native"), "claude")]);
  assert.ok((await stat(path.join(prefix, "home/claude/skills/claude-only"))).isDirectory());
  await assert.rejects(stat(path.join(prefix, "home/codex/skills/claude-only")), { code: "ENOENT" });
  await writeFile(path.join(prefix, "home/codex/auth.json"), "{}");
  await removePackages(prefix, ["codex"], {});
  await assert.rejects(stat(path.join(prefix, "home/codex/skills/review")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(prefix, "home/codex/auth.json"), "utf8"), "{}");
  await assert.rejects(removePackages(prefix, ["claude"]), /only agent/);
  await installPackages(prefix, ["codex"], {});
  assert.ok((await stat(path.join(prefix, "home/codex/skills/review"))).isDirectory());
  assert.deepEqual((await readEnvironment(prefix)).lock.recipe.agents, ["claude", "codex"]);
  await assert.rejects(removePackages(prefix, ["claude"]), /Remove the claude plugins first: native/);
  assert.deepEqual(await doctorEnvironment(prefix), []);
});

test("MCP servers are registered natively for each agent, never store secrets, and round-trip through exports", async (t) => {
  const f = await fixture(t);
  const prefix = await createEnvironment({ name: "mcp" }, { agents: ["claude", "codex"] });
  await writeFile(path.join(prefix, "home/codex/config.toml"), '# mine\nmodel = "gpt"\n[mcp_servers.github]\ncommand = "old"\n');
  await writeFile(path.join(prefix, "home/claude/.claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { native: { type: "stdio", command: "x", args: [], env: {} } } }));
  await addMcpServer(prefix, "github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env_vars: ["GITHUB_TOKEN"], env: { LOG_LEVEL: "info" } });
  await addMcpServer(prefix, "docs", { url: "https://mcp.example.com/mcp", bearer_token_env_var: "DOCS_TOKEN", agents: ["codex"] });
  const codex = await toml(path.join(prefix, "home/codex/config.toml"));
  assert.deepEqual(codex.mcp_servers, {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { LOG_LEVEL: "info" }, env_vars: ["GITHUB_TOKEN"] },
    docs: { url: "https://mcp.example.com/mcp", bearer_token_env_var: "DOCS_TOKEN" },
  });
  assert.match(await readFile(path.join(prefix, "home/codex/config.toml"), "utf8"), /# mine\nmodel = "gpt"/);
  const claude = await json(path.join(prefix, "home/claude/.claude.json"));
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(claude.mcpServers, { native: { type: "stdio", command: "x", args: [], env: {} }, github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { LOG_LEVEL: "info" } } });
  assert.deepEqual(await doctorEnvironment(prefix), []);
  const exported = parseYaml((await exportEnvironment(prefix)).content);
  assert.deepEqual(Object.keys(exported.mcp_servers), ["github", "docs"]);
  const file = path.join(f.root, "environment.yaml"); await writeFile(file, (await exportEnvironment(prefix)).content);
  const clone = await createEnvironment({ name: "clone" }, { file });
  assert.deepEqual((await toml(path.join(clone, "home/codex/config.toml"))).mcp_servers, codex.mcp_servers);
  const cloned = await json(path.join(clone, "home/claude/.claude.json"));
  assert.deepEqual(Object.keys(cloned.mcpServers as object), ["github"]);

  // A server edited natively is reported, is not overwritten, and stays when Woma stops managing it.
  const edited = { ...(claude.mcpServers as Record<string, unknown>), github: { type: "stdio", command: "edited", args: [], env: {} } };
  await writeFile(path.join(prefix, "home/claude/.claude.json"), JSON.stringify({ ...claude, mcpServers: edited }));
  assert.match((await doctorEnvironment(prefix)).join("\n"), /MCP server github differs/);
  await assert.rejects(addMcpServer(prefix, "github", { command: "npx", args: ["other"] }), /changed .* outside Woma/);
  await removeMcpServers(prefix, ["github", "docs"]);
  assert.equal(((await json(path.join(prefix, "home/claude/.claude.json"))).mcpServers as Record<string, { command: string }>).github!.command, "edited");
  assert.equal((await toml(path.join(prefix, "home/codex/config.toml"))).mcp_servers, undefined);
  assert.deepEqual(await doctorEnvironment(prefix), []);
});

test("directories of Skills install as one package, and hand-written environment files use bare relative sources", async (t) => {
  const f = await fixture(t);
  const collection = path.join(f.root, "harness/skills-from-everywhere");
  await skill(path.join(collection, "pdf")); await skill(path.join(collection, "docx"));
  await skill(path.join(f.root, "harness/paper-search"));
  const file = path.join(f.root, "harness/environment.yaml");
  await writeFile(file, "agents: [claude, codex]\npackages:\n  - ./skills-from-everywhere\n  - name: paper-search\n    source: ./paper-search\nmcp_servers:\n  fetch:\n    command: uvx\n    args: [mcp-server-fetch]\n");
  const prefix = await createEnvironment({ name: "hand-written" }, { file });
  const state = await readEnvironment(prefix);
  assert.deepEqual(state.lock.packages["skills-from-everywhere"]!.skills.map((s) => s.name), ["docx", "pdf"]);
  assert.deepEqual(await readdir(path.join(prefix, "home/codex/skills")), ["docx", "paper-search", "pdf"]);
  const exportFile = path.join(f.root, "harness/exported.yaml");
  const exported = parseYaml((await exportEnvironment(prefix, { file: exportFile })).content);
  assert.deepEqual(exported.packages, ["./skills-from-everywhere", "./paper-search"]);
  assert.equal(exported.name, "hand-written");
  await mkdir(path.join(f.root, "mixed/docs"), { recursive: true });
  await skill(path.join(f.root, "mixed/one"));
  await assert.rejects(installPackages(prefix, [path.join(f.root, "mixed")]), /Unsupported package layout.*mixed\/one|found in subdirectories: one/);
});

async function git(cwd: string, ...args: string[]) { return commandOutput("git", args, { cwd }); }

test("local Skills from a pushed Git clone export as Git sources; others export as local and travel in packs", async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.root, "my-skills");
  await skill(path.join(repo, "skills/paper-search"), "paper-search");
  await git(f.root, "init", "-q", "-b", "main", repo);
  await git(repo, "config", "user.name", "Woma Test"); await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "add", "."); await git(repo, "commit", "-qm", "initial");
  await git(repo, "remote", "add", "origin", "git@github.com:someone/my-skills.git");
  const commit = await git(repo, "rev-parse", "HEAD");
  const pushed = path.join(repo, "skills/paper-search");
  const unpushedRepo = path.join(f.root, "draft");
  await skill(path.join(unpushedRepo, "draft"), "draft");
  const prefix = await createEnvironment({ name: "share" }, { agents: ["claude"], sources: [pushed, path.join(unpushedRepo, "draft")] });
  assert.equal((await readEnvironment(prefix)).lock.packages["paper-search"]!.origin, undefined, "an unpushed commit is not portable");

  await git(repo, "update-ref", "refs/remotes/origin/main", commit);
  await removePackages(prefix, ["paper-search"]); await installPackages(prefix, [pushed]);
  assert.deepEqual((await readEnvironment(prefix)).lock.packages["paper-search"]!.origin, { url: "https://github.com/someone/my-skills.git", commit, subdirectory: "skills/paper-search" });
  const recipe = await exportEnvironment(prefix);
  assert.deepEqual(recipe.converted, ["paper-search"]); assert.deepEqual(recipe.local, ["draft"]);
  assert.deepEqual(parseYaml(recipe.content).packages, [path.join(unpushedRepo, "draft"), `gh:someone/my-skills/skills/paper-search#${commit}`]);
  const lock = JSON.parse((await exportEnvironment(prefix, { explicit: true })).content);
  assert.deepEqual(lock.packages["paper-search"].source, { type: "git", url: "https://github.com/someone/my-skills.git", commit, subdirectory: "skills/paper-search" });
  assert.equal(lock.packages["paper-search"].origin, undefined);
  assert.equal(lock.packages.draft.source.type, "local");

  // Uncommitted edits make the working tree differ from the pushed commit.
  await writeFile(path.join(pushed, "notes.md"), "local edit\n");
  await removePackages(prefix, ["paper-search"]); await installPackages(prefix, [pushed]);
  assert.equal((await readEnvironment(prefix)).lock.packages["paper-search"]!.origin, undefined);

  const pack = path.join(f.root, "share.tgz");
  await packEnvironment(prefix, pack);
  for (const record of Object.values((await readEnvironment(prefix)).lock.packages)) await removeTestTree(cachePath(record.integrity));
  await rm(unpushedRepo, { recursive: true, force: true });
  const clone = await createEnvironment({ name: "from-pack" }, { file: pack });
  assert.equal(await readFile(path.join(clone, "home/claude/skills/paper-search/notes.md"), "utf8"), "local edit\n");
  assert.ok((await stat(path.join(clone, "home/claude/skills/draft/SKILL.md"))).isFile());
  assert.deepEqual(await doctorEnvironment(clone), []);
});

test("Woma 0.7 locks and environments can be recreated", async (t) => {
  const f = await fixture(t);
  const prefix = await createEnvironment({ name: "current" }, { agents: ["codex"] });
  const source = await skill(path.join(f.root, "review"));
  await installPackages(prefix, [source]);
  const lock = JSON.parse((await exportEnvironment(prefix, { explicit: true })).content);
  // 0.7 locks pinned the agent release; that record is dropped because Woma now uses the installed agent.
  const runtime = { name: "codex", kind: "runtime", version: "0.154.0" };
  const legacyLock = { format: "woma.lock/v2", platform: "linux-x64", recipe: { format: "woma.environment/v2", name: "old", harness: "codex", runtime: "0.154.0", packages: lock.recipe.packages }, packages: { codex: runtime, ...lock.packages } };
  const file = path.join(f.root, "old.lock"); await writeFile(file, JSON.stringify(legacyLock));
  const recreated = await createEnvironment({ name: "recreated" }, { file });
  assert.deepEqual((await readEnvironment(recreated)).lock.recipe.agents, ["codex"]);
  assert.deepEqual(Object.keys((await readEnvironment(recreated)).lock.packages), ["review"]);
  const legacy = path.join(process.env.WOMA_HOME!, "environments/legacy");
  await mkdir(path.join(legacy, ".woma"), { recursive: true });
  await writeFile(path.join(legacy, ".woma/state.json"), JSON.stringify({ format: "woma.state/v2", lock: legacyLock, paths: [] }));
  await assert.rejects(readEnvironment(legacy), /created by Woma 0\.7[\s\S]*woma export/);
  const exported = JSON.parse((await exportEnvironment(legacy, { explicit: true })).content);
  assert.equal(exported.format, "woma.lock/v3");
  assert.deepEqual(exported.recipe.agents, ["codex"]);
});

test("environments use the claude and codex on PATH and report a missing one", async (t) => {
  const f = await fixture(t);
  const prefix = await createEnvironment({ name: "installed" }, { agents: ["claude", "codex"] });
  process.env.PATH = f.agents;
  assert.deepEqual((await describeAgents(["claude", "codex"])).map((a) => a.detail), [`2.1.269  (${f.agents}/claude)`, `0.154.0  (${f.agents}/codex)`]);
  assert.deepEqual(await doctorEnvironment(prefix), []);
  await rm(path.join(f.agents, "codex"));
  assert.match((await doctorEnvironment(prefix)).join("\n"), /codex is not installed.*npm install -g @openai\/codex/);
  await assert.rejects(runInEnvironment(prefix, "codex", []), /codex is not installed/);
  await removeEnvironment(prefix);
});
