import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "./types.js";

export interface AgentCliStatus {
  command: string;
  available: boolean;
  path: string | null;
}

export const AGENT_CLI_COMMANDS: Readonly<Record<Platform, string>> = {
  codex: "codex",
  claude: "claude",
  pi: "pi",
  qoder: "qodercli",
};

const PLATFORMS: readonly Platform[] = ["codex", "claude", "pi", "qoder"];

async function executable(filePath: string): Promise<boolean> {
  return access(filePath, constants.X_OK).then(
    () => true,
    () => false,
  );
}

export async function findExecutable(command: string): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    const candidate = path.resolve(command);
    return (await executable(candidate)) ? candidate : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, command);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export async function detectAgentCli(platform: Platform): Promise<AgentCliStatus> {
  const command = AGENT_CLI_COMMANDS[platform];
  const executablePath = await findExecutable(command);
  return { command, available: executablePath !== undefined, path: executablePath ?? null };
}

export async function detectAgentClis(): Promise<Record<Platform, AgentCliStatus>> {
  const entries = await Promise.all(
    PLATFORMS.map(async (platform) => [platform, await detectAgentCli(platform)] as const),
  );
  return Object.fromEntries(entries) as Record<Platform, AgentCliStatus>;
}
