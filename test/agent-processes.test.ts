import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { confirmAgentMigration, parseAgentProcesses, type AgentProcess } from "../src/agent-processes.js";

const running: AgentProcess[] = [
  { pid: 123, agent: "codex", command: "/usr/local/bin/codex" },
  { pid: 456, agent: "claude", command: "node --no-warnings /opt/@anthropic-ai/claude-code/cli.js" },
];

test("Agent process detection recognizes native and Node CLIs without matching arguments", () => {
  const processes = parseAgentProcesses([
    "  123 codex /usr/local/bin/codex",
    "  456 node node --no-warnings /opt/@anthropic-ai/claude-code/cli.js",
    "  789 node node /opt/harness/cli.js migrate sessions --from codex",
    "  999 bash bash -c claude",
  ].join("\n"), 9999);
  assert.deepEqual(processes, running);
});

test("Agent migration confirmation requires an interactive terminal and exact yes", async () => {
  const noninteractiveInput = new PassThrough();
  const noninteractiveOutput = new PassThrough();
  await assert.rejects(
    confirmAgentMigration(running, noninteractiveInput, noninteractiveOutput),
    /requires manual confirmation in an interactive terminal/,
  );

  const confirmedInput = Object.assign(new PassThrough(), { isTTY: true });
  const confirmedOutput = Object.assign(new PassThrough(), { isTTY: true });
  confirmedInput.end("yes\n");
  await confirmAgentMigration(running, confirmedInput, confirmedOutput);

  const rejectedInput = Object.assign(new PassThrough(), { isTTY: true });
  const rejectedOutput = Object.assign(new PassThrough(), { isTTY: true });
  rejectedInput.end("y\n");
  await assert.rejects(confirmAgentMigration(running, rejectedInput, rejectedOutput), /Migration cancelled/);
});
