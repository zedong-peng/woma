import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { activatePackage, deactivatePackage } from "../src/activation.js";
import { installPackageSource } from "../src/package.js";
import { readState } from "../src/store.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function fixture(root: string, packageName = "test-harness", directoryName = "package"): Promise<string> {
  const packageRoot = path.join(root, directoryName);
  await write(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: ${packageName}
  version: 1.0.0
  description: Test both adapters.
spec:
  platforms: [codex, claude]
  requirements:
    env:
      - name: TEST_TOKEN
        optional: false
      - name: REMOTE_AUTH
        optional: false
    commands: [node]
  skills:
    - name: test-workflow
      path: ./skills/test-workflow
  mcpServers:
    - name: test-server
      transport: stdio
      command: node
      args: [server.mjs]
      env: [TEST_TOKEN]
    - name: remote-docs
      transport: http
      url: https://example.com/mcp
      headers:
        Authorization: REMOTE_AUTH
  hooks:
    - event: PostToolUse
      matcher: Edit|Write
      command: git diff --check
`,
  );
  await write(path.join(packageRoot, "skills", "test-workflow", "SKILL.md"), "---\nname: test-workflow\ndescription: Test.\n---\n\nRun tests.\n");
  return packageRoot;
}

test("activation merges both targets and deactivation preserves existing config", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const packageRoot = await fixture(root);
    await write(path.join(project, ".codex", "config.toml"), "model = \"gpt-test\"\n");
    await write(path.join(project, ".mcp.json"), '{"mcpServers":{"existing":{"command":"keep"}}}\n');
    await write(path.join(project, ".claude", "settings.json"), '{"permissions":{"allow":["Read"]}}\n');
    const pkg = await installPackageSource(packageRoot);

    const actions = await activatePackage(pkg, project, ["codex", "claude"]);
    assert.ok(actions.some((action) => action.detail === "Codex MCP test-server"));
    assert.ok(actions.some((action) => action.detail === "Claude MCP test-server"));
    assert.match(await readFile(path.join(project, ".agents", "skills", "test-workflow", "SKILL.md"), "utf8"), /Run tests/);
    assert.match(await readFile(path.join(project, ".claude", "skills", "test-workflow", "SKILL.md"), "utf8"), /Run tests/);

    const codex = parseToml(await readFile(path.join(project, ".codex", "config.toml"), "utf8")) as Record<string, unknown>;
    assert.equal(codex.model, "gpt-test");
    assert.deepEqual((codex.mcp_servers as Record<string, unknown>)["test-server"], {
      command: "node",
      args: ["server.mjs"],
      env_vars: ["TEST_TOKEN"],
    });
    assert.deepEqual((codex.mcp_servers as Record<string, unknown>)["remote-docs"], {
      url: "https://example.com/mcp",
      env_http_headers: { Authorization: "REMOTE_AUTH" },
    });
    const claudeMcp = JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")) as Record<string, any>;
    assert.equal(claudeMcp.mcpServers.existing.command, "keep");
    assert.equal(claudeMcp.mcpServers["test-server"].env.TEST_TOKEN, "${TEST_TOKEN}");
    assert.equal(claudeMcp.mcpServers["remote-docs"].headers.Authorization, "${REMOTE_AUTH}");
    const settings = JSON.parse(await readFile(path.join(project, ".claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "git diff --check");

    await deactivatePackage("test-harness", project);
    assert.equal(await readFile(path.join(project, ".codex", "config.toml"), "utf8"), 'model = "gpt-test"\n');
    const afterMcp = JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(afterMcp, { mcpServers: { existing: { command: "keep" } } });
    const afterSettings = JSON.parse(await readFile(path.join(project, ".claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(afterSettings, { permissions: { allow: ["Read"] } });
    assert.equal((await readState(project)).activations["test-harness"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run writes nothing and conflicts are rejected before mutation", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const packageRoot = await fixture(root);
    const pkg = await installPackageSource(packageRoot);
    const plan = await activatePackage(pkg, project, ["codex"], true);
    assert.ok(plan.length > 0);
    await assert.rejects(readFile(path.join(project, ".codex", "config.toml")), /ENOENT/);

    await write(path.join(project, ".codex", "config.toml"), '[mcp_servers."test-server"]\ncommand = "other"\n');
    await assert.rejects(activatePackage(pkg, project, ["codex"]), /Refusing to overwrite MCP server/);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "test-workflow", "SKILL.md")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deactivation retains a skill modified by the user", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const pkg = await installPackageSource(await fixture(root));
    await activatePackage(pkg, project, ["codex"]);
    const skill = path.join(project, ".agents", "skills", "test-workflow", "SKILL.md");
    await writeFile(skill, `${await readFile(skill, "utf8")}\nUser edit.\n`, "utf8");
    const actions = await deactivatePackage("test-harness", project);
    assert.ok(actions.some((action) => action.verb === "keep" && action.detail.includes("modified")));
    assert.match(await readFile(skill, "utf8"), /User edit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deactivation retains a managed Codex MCP block modified by the user", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const pkg = await installPackageSource(await fixture(root));
    await activatePackage(pkg, project, ["codex"]);
    const configPath = path.join(project, ".codex", "config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replace('command = "node"', 'command = "node-custom"'), "utf8");
    const actions = await deactivatePackage("test-harness", project);
    assert.ok(actions.some((action) => action.verb === "keep" && action.detail.includes("changed or absent")));
    assert.match(await readFile(configPath, "utf8"), /node-custom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared artifacts remain until their final owning harness is deactivated", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const first = await installPackageSource(await fixture(root, "owner-a", "package-a"));
    const second = await installPackageSource(await fixture(root, "owner-b", "package-b"));
    await activatePackage(first, project, ["codex", "claude"]);
    await activatePackage(second, project, ["codex", "claude"]);

    await deactivatePackage("owner-a", project);
    assert.match(await readFile(path.join(project, ".agents", "skills", "test-workflow", "SKILL.md"), "utf8"), /Run tests/);
    assert.match(await readFile(path.join(project, ".claude", "skills", "test-workflow", "SKILL.md"), "utf8"), /Run tests/);
    const codex = parseToml(await readFile(path.join(project, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(codex.mcp_servers["test-server"].command, "node");
    const claudeMcp = JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")) as Record<string, any>;
    assert.equal(claudeMcp.mcpServers["test-server"].command, "node");
    const settings = JSON.parse(await readFile(path.join(project, ".claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.ok((await readState(project)).activations["owner-b"]);

    await deactivatePackage("owner-b", project);
    await assert.rejects(readFile(path.join(project, ".agents", "skills", "test-workflow", "SKILL.md")), /ENOENT/);
    const finalCodex = parseToml(await readFile(path.join(project, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(finalCodex.mcp_servers, undefined);
    const finalClaudeMcp = JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(finalClaudeMcp, {});
    const finalSettings = JSON.parse(await readFile(path.join(project, ".claude", "settings.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(finalSettings, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
