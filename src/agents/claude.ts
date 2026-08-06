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

function originalStatePath(sourceHome: string): string {
  const sibling = path.join(path.dirname(sourceHome), ".claude.json");
  return path.basename(sourceHome) === ".claude" ? sibling : path.join(sourceHome, ".claude.json");
}

function plan(input: AgentProjectionInput): ProjectionPlan {
  const settingsArtifact = artifactText(input, "settings");
  const settings = parseJsonObject(settingsArtifact.content, settingsArtifact.path);
  removeHooks(settingsArtifact.path, settings, input.previousCapabilities.hooks);
  mergeHooks(settingsArtifact.path, settings, input.capabilities.hooks, input.previousCapabilities.hooks);

  const stateArtifact = artifactText(input, "state");
  const state = parseJsonObject(stateArtifact.content, stateArtifact.path);
  removeMcpServers(state, stateArtifact.path, "mcpServers", input.previousCapabilities.mcpServers, "Claude");
  mergeMcpServers(
    state,
    stateArtifact.path,
    "mcpServers",
    input.capabilities.mcpServers,
    "Claude",
    input.previousCapabilities.mcpServers,
  );

  return {
    files: [
      { artifactId: "settings", content: jsonDocument(settings) },
      { artifactId: "state", content: jsonDocument(state) },
    ],
    resources: { mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name) },
    ownership: canonicalOwnershipRecords(input.capabilities, { mcp: ".claude.json#mcpServers", hooks: "settings.json#hooks" }),
  };
}

function discover(input: AgentProjectionInput): DiscoveryResult {
  return {
    mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name),
    hooks: input.capabilities.hooks.map(({ hook }) => hook.event),
    externalMcpServers: [],
  };
}

export const claudeAdapter: AgentAdapter = {
  descriptor: {
    id: "claude",
    contractRevision: 1,
    displayName: "Claude Code",
    cliCommand: "claude",
    sourceHome: {
      environmentVariable: "CLAUDE_CONFIG_DIR",
      originalEnvironmentVariable: "WOMA_ORIGINAL_CLAUDE_CONFIG_DIR",
      defaultPath: [".claude"],
    },
    runtimeVariables: [
      { name: "CLAUDE_CONFIG_DIR", originalName: "WOMA_ORIGINAL_CLAUDE_CONFIG_DIR", selectedRelativePath: "." },
    ],
    capabilities: {
      skills: "symlink",
      mcp: "native",
      mcpTransports: ["stdio", "http", "sse", "ws"],
      hooks: "native",
    },
  },
  artifacts(context) {
    return [
      {
        id: "credential",
        relativePath: ".credentials.json",
        target: "home",
        sources: [
          path.join(context.environmentHome, ".credentials.json"),
          ...(context.seedFromOriginal ? [path.join(context.sourceHome, ".credentials.json")] : []),
        ],
        content: "opaque",
        mode: 0o600,
        credential: true,
      },
      {
        id: "settings",
        relativePath: "settings.json",
        target: "home",
        sources: [
          path.join(context.environmentHome, "settings.json"),
          ...(context.seedFromOriginal ? [path.join(context.sourceHome, "settings.json")] : []),
        ],
        content: "text",
        mode: 0o600,
      },
      {
        id: "state",
        relativePath: ".claude.json",
        target: "home",
        sources: [
          path.join(context.environmentHome, ".claude.json"),
          ...(context.seedFromOriginal ? [originalStatePath(context.sourceHome)] : []),
        ],
        content: "text",
        mode: 0o600,
      },
    ];
  },
  validate(input) {
    return capabilitySupportIssues(claudeAdapter, input.capabilities);
  },
  plan,
  discover,
  diagnose(input) {
    return projectionDiagnostics(claudeAdapter, input);
  },
};
