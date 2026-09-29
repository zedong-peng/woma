import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findAgent, missingAgent } from "../src/agents.js";
import { addMcpServer, createEnvironment, doctorEnvironment, exportEnvironment, installPackages, readEnvironment, removePackages } from "../src/environment.js";
import { commandOutput } from "../src/process.js";
import { selectedEnvironment } from "../src/selection.js";
import { fixture, plugin, skill } from "./helpers.js";

const live = process.env.WOMA_LIVE_TESTS !== "1";
const probeServer = `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PROBE_LOG, JSON.stringify({ token: process.env.WOMA_PROBE_TOKEN ?? null }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } } : message.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

// Live tests use the Claude Code and Codex installed on PATH, as Woma does.
test("installed Claude Code and Codex share Skills and MCP servers in one environment", { skip: live, timeout: 900_000 }, async (t) => {
  const f = await fixture(t, { realAgents: true });
  for (const agent of ["claude", "codex"] as const) assert.ok(await findAgent(agent), missingAgent(agent));
  const prefix = await createEnvironment({ prefix: f.prefix }, { agents: ["claude", "codex"] });
  const env = selectedEnvironment(prefix, await readEnvironment(prefix), { PATH: process.env.PATH, HOME: path.join(f.root, "user") });
  await mkdir(env.HOME!, { recursive: true });
  const run = (agent: string, ...args: string[]) => commandOutput(agent, args, { cwd: f.root, env });
  await installPackages(prefix, [await skill(path.join(f.root, "woma-live-probe"), "woma-live-probe")]);
  const server = path.join(f.root, "probe-server.mjs");
  const log = path.join(f.root, "probe.log");
  await writeFile(server, probeServer);
  await addMcpServer(prefix, "woma-probe", { command: process.execPath, args: [server], env: { PROBE_LOG: log }, env_vars: ["WOMA_PROBE_TOKEN"] });
  assert.match(await run("codex", "debug", "prompt-input", "hi"), /woma-live-probe/);
  const servers = JSON.parse(await run("codex", "mcp", "list", "--json")) as { name: string; transport: { env_vars?: string[] } }[];
  assert.deepEqual(servers.find((s) => s.name === "woma-probe")?.transport.env_vars, ["WOMA_PROBE_TOKEN"]);
  // Claude Code starts the server for its health check; the secret arrives from the shell without being stored.
  await writeFile(log, "");
  assert.match(await commandOutput("claude", ["mcp", "list"], { cwd: f.root, env: { ...env, WOMA_PROBE_TOKEN: "from-shell" } }), /woma-probe.*Connected/);
  assert.equal(JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!).token, "from-shell");
  assert.doesNotMatch(await readFile(path.join(prefix, "home/claude/.claude.json"), "utf8"), /from-shell/);
  assert.deepEqual(await doctorEnvironment(prefix), []);
  const lock = path.join(f.root, "woma.lock"); await writeFile(lock, (await exportEnvironment(prefix, { explicit: true })).content);
  const clone = await createEnvironment({ prefix: path.join(f.root, "clone") }, { file: lock });
  assert.deepEqual((await readEnvironment(clone)).lock.packages, (await readEnvironment(prefix)).lock.packages);
  assert.match(await readFile(path.join(clone, "home/codex/config.toml"), "utf8"), /woma-probe/);
});

for (const harness of ["codex", "claude"] as const) {
  test(`installed ${harness} native plugin contract`, { skip: live, timeout: 600_000 }, async (t) => {
    const f = await fixture(t, { realAgents: true });
    const executable = await findAgent(harness);
    assert.ok(executable, missingAgent(harness));
    const prefix = await createEnvironment({ prefix: f.prefix }, { agents: [harness] });
    const env = selectedEnvironment(prefix, await readEnvironment(prefix), { PATH: process.env.PATH, HOME: path.join(f.root, "user") });
    await mkdir(env.HOME!, { recursive: true });
    const source = await plugin(path.join(f.root, "probe"), harness);
    await installPackages(prefix, [source]);
    const listed = JSON.stringify(JSON.parse(await commandOutput(executable, ["plugin", "list", "--json"], { cwd: f.root, env })) as unknown);
    assert.match(listed, /probe/);
    assert.match(listed, /true/);
    assert.deepEqual(await doctorEnvironment(prefix), []);
    await removePackages(prefix, ["probe"]);
    assert.deepEqual(await doctorEnvironment(prefix), []);
  });
}
