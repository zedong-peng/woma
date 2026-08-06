import type { HookSpec, InstalledPackage, McpServer, Platform, WomaManifest } from "../types.js";
import type { CanonicalCapabilities, OwnedHook, OwnedMcpServer, OwnedSkill } from "./adapter.js";

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
