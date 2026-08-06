import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertArtifactContracts } from "../src/agents/adapter.js";
import { agentAdapter, agentAdapters, SUPPORTED_AGENTS } from "../src/agents/registry.js";

test("built-in Agent Adapters expose one neutral contract per supported Agent", () => {
  assert.deepEqual(SUPPORTED_AGENTS, ["codex", "claude", "pi", "qoder", "opencode"]);
  assert.equal(new Set(agentAdapters().map((adapter) => adapter.descriptor.id)).size, SUPPORTED_AGENTS.length);
  for (const platform of SUPPORTED_AGENTS) {
    const adapter = agentAdapter(platform);
    assert.equal(adapter.descriptor.id, platform);
    assert.equal(adapter.descriptor.contractRevision, 1);
    assert.ok(adapter.descriptor.cliCommand.length > 0);
    assert.equal(adapter.descriptor.capabilities.skills, "symlink");
    assert.equal(new Set(adapter.descriptor.capabilities.mcpTransports).size, adapter.descriptor.capabilities.mcpTransports.length);
    const artifacts = adapter.artifacts({
      environmentName: "tools",
      sourceHome: path.join("/source", platform),
      defaultSourceHome: path.join("/source", platform),
      environmentHome: path.join("/environment", platform),
      currentView: path.join("/view", platform),
      seedFromOriginal: false,
      originalRuntimeVariables: {},
    });
    assert.equal(new Set(artifacts.map((artifact) => artifact.id)).size, artifacts.length);
    assert.equal(new Set(artifacts.map((artifact) => `${artifact.target}:${artifact.relativePath}`)).size, artifacts.length);
  }
});

test("Agent Adapter artifact contracts reject duplicate and escaping locations", () => {
  const adapter = agentAdapter("pi");
  const artifact = {
    id: "settings",
    relativePath: "settings.json",
    target: "view" as const,
    sources: [] as string[],
    content: "text" as const,
    mode: 0o600,
  };
  assert.doesNotThrow(() => assertArtifactContracts(adapter, [artifact]));
  assert.throws(
    () => assertArtifactContracts(adapter, [artifact, { ...artifact, id: "duplicate" }]),
    /declared artifact location view:settings.json twice/,
  );
  assert.throws(
    () => assertArtifactContracts(adapter, [{ ...artifact, relativePath: "../settings.json" }]),
    /declared unsafe artifact path/,
  );
});

test("OpenCode Adapter declares an isolated Woma overlay without claiming opaque state", () => {
  const adapter = agentAdapter("opencode");
  assert.deepEqual(adapter.descriptor.runtimeVariables, [
    { name: "OPENCODE_CONFIG", originalName: "WOMA_ORIGINAL_OPENCODE_CONFIG", selectedRelativePath: "opencode.json" },
    { name: "OPENCODE_CONFIG_DIR", originalName: "WOMA_ORIGINAL_OPENCODE_CONFIG_DIR", selectedRelativePath: "." },
  ]);
  assert.deepEqual(adapter.descriptor.capabilities, {
    skills: "symlink",
    mcp: "native",
    mcpTransports: ["stdio", "http", "sse"],
    hooks: "unsupported",
  });
  assert.deepEqual(
    adapter.artifacts({
      environmentName: "tools",
      sourceHome: "/source/opencode",
      defaultSourceHome: "/source/opencode",
      environmentHome: "/environment/opencode",
      currentView: "/view/opencode",
      seedFromOriginal: false,
      originalRuntimeVariables: {},
    }).filter((artifact) => artifact.target === "view").map(({ id, relativePath, target, content }) => ({ id, relativePath, target, content })),
    [{ id: "config", relativePath: "opencode.json", target: "view", content: "text" }],
  );
});
