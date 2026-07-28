import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWoma } from "../src/capture.js";
import { loadManifest } from "../src/schema.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("capture exports Claude resources without secret values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-capture-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(path.join(source, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\nReview.\n");
    await write(
      path.join(source, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "${DOCS_AUTH}" } } } }),
    );
    await write(
      path.join(source, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "git diff --check" }] }] } }),
    );

    const result = await captureWoma({ sourceRoot: source, outputRoot: output, platform: "claude", name: "captured-review" });
    assert.equal(result.manifest.spec.skills[0]?.name, "review");
    assert.deepEqual(result.manifest.spec.requirements.env.map((item) => item.name), ["DOCS_AUTH"]);
    assert.equal(result.manifest.spec.hooks[0]?.event, "PostToolUse");
    assert.doesNotMatch(await readFile(path.join(output, "woma.yaml"), "utf8"), /secret|Bearer/i);
    assert.equal((await loadManifest(output)).metadata.name, "captured-review");
  } finally {
    await removeTestTree(root);
  }
});

test("capture rejects literal MCP credentials before creating package files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-capture-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(
      path.join(source, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer real-token" } } } }),
    );
    await assert.rejects(
      captureWoma({ sourceRoot: source, outputRoot: output, platform: "claude", name: "captured-review" }),
      /literal value/,
    );
    await assert.rejects(readFile(path.join(output, "woma.yaml")), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("capture exports project Codex command hooks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-capture-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(path.join(source, ".agents", "skills", "verify", "SKILL.md"), "---\nname: verify\ndescription: Verify.\n---\nVerify.\n");
    await write(
      path.join(source, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "git diff --check" }] }] } }),
    );
    const result = await captureWoma({ sourceRoot: source, outputRoot: output, platform: "codex", name: "codex-capture" });
    assert.equal(result.manifest.spec.hooks[0]?.event, "PostToolUse");
    assert.deepEqual(result.manifest.spec.hooks[0]?.platforms, ["codex"]);
    assert.equal(result.manifest.spec.hooks[0]?.command, "git diff --check");
  } finally {
    await removeTestTree(root);
  }
});

test("failed capture leaves no partial destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-capture-transaction-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    await write(path.join(source, ".agents", "skills", "broken", "SKILL.md"), "not valid Skill frontmatter\n");
    await assert.rejects(captureWoma({ sourceRoot: source, outputRoot: output, platform: "codex" }), /frontmatter/);
    await assert.rejects(readFile(output), /ENOENT/);
  } finally {
    await removeTestTree(root);
  }
});

test("capture refuses an existing destination without changing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-capture-existing-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "captured");
    const marker = path.join(output, "keep.txt");
    await write(marker, "keep\n");
    await assert.rejects(captureWoma({ sourceRoot: source, outputRoot: output, platform: "codex" }), /existing destination/);
    assert.equal(await readFile(marker, "utf8"), "keep\n");
  } finally {
    await removeTestTree(root);
  }
});
