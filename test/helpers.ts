import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { publishContent } from "../src/content.js";
import { loadPackage } from "../src/package.js";
import { runtimePlatform, type RuntimeProvider } from "../src/runtime.js";
import type { Harness } from "../src/types.js";

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

export async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "woma-v2-")));
  const previous = process.env.WOMA_HOME;
  process.env.WOMA_HOME = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.WOMA_HOME; else process.env.WOMA_HOME = previous;
    await removeTestTree(root);
  });
  const provider: RuntimeProvider = {
    async resolve(harness, requested) {
      const version = requested === "latest" ? harness === "codex" ? "0.154.0" : "2.1.269" : requested;
      const source = path.join(root, `runtime-${harness}-${version}`);
      await mkdir(path.join(source, "platform"), { recursive: true });
      await writeFile(path.join(source, "platform/runner"), `#!/bin/sh\nprintf '%s\\n' '${harness} ${version}'\n`, { mode: 0o755 });
      const name = harness === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
      await writeFile(path.join(source, "platform/package.json"), JSON.stringify({ name, version }));
      const cached = await publishContent(source);
      return { root: cached.root, record: { name: harness, kind: "runtime", version, integrity: cached.integrity,
        source: { type: "runtime", provider: "npm", platform: runtimePlatform(), executable: "platform/runner", artifacts: [{ name, version, url: `https://registry.npmjs.org/${name}/-/fixture.tgz`, integrity: `sha512-${Buffer.alloc(64).toString("base64")}`, directory: "platform" }] },
        dependencies: [], harnesses: { [harness]: "*" }, skills: [],
      } };
    },
    restore: (record) => loadPackage(record),
  };
  return { root, provider, prefix: path.join(root, "env") };
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
