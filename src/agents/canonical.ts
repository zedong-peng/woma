import { createHash } from "node:crypto";
import type { HookSpec, InstalledPackage, McpServer, Platform, WomaManifest } from "../types.js";
import type { CanonicalCapabilities, OwnedHook, OwnedMcpServer, OwnedSkill } from "./adapter.js";

export const CANONICAL_SCHEMA_REVISION = "capabilities-v1";

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function equal(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

export interface CanonicalOwnershipRecord {
  capability: "mcp" | "hook" | "skill";
  identity: string;
  packageOwner: string;
  nativeLocator: string;
  valueDigest: string;
}

export interface CanonicalClosure {
  schemaRevision: typeof CANONICAL_SCHEMA_REVISION;
  packages: {
    identity: string;
    name: string;
    version: string;
    source: string;
    integrity: string;
  }[];
  skills: {
    identity: string;
    name: string;
    packageOwner: string;
  }[];
  mcpServers: {
    identity: string;
    name: string;
    packageOwner: string;
    transport: McpServer["transport"];
    value: unknown;
  }[];
  hooks: {
    identity: string;
    event: string;
    matcher?: string;
    packageOwner: string;
    value: unknown;
  }[];
  requirements: {
    env: { name: string; description?: string; optional: boolean }[];
    commands: string[];
  };
  entrypoints: { name: string; skill: string; description: string; packageOwner: string }[];
  digest: string;
}

function canonicalPackage(pkg: InstalledPackage): CanonicalClosure["packages"][number] {
  return {
    identity: `package:${pkg.lock.name}@${pkg.lock.version}`,
    name: pkg.lock.name,
    version: pkg.lock.version,
    source: pkg.lock.source,
    integrity: pkg.lock.integrity,
  };
}

function canonicalMcp(server: McpServer): unknown {
  const { platforms: _platforms, ...value } = server;
  return value;
}

function canonicalHookValue(hook: HookSpec): unknown {
  const { platforms: _platforms, ...value } = hook;
  return value;
}

/**
 * Build the Agent-neutral, reproducible closure. Platform selectors are a
 * compatibility concern and deliberately do not appear in this projection.
 */
export function canonicalClosure(packages: InstalledPackage[]): CanonicalClosure {
  const orderedPackages = [...packages].sort((left, right) => canonicalPackage(left).identity.localeCompare(canonicalPackage(right).identity));
  const packageRecords = orderedPackages.map(canonicalPackage);
  const skills: CanonicalClosure["skills"] = [];
  const mcpServers: CanonicalClosure["mcpServers"] = [];
  const hooks: CanonicalClosure["hooks"] = [];
  const requirements = { env: [] as CanonicalClosure["requirements"]["env"], commands: [] as string[] };
  const entrypoints: CanonicalClosure["entrypoints"] = [];
  const skillNames = new Map<string, string>();
  const mcpValues = new Map<string, string>();
  const hookIdentities = new Set<string>();

  for (const pkg of orderedPackages) {
    for (const skill of pkg.manifest.spec.skills) {
      const identity = `skill:${skill.name}`;
      const previous = skillNames.get(skill.name);
      if (previous && previous !== pkg.lock.name) throw new Error(`Skill ${skill.name} is provided by both ${previous} and ${pkg.lock.name}`);
      if (!previous) {
        skillNames.set(skill.name, pkg.lock.name);
        skills.push({ identity, name: skill.name, packageOwner: pkg.lock.name });
      }
    }
    for (const server of pkg.manifest.spec.mcpServers) {
      const identity = `mcp:${server.name}`;
      const value = canonicalMcp(server);
      const digest = stable(value);
      const previous = mcpValues.get(server.name);
      if (previous && previous !== digest) throw new Error(`MCP server ${server.name} has conflicting canonical values`);
      if (!previous) {
        mcpValues.set(server.name, digest);
        mcpServers.push({ identity, name: server.name, packageOwner: pkg.lock.name, transport: server.transport, value });
      }
    }
    for (const hook of pkg.manifest.spec.hooks) {
      const identity = `hook:${hook.event}:${hook.matcher ?? "*"}:${hook.command}`;
      if (!hookIdentities.has(identity)) {
        hookIdentities.add(identity);
        hooks.push({ identity, event: hook.event, ...(hook.matcher ? { matcher: hook.matcher } : {}), packageOwner: pkg.lock.name, value: canonicalHookValue(hook) });
      }
    }
    requirements.env.push(...pkg.manifest.spec.requirements.env.map((item) => ({
      name: item.name,
      ...(item.description !== undefined ? { description: item.description } : {}),
      optional: item.optional,
    })));
    requirements.commands.push(...pkg.manifest.spec.requirements.commands);
    entrypoints.push(...pkg.manifest.spec.entrypoints.map((entrypoint) => ({ ...entrypoint, packageOwner: pkg.lock.name })));
  }

  skills.sort((left, right) => left.identity.localeCompare(right.identity));
  mcpServers.sort((left, right) => left.identity.localeCompare(right.identity));
  hooks.sort((left, right) => left.identity.localeCompare(right.identity));
  requirements.env.sort((left, right) => stable(left).localeCompare(stable(right)));
  requirements.commands = [...new Set(requirements.commands)].sort();
  entrypoints.sort((left, right) => `${left.packageOwner}:${left.name}`.localeCompare(`${right.packageOwner}:${right.name}`));

  const withoutDigest = {
    schemaRevision: CANONICAL_SCHEMA_REVISION as typeof CANONICAL_SCHEMA_REVISION,
    packages: packageRecords,
    skills,
    mcpServers,
    hooks,
    requirements,
    entrypoints,
  };
  return { ...withoutDigest, digest: canonicalDigest(withoutDigest) };
}

export function canonicalOwnershipRecords(
  capabilities: CanonicalCapabilities,
  locators: { mcp: string; hooks: string },
): CanonicalOwnershipRecord[] {
  return [
    ...capabilities.mcpServers.map(({ packageName, server }) => ({
      capability: "mcp" as const,
      identity: `mcp:${server.name}`,
      packageOwner: packageName,
      nativeLocator: `${locators.mcp}.${server.name}`,
      valueDigest: canonicalDigest(canonicalMcp(server)),
    })),
    ...capabilities.hooks.map(({ packageName, hook }) => ({
      capability: "hook" as const,
      identity: `hook:${hook.event}:${hook.matcher ?? "*"}:${hook.command}`,
      packageOwner: packageName,
      nativeLocator: `${locators.hooks}.${hook.event}${hook.matcher ? `:${hook.matcher}` : ""}`,
      valueDigest: canonicalDigest(canonicalHookValue(hook)),
    })),
  ].sort((left, right) => left.identity.localeCompare(right.identity));
}

export function appliesTo(platform: Platform, platforms?: Platform[]): boolean {
  return !platforms || platforms.includes(platform);
}

function canonicalServer(server: McpServer): unknown {
  const { platforms: _platforms, ...value } = server;
  return value;
}

function canonicalHook(hook: HookSpec): unknown {
  const { platforms: _platforms, ...value } = hook;
  return value;
}

export function canonicalCapabilities(packages: InstalledPackage[], platform: Platform): CanonicalCapabilities {
  const skills: OwnedSkill[] = [];
  const mcpServers: OwnedMcpServer[] = [];
  const hooks: OwnedHook[] = [];
  const skillOwners = new Map<string, string>();
  const serverOwners = new Map<string, OwnedMcpServer>();

  for (const pkg of packages) {
    for (const skill of pkg.manifest.spec.skills) {
      const owner = skillOwners.get(skill.name);
      if (owner) throw new Error(`Skill ${skill.name} is provided by both ${owner} and ${pkg.lock.name}`);
      skillOwners.set(skill.name, pkg.lock.name);
      skills.push({ packageName: pkg.lock.name, packageRoot: pkg.root, skill });
    }

    for (const server of pkg.manifest.spec.mcpServers.filter((item) => appliesTo(platform, item.platforms))) {
      const previous = serverOwners.get(server.name);
      if (previous && !equal(canonicalServer(previous.server), canonicalServer(server))) {
        throw new Error(`MCP server ${server.name} conflicts between ${previous.packageName} and ${pkg.lock.name}`);
      }
      if (!previous) {
        const owned = { packageName: pkg.lock.name, server };
        serverOwners.set(server.name, owned);
        mcpServers.push(owned);
      }
    }

    for (const hook of pkg.manifest.spec.hooks.filter((item) => appliesTo(platform, item.platforms))) {
      if (!hooks.some((item) => equal(canonicalHook(item.hook), canonicalHook(hook)))) {
        hooks.push({ packageName: pkg.lock.name, hook });
      }
    }
  }

  return { skills, mcpServers, hooks };
}

export function manifestCapabilities(
  manifest: WomaManifest,
  packageRoot: string,
  platform: Platform,
): CanonicalCapabilities {
  const packageName = manifest.metadata.name;
  return {
    skills: manifest.spec.skills.map((skill) => ({ packageName, packageRoot, skill })),
    mcpServers: manifest.spec.mcpServers
      .filter((server) => appliesTo(platform, server.platforms))
      .map((server) => ({ packageName, server })),
    hooks: manifest.spec.hooks
      .filter((hook) => appliesTo(platform, hook.platforms))
      .map((hook) => ({ packageName, hook })),
  };
}
