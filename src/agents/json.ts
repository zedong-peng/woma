import type { HookSpec, McpServer } from "../types.js";
import { equal } from "./canonical.js";
import type { OwnedHook, OwnedMcpServer } from "./adapter.js";

export function parseJsonObject(content: string | null, filePath: string): Record<string, unknown> {
  if (content === null || content.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${filePath}: ${(error as Error).message}`);
  }
}

function objectAt(root: Record<string, unknown>, key: string, filePath: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cannot merge ${filePath}: ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayAt(root: Record<string, unknown>, key: string, filePath: string): unknown[] {
  const value = root[key];
  if (value === undefined) {
    const created: unknown[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(value)) throw new Error(`Cannot merge ${filePath}: ${key} must be an array`);
  return value;
}

export function hookValue(hook: HookSpec): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: "command", command: hook.command };
  if (hook.timeout !== undefined) handler.timeout = hook.timeout;
  return { ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [handler] };
}

function hookIdentity(hook: HookSpec): string {
  return `${hook.event}:${hook.matcher ?? "*"}`;
}

function existingHookIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.matcher === "string" ? record.matcher : "*";
}

export function mergeHooks(
  filePath: string,
  root: Record<string, unknown>,
  additions: OwnedHook[],
  previouslyOwned: readonly OwnedHook[] = [],
): void {
  if (additions.length === 0) return;
  const hooks = objectAt(root, "hooks", filePath);
  const previousIdentities = new Set(previouslyOwned.map(({ hook }) => hookIdentity(hook)));
  for (const { hook } of additions) {
    const eventHooks = arrayAt(hooks, hook.event, filePath);
    const value = hookValue(hook);
    const identity = hookIdentity(hook);
    const existing = eventHooks.filter((candidate) => existingHookIdentity(candidate) === (hook.matcher ?? "*"));
    if (existing.some((candidate) => !equal(candidate, value))) {
      throw new Error(`Refusing to overwrite managed ${hook.event} Hook in ${filePath}`);
    }
    if (existing.length > 0 && !previousIdentities.has(identity)) {
      throw new Error(`Refusing to implicitly adopt external ${hook.event} Hook in ${filePath}`);
    }
    if (existing.length === 0) eventHooks.push(value);
  }
}

export function removeHooks(filePath: string, root: Record<string, unknown>, removals: OwnedHook[]): void {
  if (removals.length === 0 || root.hooks === undefined) return;
  const hooks = objectAt(root, "hooks", filePath);
  for (const { hook } of removals) {
    const existing = hooks[hook.event];
    if (existing === undefined) continue;
    if (!Array.isArray(existing)) throw new Error(`Cannot merge ${filePath}: hooks.${hook.event} must be an array`);
    const desired = hookValue(hook);
    const sameIdentity = existing.filter((value) => existingHookIdentity(value) === (hook.matcher ?? "*"));
    if (sameIdentity.length > 0 && !sameIdentity.some((value) => equal(value, desired))) {
      throw new Error(`Refusing to remove modified managed ${hook.event} Hook from ${filePath}`);
    }
    const retained = existing.filter((value) => !equal(value, desired));
    if (retained.length > 0) hooks[hook.event] = retained;
    else delete hooks[hook.event];
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
}

export function claudeMcpValue(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(server.env.length > 0 ? { env: Object.fromEntries(server.env.map((name) => [name, `\${${name}}`])) } : {}),
    };
  }
  return {
    type: server.transport,
    url: server.url,
    ...(Object.keys(server.headers).length > 0
      ? { headers: Object.fromEntries(Object.entries(server.headers).map(([header, env]) => [header, `\${${env}}`])) }
      : {}),
  };
}

export function removeMcpServers(
  root: Record<string, unknown>,
  filePath: string,
  key: string,
  removals: readonly OwnedMcpServer[],
  agentName = "managed",
): void {
  if (removals.length === 0 || root[key] === undefined) return;
  const servers = objectAt(root, key, filePath);
  for (const { server } of removals) {
    const existing = servers[server.name];
    if (existing === undefined) continue;
    if (!equal(existing, claudeMcpValue(server))) {
      throw new Error(`Refusing to overwrite ${agentName} MCP server ${server.name} in ${filePath}`);
    }
    delete servers[server.name];
  }
  if (Object.keys(servers).length === 0) delete root[key];
}

export function mergeMcpServers(
  root: Record<string, unknown>,
  filePath: string,
  key: string,
  additions: OwnedMcpServer[],
  agentName: string,
  previouslyOwned: readonly OwnedMcpServer[] = [],
): void {
  if (additions.length === 0) return;
  const servers = objectAt(root, key, filePath);
  const previousNames = new Set(previouslyOwned.map(({ server }) => server.name));
  for (const { server } of additions) {
    const desired = claudeMcpValue(server);
    const existing = servers[server.name];
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite ${agentName} MCP server ${server.name} in ${filePath}`);
    }
    if (existing !== undefined && !previousNames.has(server.name)) {
      throw new Error(`Refusing to implicitly adopt external ${agentName} MCP server ${server.name} in ${filePath}`);
    }
    servers[server.name] = desired;
  }
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
