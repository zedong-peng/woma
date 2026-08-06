import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
  capabilitySupportIssues,
  projectionDiagnostics,
  type AgentAdapter,
  type AgentProjectionInput,
  type DiscoveryResult,
  type ProjectionPlan,
  type ValidationIssue,
} from "./adapter.js";
import { jsonDocument } from "./json.js";

interface ExternalMcpConfig {
  names: string[];
  issues: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function externalMcpConfig(input: AgentProjectionInput): ExternalMcpConfig {
  const names = new Set<string>();
  const issues: string[] = [];
  for (const snapshot of Object.values(input.artifacts).filter((item) => item.contract.target === "input" && item.text !== null)) {
    const errors: ParseError[] = [];
    const document: unknown = parse(snapshot.text!, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      issues.push(
        `Cannot inspect external OpenCode MCP config ${snapshot.sourcePath}: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`,
      );
      continue;
    }
    if (!isObject(document)) {
      issues.push(`Cannot inspect external OpenCode MCP config ${snapshot.sourcePath}: root must be an object`);
      continue;
    }
    if (document.mcp === undefined) continue;
    if (!isObject(document.mcp)) {
      issues.push(`Cannot inspect external OpenCode MCP config ${snapshot.sourcePath}: mcp must be an object`);
      continue;
    }
    for (const name of Object.keys(document.mcp)) names.add(name);
  }
  return { names: [...names].sort(), issues };
}

function mcpValue(server: AgentProjectionInput["capabilities"]["mcpServers"][number]["server"]): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
      ...(server.env.length > 0
        ? { environment: Object.fromEntries(server.env.map((name) => [name, `{env:${name}}`])) }
        : {}),
    };
  }
  return {
    type: "remote",
    url: server.url,
    enabled: true,
    ...(Object.keys(server.headers).length > 0
      ? { headers: Object.fromEntries(Object.entries(server.headers).map(([header, name]) => [header, `{env:${name}}`])) }
      : {}),
  };
}

function validate(input: AgentProjectionInput): ValidationIssue[] {
  const external = externalMcpConfig(input);
  const managedNames = new Set(input.capabilities.mcpServers.map(({ server }) => server.name));
  return [
    ...capabilitySupportIssues(opencodeAdapter, input.capabilities),
    ...external.issues.map((message) => ({ severity: "error" as const, capability: "mcp" as const, message })),
    ...external.names.filter((name) => managedNames.has(name)).map((name) => ({
      severity: "error" as const,
      capability: "mcp" as const,
      message: `OpenCode MCP server ${name} conflicts with an external native configuration`,
    })),
  ];
}

function plan(input: AgentProjectionInput): ProjectionPlan {
  const mcp = Object.fromEntries(input.capabilities.mcpServers.map(({ server }) => [server.name, mcpValue(server)]));
  return {
    files: [{ artifactId: "config", content: jsonDocument({ $schema: "https://opencode.ai/config.json", mcp }) }],
    resources: { mcpServers: Object.keys(mcp) },
  };
}

function discover(input: AgentProjectionInput): DiscoveryResult {
  return {
    mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name),
    hooks: [],
    externalMcpServers: externalMcpConfig(input).names,
  };
}

export const opencodeAdapter: AgentAdapter = {
  descriptor: {
    id: "opencode",
    contractRevision: 1,
    displayName: "OpenCode",
    cliCommand: "opencode",
    sourceHome: {
      environmentVariable: "OPENCODE_CONFIG_DIR",
      originalEnvironmentVariable: "WOMA_ORIGINAL_OPENCODE_CONFIG_DIR",
      defaultPath: ["opencode"],
      defaultRootEnvironmentVariable: "XDG_CONFIG_HOME",
      defaultRootPath: [".config"],
    },
    runtimeVariables: [
      { name: "OPENCODE_CONFIG", originalName: "WOMA_ORIGINAL_OPENCODE_CONFIG", selectedRelativePath: "opencode.json" },
      { name: "OPENCODE_CONFIG_DIR", originalName: "WOMA_ORIGINAL_OPENCODE_CONFIG_DIR", selectedRelativePath: "." },
    ],
    capabilities: {
      skills: "symlink",
      mcp: "native",
      mcpTransports: ["stdio", "http", "sse"],
      hooks: "unsupported",
    },
  },
  artifacts(context) {
    const roots = [...new Set([context.defaultSourceHome, context.sourceHome].map((root) => path.resolve(root)))];
    const externalPaths = roots.flatMap((root) => ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(root, name)));
    const custom = context.originalRuntimeVariables.OPENCODE_CONFIG;
    if (custom) {
      const resolved = path.resolve(custom);
      const environmentsRoot = path.dirname(path.dirname(path.dirname(path.resolve(context.environmentHome))));
      const managedRoots = [environmentsRoot, context.environmentHome, context.currentView].map((root) => path.resolve(root));
      if (!managedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) externalPaths.push(resolved);
    }
    return [{
      id: "config",
      relativePath: "opencode.json",
      target: "view",
      sources: [path.join(context.currentView, "opencode.json")],
      content: "text",
      mode: 0o600,
    }, ...[...new Set(externalPaths)].map((source, index) => ({
      id: `external-config-${index}`,
      relativePath: `external-config-${index}`,
      target: "input" as const,
      sources: [source],
      content: "text" as const,
      mode: 0o600,
    }))];
  },
  validate,
  plan,
  discover,
  diagnose(input) {
    return projectionDiagnostics(opencodeAdapter, input);
  },
};
