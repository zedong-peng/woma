import { capabilitySupportIssues, projectionDiagnostics, type AgentAdapter } from "./adapter.js";

export const piAdapter: AgentAdapter = {
  descriptor: {
    id: "pi",
    contractRevision: 1,
    displayName: "Pi",
    cliCommand: "pi",
    sourceHome: {
      environmentVariable: "PI_CODING_AGENT_DIR",
      originalEnvironmentVariable: "WOMA_ORIGINAL_PI_CODING_AGENT_DIR",
      defaultPath: [".pi", "agent"],
    },
    runtimeVariables: [
      { name: "PI_CODING_AGENT_DIR", originalName: "WOMA_ORIGINAL_PI_CODING_AGENT_DIR", selectedRelativePath: "." },
    ],
    capabilities: { skills: "symlink", mcp: "unsupported", mcpTransports: [], hooks: "unsupported" },
  },
  artifacts() {
    return [];
  },
  validate(input) {
    return capabilitySupportIssues(piAdapter, input.capabilities);
  },
  plan() {
    return { files: [], resources: { mcpServers: [] } };
  },
  discover() {
    return { mcpServers: [], hooks: [], externalMcpServers: [] };
  },
  diagnose(input) {
    return projectionDiagnostics(piAdapter, input);
  },
};
