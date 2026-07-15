import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureHarness } from "../src/capture.js";
import { loadManifest } from "../src/schema.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("capture exports Claude resources without secret values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-capture-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(path.join(source, ".claude", "skills", "review", "SKILL.md"), "---\ndescription: Review code.\n---\nReview.\n");
    await write(
      path.join(source, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "${DOCS_AUTH}" } } } }),
    );
    await write(
      path.join(source, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "git diff --check" }] }] } }),
    );

    const result = await captureHarness({ sourceRoot: source, outputRoot: output, platform: "claude", name: "captured-review" });
    assert.equal(result.manifest.spec.skills[0]?.name, "review");
    assert.deepEqual(result.manifest.spec.requirements.env.map((item) => item.name), ["DOCS_AUTH"]);
    assert.equal(result.manifest.spec.hooks[0]?.event, "PostToolUse");
    assert.doesNotMatch(await readFile(path.join(output, "harness.yaml"), "utf8"), /secret|Bearer/i);
    assert.equal((await loadManifest(output)).metadata.name, "captured-review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture rejects literal MCP credentials before creating package files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-capture-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(
      path.join(source, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer real-token" } } } }),
    );
    await assert.rejects(
      captureHarness({ sourceRoot: source, outputRoot: output, platform: "claude", name: "captured-review" }),
      /literal value/,
    );
    await assert.rejects(readFile(path.join(output, "harness.yaml")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
