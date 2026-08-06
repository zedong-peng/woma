import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { McpServer } from "../types.js";
import {
  artifactText,
  capabilitySupportIssues,
  projectionDiagnostics,
  type AgentAdapter,
  type AgentProjectionInput,
  type DiscoveryResult,
  type ProjectionPlan,
  type ValidationIssue,
} from "./adapter.js";
import { canonicalOwnershipRecords, equal } from "./canonical.js";
import { jsonDocument, mergeHooks, parseJsonObject, removeHooks } from "./json.js";

function codexValue(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args,
      ...(server.env.length > 0 ? { env_vars: server.env } : {}),
    };
  }
  if (server.transport !== "http") throw new Error(`${server.transport} MCP transport is not supported by Codex`);
  return {
    url: server.url,
    ...(Object.keys(server.headers).length > 0 ? { env_http_headers: server.headers } : {}),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(", ")} }`;
}

function codexBlock(packageName: string, server: McpServer): string {
  const marker = `${packageName}:mcp:${server.name}`;
  const lines = [`# >>> woma:${marker}`, `[mcp_servers.${tomlString(server.name)}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args.length > 0) lines.push(`args = ${tomlArray(server.args)}`);
    if (server.env.length > 0) lines.push(`env_vars = ${tomlArray(server.env)}`);
  } else {
    if (server.transport !== "http") throw new Error(`${server.transport} MCP transport is not supported by Codex`);
    lines.push(`url = ${tomlString(server.url)}`);
    if (Object.keys(server.headers).length > 0) lines.push(`env_http_headers = ${tomlInlineTable(server.headers)}`);
  }
  lines.push(`# <<< woma:${marker}`);
  return lines.join("\n");
}

function withoutWomaBlocks(content: string, filePath: string, projection: AgentProjectionInput): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  const seenPreviousMarkers = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^# >>> woma:(.+:mcp:.+)$/.exec(lines[index]!);
    if (!match) {
      kept.push(lines[index]!);
      continue;
    }
    const marker = match[1]!;
    const end = `# <<< woma:${marker}`;
    const blockStart = index;
    while (index < lines.length && lines[index] !== end) index += 1;
    if (index === lines.length) throw new Error(`Cannot merge ${filePath}: unterminated Woma-managed Codex block`);
    const block = lines.slice(blockStart, index + 1).join("\n");
    const previous = projection.previousCapabilities.mcpServers.find(({ packageName, server }) => marker === `${packageName}:mcp:${server.name}`);
    if (!previous) {
      kept.push(...lines.slice(blockStart, index + 1));
      continue;
    }
    seenPreviousMarkers.add(marker);
    const expected = codexBlock(previous.packageName, previous.server);
    if (block !== expected) {
      throw new Error(`Refusing to remove modified Woma MCP block ${marker} from ${filePath}`);
    }
  }
  for (const { packageName, server } of projection.previousCapabilities.mcpServers) {
    const marker = `${packageName}:mcp:${server.name}`;
    if (!seenPreviousMarkers.has(marker)) {
      throw new Error(`Refusing to remove missing Woma MCP block ${marker} from ${filePath}`);
    }
  }
  return kept.join("\n").trimEnd();
}

export function renderCodexConfig(input: string | null, filePath: string, projection: AgentProjectionInput): string {
  const baseline = withoutWomaBlocks(input ?? "", filePath, projection);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (baseline ? parseToml(baseline) : {}) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${filePath}: ${(error as Error).message}`);
  }
  const existingServers = parsed.mcp_servers ?? {};
  if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers)) {
    throw new Error(`Cannot merge ${filePath}: mcp_servers must be a table`);
  }
  const blocks: string[] = [];
  for (const { packageName, server } of projection.capabilities.mcpServers) {
    const existing = (existingServers as Record<string, unknown>)[server.name];
    const desired = codexValue(server);
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite Codex MCP server ${server.name} from ${filePath}`);
    }
    if (
      existing !== undefined
      && !projection.previousCapabilities.mcpServers.some(({ server: previous }) => previous.name === server.name)
    ) {
      throw new Error(`Refusing to implicitly adopt external Codex MCP server ${server.name} from ${filePath}`);
    }
    if (existing === undefined) blocks.push(codexBlock(packageName, server));
  }
  const prefix = baseline ? `${baseline}\n\n` : "";
  const suffix = blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
  return `${prefix}${suffix}`;
}

function validate(input: AgentProjectionInput): ValidationIssue[] {
  return capabilitySupportIssues(codexAdapter, input.capabilities);
}

function plan(input: AgentProjectionInput): ProjectionPlan {
  const config = artifactText(input, "config");
  const hooks = artifactText(input, "hooks");
  const hooksRoot = parseJsonObject(hooks.content, hooks.path);
  removeHooks(hooks.path, hooksRoot, input.previousCapabilities.hooks);
  mergeHooks(hooks.path, hooksRoot, input.capabilities.hooks, input.previousCapabilities.hooks);
  return {
    files: [
      { artifactId: "config", content: renderCodexConfig(config.content, config.path, input) },
      { artifactId: "hooks", content: jsonDocument(hooksRoot) },
    ],
    resources: { mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name) },
    ownership: canonicalOwnershipRecords(input.capabilities, { mcp: "config.toml#mcp_servers", hooks: "hooks.json#hooks" }),
  };
}

function discover(input: AgentProjectionInput): DiscoveryResult {
  return {
    mcpServers: input.capabilities.mcpServers.map(({ server }) => server.name),
    hooks: input.capabilities.hooks.map(({ hook }) => hook.event),
    externalMcpServers: [],
  };
}

export const codexAdapter: AgentAdapter = {
  descriptor: {
    id: "codex",
    contractRevision: 1,
    displayName: "Codex",
    cliCommand: "codex",
    sourceHome: {
      environmentVariable: "CODEX_HOME",
      originalEnvironmentVariable: "WOMA_ORIGINAL_CODEX_HOME",
      defaultPath: [".codex"],
    },
    runtimeVariables: [
      { name: "CODEX_HOME", originalName: "WOMA_ORIGINAL_CODEX_HOME", selectedRelativePath: "." },
    ],
    capabilities: { skills: "symlink", mcp: "native", mcpTransports: ["stdio", "http"], hooks: "native" },
  },
  artifacts(context) {
    return [
      {
        id: "config",
        relativePath: "config.toml",
        target: "home",
        sources: [
          path.join(context.environmentHome, "config.toml"),
          ...(context.seedFromOriginal ? [path.join(context.sourceHome, "config.toml")] : []),
        ],
        content: "text",
        mode: 0o600,
      },
      {
        id: "hooks",
        relativePath: "hooks.json",
        target: "home",
        sources: [
          path.join(context.environmentHome, "hooks.json"),
          ...(context.seedFromOriginal ? [path.join(context.sourceHome, "hooks.json")] : []),
        ],
        content: "text",
        mode: 0o600,
      },
    ];
  },
  validate,
  plan,
  discover,
  diagnose(input) {
    return projectionDiagnostics(codexAdapter, input);
  },
};
