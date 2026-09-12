export type Harness = "codex" | "claude";

export interface Dependency {
  name: string;
  version: string;
  source: string;
}

export interface RuntimeArtifact {
  name: string;
  version: string;
  url: string;
  integrity: string;
  directory: string;
}

export type PackageSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; commit: string; subdirectory?: string | undefined }
  | { type: "runtime"; provider: "npm"; platform: string; artifacts: RuntimeArtifact[]; executable: string };

export interface PackageRecord {
  name: string;
  version: string;
  kind: "runtime" | "skill" | "plugin" | "collection";
  source: PackageSource;
  integrity: string;
  dependencies: Dependency[];
  harnesses: Partial<Record<Harness, string | undefined>>;
  skills: { name: string; path: string }[];
  plugin?: { harness: Harness; name: string; version: string } | undefined;
}

export interface RootRequirement { name: string; source: string }

export interface EnvironmentRecipe {
  format: "woma.environment/v2";
  name: string;
  harness: Harness;
  runtime: string;
  packages: RootRequirement[];
}

export interface EnvironmentLock {
  format: "woma.lock/v2";
  platform: string;
  recipe: EnvironmentRecipe;
  packages: Record<string, PackageRecord>;
}

export interface InstalledPackage { record: PackageRecord; root: string }
export interface ManagedPath { path: string; integrity: string; package: string }
export interface EnvironmentState { format: "woma.state/v2"; lock: EnvironmentLock; paths: ManagedPath[] }

export interface Action {
  verb: "create" | "merge" | "adopt" | "remove" | "keep";
  path: string;
  detail: string;
}
