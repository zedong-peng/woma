import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Agent as Harness } from "../src/types.js";

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(path.join(root, entry));
    return;
  }
  if (info.isFile()) await chmod(root, 0o600);
}

export async function removeTestTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

/** A temporary Woma home. Unless `realAgents` is set, stand-in claude and codex executables come first on PATH. */
export async function fixture(t: TestContext, options: { realAgents?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "woma-v2-")));
  const previous = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.WOMA_HOME; else process.env.WOMA_HOME = previous;
    await removeTestTree(root);
  });
  const agents = path.join(root, "agents");
  if (!options.realAgents) {
    await mkdir(agents);
    for (const [agent, version] of [["claude", "2.1.269 (Claude Code)"], ["codex", "codex-cli 0.154.0"]] as const) {
      await writeFile(path.join(agents, agent), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    }
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${agents}${path.delimiter}${previousPath}`;
    t.after(() => { process.env.PATH = previousPath; });
  }
  return { root, agents, prefix: path.join(root, "env") };
}

export async function skill(root: string, name = path.basename(root), body = "Original content"): Promise<string> {
  await mkdir(path.join(root, "references"), { recursive: true });
  await writeFile(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n${body}\n`);
  await writeFile(path.join(root, "references/note.txt"), "Complete reference content\n");
  return root;
}

export async function plugin(root: string, harness: Harness, name = path.basename(root)): Promise<string> {
  await mkdir(path.join(root, `.${harness}-plugin`), { recursive: true });
  await writeFile(path.join(root, `.${harness}-plugin/plugin.json`), JSON.stringify({ name, version: "1.0.0" }));
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { example: { command: "node", args: ["server.js"] } } }));
  await mkdir(path.join(root, "hooks"), { recursive: true });
  await writeFile(path.join(root, "hooks/hooks.json"), JSON.stringify({ hooks: {} }));
  return root;
}
