import path from "node:path";
import {
  artifactText,
  capabilitySupportIssues,
  projectionDiagnostics,
  type AgentAdapter,
  type AgentProjectionInput,
  type DiscoveryResult,
  type ProjectionPlan,
} from "./adapter.js";
import { canonicalOwnershipRecords } from "./canonical.js";
import { jsonDocument, mergeHooks, mergeMcpServers, parseJsonObject, removeHooks, removeMcpServers } from "./json.js";

function plan(input: AgentProjectionInput): ProjectionPlan {
  const artifact = artifactText(input, "settings");
  const settings = parseJsonObject(artifact.content, artifact.path);
  removeHooks(artifact.path, settings, input.previousCapabilities.hooks);
  mergeHooks(artifact.path, settings, input.capabilities.hooks, input.previousCapabilities.hooks);
  removeMcpServers(
    settings,
    artifact.path,
    "mcpServers",
    input.previousCapabilities.mcpServers,
    "Qoder",
  );
  mergeMcpServers(settings, artifact.path, "mcpServers", input.capabilities.mcpServers, "Qoder", input.previousCapabilities.mcpServers);
  return {
    files: [{ artifactId: "settings", content: jsonDocument(settings) }],
    resources: { mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name) },
    ownership: canonicalOwnershipRecords(input.capabilities, { mcp: "settings.json#mcpServers", hooks: "settings.json#hooks" }),
  };
}

function discover(input: AgentProjectionInput): DiscoveryResult {
  return {
    mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name),
    hooks: input.capabilities.hooks.map(({ hook }) => hook.event),
    externalMcpServers: [],
  };
}

export const qoderAdapter: AgentAdapter = {
  descriptor: {
    id: "qoder",
    contractRevision: 1,
    displayName: "Qoder",
    cliCommand: "qodercli",
    sourceHome: {
      environmentVariable: "QODER_CONFIG_DIR",
      originalEnvironmentVariable: "WOMA_ORIGINAL_QODER_CONFIG_DIR",
      defaultPath: [".qoder"],
    },
    runtimeVariables: [
      { name: "QODER_CONFIG_DIR", originalName: "WOMA_ORIGINAL_QODER_CONFIG_DIR", selectedRelativePath: "." },
    ],
    capabilities: {
      skills: "symlink",
      mcp: "native",
      mcpTransports: ["stdio", "http", "sse", "ws"],
      hooks: "native",
    },
  },
  artifacts(context) {
    return [{
      id: "settings",
      relativePath: "settings.json",
      target: "view",
      sources: [
        path.join(context.currentView, "settings.json"),
        ...(context.seedFromOriginal ? [path.join(context.sourceHome, "settings.json")] : []),
      ],
      content: "text",
      mode: 0o600,
    }];
  },
  validate(input) {
    return capabilitySupportIssues(qoderAdapter, input.capabilities);
  },
  plan,
  discover,
  diagnose(input) {
    return projectionDiagnostics(qoderAdapter, input);
  },
};
