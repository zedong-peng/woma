import { stat } from "node:fs/promises";
import path from "node:path";
import { commandOutput } from "./process.js";
import type { Agent } from "./types.js";

export const installHint: Record<Agent, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

export function missingAgent(agent: Agent): string { return `${agent} is not installed (not found on PATH); install it with: ${installHint[agent]}`; }

/** The agent executable on PATH. Woma uses the user's own installation and does not manage its version. */
export async function findAgent(agent: Agent, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, agent);
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile() && info.mode & 0o111) return candidate;
  }
  return undefined;
}

/** The version the installed agent reports, for display only. */
export async function agentVersion(executable: string): Promise<string | undefined> {
  return commandOutput(executable, ["--version"]).then((output) => /\d+\.\d+\.\d+[^\s)]*/.exec(output)?.[0], () => undefined);
}

/** One line per agent: where it is installed and its version, or how to install it. */
export async function describeAgents(agents: readonly Agent[], environment: NodeJS.ProcessEnv = process.env): Promise<{ agent: Agent; found: boolean; detail: string }[]> {
  return Promise.all(agents.map(async (agent) => {
    const executable = await findAgent(agent, environment);
    if (!executable) return { agent, found: false, detail: missingAgent(agent) };
    const version = await agentVersion(executable);
    return { agent, found: true, detail: `${version ?? "unknown version"}  (${executable})` };
  }));
}
