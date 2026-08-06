import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { agentAdapter, SUPPORTED_AGENTS } from "./agents/registry.js";
import { environmentSnapshot } from "./environment.js";
import { environmentAgentHomePath, sourceAgentHome } from "./view.js";

export async function runInEnvironment(options: {
  projectRoot: string;
  environment: string;
  executable: string;
  args: string[];
  cwd?: string;
}): Promise<number> {
  const { environment } = await environmentSnapshot(options.projectRoot, options.environment);
  const selected = new Set(environment.spec.targets);
  const env: NodeJS.ProcessEnv = { ...process.env, WOMA_ENV: environment.metadata.name };
  for (const platform of SUPPORTED_AGENTS) {
    const descriptor = agentAdapter(platform).descriptor;
    const environmentHome = environmentAgentHomePath(environment.metadata.name, platform);
    for (const variable of descriptor.runtimeVariables) {
      if (selected.has(platform)) {
        env[variable.name] = path.resolve(environmentHome, variable.selectedRelativePath);
        continue;
      }
      const original = process.env[variable.originalName];
      if (original !== undefined) {
        if (original === "") delete env[variable.name];
        else env[variable.name] = original;
      } else if (variable.name === descriptor.sourceHome.environmentVariable && platform !== "opencode") {
        env[variable.name] = sourceAgentHome(platform);
      }
    }
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
