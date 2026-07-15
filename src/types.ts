export type Platform = "codex" | "claude";

export interface EnvironmentRequirement {
  name: string;
  description?: string | undefined;
  optional: boolean;
}

export interface SkillSpec {
  name: string;
  path: string;
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

export interface HarnessManifest {
  apiVersion: "harness.conda/v1";
  kind: "Harness";
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
    skills: SkillSpec[];
    mcpServers: McpServer[];
    hooks: HookSpec[];
  };
}

export interface LockedPackage {
  name: string;
  version: string;
  source: string;
  resolved: string;
  integrity: string;
  cacheKey: string;
  installedAt: string;
}

export interface LockFile {
  lockfileVersion: 1;
  packages: Record<string, LockedPackage>;
}

export type ManagedArtifact =
  | {
      kind: "directory";
      path: string;
      integrity: string;
      managed: boolean;
    }
  | {
      kind: "json-entry";
      path: string;
      jsonPath: string[];
      value: unknown;
      managed: boolean;
    }
  | {
      kind: "json-array-entry";
      path: string;
      jsonPath: string[];
      value: unknown;
      managed: boolean;
    }
  | {
      kind: "toml-block";
      path: string;
      marker: string;
      block: string;
      managed: boolean;
    };

export interface ActivationRecord {
  packageName: string;
  packageVersion: string;
  packageIntegrity: string;
  packageCacheKey: string;
  activatedAt: string;
  targets: Platform[];
  artifacts: ManagedArtifact[];
}

export interface StateFile {
  stateVersion: 1;
  activations: Record<string, ActivationRecord>;
  profile?: ActiveProfileState | undefined;
}

export interface ProjectProfile {
  description: string;
  packages: string[];
  handoff: "optional" | "required";
}

export interface HarnessProject {
  apiVersion: "harness.conda/project-v1";
  kind: "HarnessProject";
  metadata: {
    name: string;
  };
  spec: {
    agent: Platform;
    targets: Platform[];
    base: string[];
    profiles: Record<string, ProjectProfile>;
    bindings: Record<string, string>;
    handoffDirectory: string;
  };
}

export interface ActiveInstruction {
  path: string;
  block: string;
}

export interface ActiveProfileState {
  name: string;
  packages: string[];
  targets: Platform[];
  activatedAt: string;
  instructions: ActiveInstruction[];
  handoff?: string | undefined;
}

export interface InstalledPackage {
  manifest: HarnessManifest;
  root: string;
  lock: LockedPackage;
}

export interface Action {
  verb: "create" | "merge" | "adopt" | "remove" | "keep";
  path: string;
  detail: string;
}
