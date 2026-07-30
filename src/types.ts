export type Platform = "codex" | "claude" | "pi" | "qoder";
export type CodexClaudePlatform = Exclude<Platform, "pi" | "qoder">;
export type ConfigurablePlatform = Exclude<Platform, "pi">;

export interface EnvironmentRequirement {
  name: string;
  description?: string | undefined;
  optional: boolean;
}

export interface SkillSpec {
  name: string;
  path: string;
}

export interface PackageDependency {
  name: string;
  version: string;
  source: string;
}

export interface SkillEntrypoint {
  name: string;
  skill: string;
  description: string;
}

export interface StdioMcpServer {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: string[];
  platforms?: Platform[] | undefined;
}

export interface RemoteMcpServer {
  name: string;
  transport: "http" | "sse" | "ws";
  url: string;
  headers: Record<string, string>;
  platforms?: Platform[] | undefined;
}

export type McpServer = StdioMcpServer | RemoteMcpServer;

export interface HookSpec {
  event: string;
  matcher?: string | undefined;
  command: string;
  timeout?: number | undefined;
  platforms?: Platform[] | undefined;
}

export interface WomaManifest {
  apiVersion: "woma.dev/v1";
  kind: "Woma";
  metadata: {
    name: string;
    version: string;
    description: string;
    tags: string[];
  };
  spec: {
    platforms: Platform[];
    requirements: {
      env: EnvironmentRequirement[];
      commands: string[];
    };
    dependencies: PackageDependency[];
    entrypoints: SkillEntrypoint[];
    skills: SkillSpec[];
    mcpServers: McpServer[];
    hooks: HookSpec[];
  };
}

export interface LockedPackage {
  name: string;
  version: string;
  source: string;
  commit?: string | undefined;
  subdirectory?: string | undefined;
  /** Legacy lock compatibility. New locks use commit for Git Packages. */
  resolved?: string | undefined;
  /** Legacy lock compatibility. New locks do not preserve moving refs. */
  requestedRef?: string | undefined;
  integrity: string;
  cacheKey: string;
  dependencies: string[];
  installedAt: string;
}

export interface LockFile {
  lockfileVersion: 1;
  packages: Record<string, LockedPackage>;
}

export interface EnvironmentRoot {
  name: string;
  source: string;
}

export interface WomaEnvironment {
  kind: "WomaEnvironment";
  metadata: {
    name: string;
  };
  spec: {
    targets: Platform[];
    roots: EnvironmentRoot[];
  };
}

export interface InstalledPackage {
  manifest: WomaManifest;
  root: string;
  lock: LockedPackage;
}

export interface Action {
  verb: "create" | "merge" | "adopt" | "remove" | "keep";
  path: string;
  detail: string;
}
