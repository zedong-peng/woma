import { spawn } from "node:child_process";

export function commandOutput(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${args[0] ?? ""} failed (${signal ?? code}): ${stderr.trim()}`)));
  });
}
