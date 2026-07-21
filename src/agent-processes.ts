import { execFile } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AgentProcess {
  pid: number;
  agent: "codex" | "claude";
  command: string;
}

type TerminalInput = Readable & { isTTY?: boolean };
type TerminalOutput = Writable & { isTTY?: boolean };

function commandAgent(command: string, args: string): AgentProcess["agent"] | undefined {
  const executable = path.basename(command).toLowerCase();
  if (executable === "codex" || executable === "claude") return executable;

  if (executable !== "node" && executable !== "nodejs") return undefined;
  if (/[\\/]@openai[\\/]codex(?:[\\/]|$)/i.test(args)) return "codex";
  if (/[\\/]@anthropic-ai[\\/]claude-code(?:[\\/]|$)/i.test(args)) return "claude";
  const script = args.trim().split(/\s+/).slice(1).find((argument) => !argument.startsWith("-"));
  if (!script) return undefined;
  const scriptName = path.basename(script).toLowerCase().replace(/\.js$/, "");
  if (scriptName === "codex" || scriptName === "claude") return scriptName;
  return undefined;
}

export function parseAgentProcesses(output: string, ownPid = process.pid): AgentProcess[] {
  const processes: AgentProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === ownPid) continue;
    const args = match[3] ?? match[2];
    const agent = commandAgent(match[2], args);
    if (!agent) continue;
    processes.push({ pid, agent, command: args.trim() });
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

export async function currentUserAgentProcesses(): Promise<AgentProcess[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot check running Agent processes on this platform");
  let stdout: string;
  try {
    ({ stdout } = await run("ps", ["-U", String(uid), "-o", "pid=", "-o", "comm=", "-o", "args="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`Cannot check running Agent processes: ${(error as Error).message}`);
  }
  return parseAgentProcesses(stdout);
}

function warning(processes: AgentProcess[]): string {
  const lines = ["Running Codex or Claude processes detected for the current user:"];
  for (const processInfo of processes) {
    const command = processInfo.command.length > 200
      ? `${processInfo.command.slice(0, 197)}...`
      : processInfo.command;
    lines.push(`  PID ${String(processInfo.pid).padEnd(7)} ${processInfo.agent.padEnd(6)} ${command}`);
  }
  return lines.join("\n");
}

export async function confirmAgentMigration(
  processes: AgentProcess[],
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stderr,
): Promise<void> {
  if (processes.length === 0) return;
  const message = warning(processes);
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`${message}\nMigration requires manual confirmation in an interactive terminal`);
  }

  output.write(`${message}\n`);
  const terminal = createInterface({ input, output });
  try {
    const answer = await terminal.question('Type "yes" to continue migration: ');
    if (answer.trim() !== "yes") throw new Error("Migration cancelled");
  } finally {
    terminal.close();
  }
}

export async function requireAgentMigrationConfirmation(): Promise<void> {
  await confirmAgentMigration(await currentUserAgentProcesses());
}
