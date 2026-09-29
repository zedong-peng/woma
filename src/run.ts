import { spawn } from "node:child_process";
import { findAgent, missingAgent } from "./agents.js";
import { readEnvironment } from "./environment.js";
import { selectedEnvironment } from "./selection.js";
import { AGENTS, type Agent } from "./types.js";

export async function runInEnvironment(prefix: string, executable: string, args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const state = await readEnvironment(prefix);
  const selected = selectedEnvironment(prefix, state, environment);
  let command = executable;
  if ((AGENTS as readonly string[]).includes(executable)) {
    if (!state.lock.recipe.agents.includes(executable as Agent)) throw new Error(`This environment has no ${executable}; add it with woma install ${executable}`);
    const found = await findAgent(executable as Agent, selected);
    if (!found) throw new Error(missingAgent(executable as Agent));
    command = found;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: selected, stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const handlers = signals.map((signal) => { const handler = () => { child.kill(signal); }; process.on(signal, handler); return handler; });
    function cleanup() { signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!)); }
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}
