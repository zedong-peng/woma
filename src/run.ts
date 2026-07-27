import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { environmentSnapshot } from "./environment.js";
import { environmentAgentHomePath, sourceAgentHome } from "./view.js";
import type { Platform } from "./types.js";

const HOME_VARIABLES: Record<Platform, "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "PI_CODING_AGENT_DIR"> = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  pi: "PI_CODING_AGENT_DIR",
};

export async function runInEnvironment(options: {
  projectRoot: string;
  environment: string;
  executable: string;
  args: string[];
  cwd?: string;
}): Promise<number> {
  const { environment } = await environmentSnapshot(options.projectRoot, options.environment);
  const selected = new Set(environment.spec.targets);
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_ENV: environment.metadata.name };
  for (const platform of Object.keys(HOME_VARIABLES) as Platform[]) {
    env[HOME_VARIABLES[platform]] = selected.has(platform)
      ? environmentAgentHomePath(environment.metadata.name, platform)
      : sourceAgentHome(platform);
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const cwdInfo = await stat(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Working directory does not exist: ${cwd}`);
    throw error;
  });
  if (!cwdInfo.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.executable, options.args, { cwd, env, stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") reject(new Error(`Command not found: ${options.executable}`));
      else reject(error);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
