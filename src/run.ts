import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { readEnvironment } from "./environment.js";
import { selectedEnvironment } from "./selection.js";

export async function runInEnvironment(prefix: string, executable: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const state = await readEnvironment(prefix);
  const harness = state.lock.recipe.harness;
  if (["codex", "claude"].includes(executable) && executable !== harness) throw new Error(`This environment contains ${harness}; changing harness brands requires a new environment`);
  const managed = path.join(prefix, "bin", harness);
  await access(managed, constants.X_OK).catch(() => { throw new Error(`Managed runtime is missing: ${managed}; no system runtime fallback is allowed`); });
  return new Promise((resolve, reject) => {
    const child = spawn(executable === harness ? managed : executable, args, { env: selectedEnvironment(prefix, state, environment), stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const handlers = signals.map((signal) => { const handler = () => { child.kill(signal); }; process.on(signal, handler); return handler; });
    function cleanup() { signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!)); }
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}
