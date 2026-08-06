import path from "node:path";
import type { HookSpec, McpServer, Platform, SkillSpec } from "../types.js";
import type { CanonicalClosure, CanonicalOwnershipRecord } from "./canonical.js";

export type CapabilityStrategy = "symlink" | "native" | "unsupported";

export interface AgentDescriptor {
  id: Platform;
  contractRevision: 1;
  displayName: string;
  cliCommand: string;
  sourceHome: {
    environmentVariable: string;
    originalEnvironmentVariable: string;
    defaultPath: readonly string[];
    defaultRootEnvironmentVariable?: string | undefined;
    defaultRootPath?: readonly string[] | undefined;
  };
  runtimeVariables: readonly {
    name: string;
    originalName: string;
    selectedRelativePath: string;
  }[];
  capabilities: {
    skills: CapabilityStrategy;
    mcp: CapabilityStrategy;
    mcpTransports: readonly McpServer["transport"][];
    hooks: CapabilityStrategy;
  };
}

export interface AgentArtifactContext {
  environmentName: string;
  sourceHome: string;
  defaultSourceHome: string;
  environmentHome: string;
  currentView: string;
  seedFromOriginal: boolean;
  originalRuntimeVariables: Readonly<Record<string, string | undefined>>;
}

export interface NativeArtifactContract {
  id: string;
  relativePath: string;
  target: "view" | "home" | "input";
  sources: readonly string[];
  content: "text" | "opaque";
  mode: number;
  credential?: boolean | undefined;
}

export interface ArtifactSnapshot {
  contract: NativeArtifactContract;
  sourcePath: string | null;
  text: string | null;
  bytes: Uint8Array | null;
  mode: number | undefined;
}

export interface OwnedSkill {
  packageName: string;
  packageRoot: string;
  skill: SkillSpec;
}

export interface OwnedMcpServer {
  packageName: string;
  server: McpServer;
}

export interface OwnedHook {
  packageName: string;
  hook: HookSpec;
}

export interface CanonicalCapabilities {
  skills: OwnedSkill[];
  mcpServers: OwnedMcpServer[];
  hooks: OwnedHook[];
}

export interface AgentProjectionInput {
  capabilities: CanonicalCapabilities;
  previousCapabilities: CanonicalCapabilities;
  canonicalClosure: CanonicalClosure;
  artifacts: Readonly<Record<string, ArtifactSnapshot>>;
  previousManagedMcpServers: readonly string[];
  previousOwnership: readonly CanonicalOwnershipRecord[];
}

export interface ProjectionFile {
  artifactId: string;
  content: string;
}

export interface ProjectionPlan {
  files: ProjectionFile[];
  resources: {
    mcpServers: string[];
  };
  ownership: readonly CanonicalOwnershipRecord[];
}

export interface ValidationIssue {
  severity: "error" | "warning";
  capability: "skills" | "mcp" | "hooks";
  message: string;
}

export interface DiscoveryResult {
  mcpServers: string[];
  hooks: string[];
  externalMcpServers: string[];
  candidates?: readonly DiscoveryCandidate[];
}

export interface DiscoveryCandidate {
  capability: "mcp" | "hook";
  identity: string;
  name: string;
  origin: "external";
  source: string;
  secretBearing: boolean;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
}

export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  artifacts(context: AgentArtifactContext): NativeArtifactContract[];
  validate(input: AgentProjectionInput): ValidationIssue[];
  plan(input: AgentProjectionInput): ProjectionPlan;
  discover(input: AgentProjectionInput): DiscoveryResult;
  diagnose(input: AgentProjectionInput): Diagnostic[];
}

export function assertArtifactContracts(adapter: AgentAdapter, artifacts: readonly NativeArtifactContract[]): void {
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const artifact of artifacts) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(artifact.id)) {
      throw new Error(`${adapter.descriptor.displayName} Adapter declared invalid artifact id ${artifact.id || "<empty>"}`);
    }
    if (ids.has(artifact.id)) {
      throw new Error(`${adapter.descriptor.displayName} Adapter declared artifact ${artifact.id} twice`);
    }
    ids.add(artifact.id);

    const segments = artifact.relativePath.split(/[\\/]/);
    if (
      artifact.relativePath === ""
      || path.posix.isAbsolute(artifact.relativePath)
      || path.win32.isAbsolute(artifact.relativePath)
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(
        `${adapter.descriptor.displayName} Adapter declared unsafe artifact path ${artifact.relativePath || "<empty>"}`,
      );
    }
    const location = `${artifact.target}:${artifact.relativePath}`;
    if (locations.has(location)) {
      throw new Error(`${adapter.descriptor.displayName} Adapter declared artifact location ${location} twice`);
    }
    locations.add(location);

    if (!Number.isInteger(artifact.mode) || artifact.mode < 0 || artifact.mode > 0o777) {
      throw new Error(`${adapter.descriptor.displayName} Adapter declared invalid mode for artifact ${artifact.id}`);
    }
    if (artifact.credential && artifact.content !== "opaque") {
      throw new Error(`${adapter.descriptor.displayName} Adapter credential artifact ${artifact.id} must be opaque`);
    }
  }
}

export function capabilitySupportIssues(
  adapter: AgentAdapter,
  capabilities: CanonicalCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { server } of capabilities.mcpServers) {
    if (adapter.descriptor.capabilities.mcp === "unsupported") {
      issues.push({
        severity: "error",
        capability: "mcp",
        message: `${adapter.descriptor.displayName} Adapter does not support MCP server ${server.name}`,
      });
    } else if (!adapter.descriptor.capabilities.mcpTransports.includes(server.transport)) {
      issues.push({
        severity: "error",
        capability: "mcp",
        message: `${adapter.descriptor.displayName} Adapter does not support ${server.transport} MCP server ${server.name}`,
      });
    }
  }
  if (adapter.descriptor.capabilities.hooks === "unsupported") {
    for (const { hook } of capabilities.hooks) {
      issues.push({
        severity: "error",
        capability: "hooks",
        message: `${adapter.descriptor.displayName} Adapter does not support Hook ${hook.event}`,
      });
    }
  }
  return issues;
}

export function artifactSnapshot(input: AgentProjectionInput, id: string): ArtifactSnapshot {
  const snapshot = input.artifacts[id];
  if (!snapshot) throw new Error(`Agent Adapter input is missing artifact ${id}`);
  return snapshot;
}

export function artifactText(input: AgentProjectionInput, id: string): { content: string | null; path: string } {
  const snapshot = artifactSnapshot(input, id);
  return { content: snapshot.text, path: snapshot.sourcePath ?? snapshot.contract.relativePath };
}

export function projectionDiagnostics(adapter: AgentAdapter, input: AgentProjectionInput): Diagnostic[] {
  const diagnostics = adapter.validate(input).map((issue) => ({ severity: issue.severity, message: issue.message }));
  try {
    // Planning is pure. Running it during diagnosis makes native ownership
    // conflicts visible before publication without adding filesystem effects
    // to an Adapter.
    adapter.plan(input);
    for (const previous of input.previousOwnership) {
      if (
        !previous.identity
        || !previous.packageOwner
        || !previous.nativeLocator
        || !/^sha256:[a-f0-9]{64}$/.test(previous.valueDigest)
      ) {
        diagnostics.push({ severity: "error", message: "Invalid previous ownership record" });
      }
    }
  } catch (error) {
    diagnostics.push({ severity: "error", message: (error as Error).message });
  }
  return diagnostics;
}
