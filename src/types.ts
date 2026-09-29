export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export interface Dependency {
  name: string;
  version: string;
  source: string;
}

export type PackageSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; commit: string; subdirectory?: string | undefined };

/** A pushed Git commit whose tree is byte-identical to a local package snapshot. */
export interface GitOrigin { url: string; commit: string; subdirectory?: string | undefined }

export interface PackageRecord {
  name: string;
  version: string;
  kind: "skill" | "plugin" | "collection";
  source: PackageSource;
  integrity: string;
  dependencies: Dependency[];
  harnesses: Partial<Record<Agent, string | undefined>>;
  skills: { name: string; path: string }[];
  plugin?: { harness: Agent; name: string; version: string } | undefined;
  origin?: GitOrigin | undefined;
}

export interface RootRequirement { name: string; source: string }

export interface McpServer {
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  env_vars?: string[] | undefined;
  url?: string | undefined;
  bearer_token_env_var?: string | undefined;
  agents?: Agent[] | undefined;
}

export interface EnvironmentRecipe {
  format: "woma.environment/v3";
  name: string;
  /** The agents this environment wires up. Woma uses the claude/codex already installed; it does not manage their versions. */
  agents: Agent[];
  packages: RootRequirement[];
  mcp_servers: Record<string, McpServer>;
}

export interface EnvironmentLock {
  format: "woma.lock/v3";
  recipe: EnvironmentRecipe;
  packages: Record<string, PackageRecord>;
}

export interface InstalledPackage { record: PackageRecord; root: string }
export interface ManagedPath { path: string; integrity: string; package: string }
export interface EnvironmentState { format: "woma.state/v3"; lock: EnvironmentLock; paths: ManagedPath[] }

export interface Action {
  verb: "create" | "merge" | "adopt" | "remove" | "keep";
  path: string;
  detail: string;
}
