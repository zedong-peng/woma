import { getStaticTOMLValue, parseForESLint, type AST } from "toml-eslint-parser";
import { applyEdits, modify, parse as parseJson, type ParseError } from "jsonc-parser";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AGENTS, type Agent, type EnvironmentLock, type McpServer, type PackageRecord } from "./types.js";

type Key = (string | number)[];
const startsWith = (full: Key, prefix: Key) => prefix.length <= full.length && prefix.every((v, i) => v === full[i]);
const keys = (entry: AST.TOMLKeyValue): string[] => entry.key.keys.map((k) => k.type === "TOMLBare" ? k.name : k.value);
const normalized = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
export const sameValue = (a: unknown, b: unknown) => isDeepStrictEqual(normalized(a), normalized(b));

function tomlKey(key: string): string { return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key); }

export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).replaceAll("\x7f", "\\u007f");
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOML numbers must be finite");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length ? `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(", ")} }` : "{}";
  }
  throw new Error("Unsupported native TOML value");
}

function setNested(object: Record<string, unknown>, target: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = target;
  const next = { ...object };
  if (!rest.length) {
    if (value === undefined) delete next[head!]; else next[head!] = value;
    return next;
  }
  const child = next[head!];
  if (child !== undefined && (!child || typeof child !== "object" || Array.isArray(child))) throw new Error(`Native registration conflicts with ${head}`);
  next[head!] = setNested((child ?? {}) as Record<string, unknown>, rest, value);
  return next;
}

/**
 * Set or remove one key path in a TOML document, preserving unrelated text and comments.
 * Existing definitions at or below the path (inline tables, dotted keys, or [table] headers) are replaced.
 */
export function editToml(input: string, target: string[], value: unknown): string {
  const top = parseForESLint(input).ast.body[0];
  const tables = top.body.filter((t): t is AST.TOMLTable => t.type === "TOMLTable");
  const edits: { start: number; end: number; text: string }[] = [];
  const lineStart = (offset: number) => input.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = (offset: number) => { const end = input.indexOf("\n", offset); return end === -1 ? input.length : end + 1; };
  function removeLines(start: number, end: number, blankLines = false) {
    const from = lineStart(start);
    let to = lineEnd(end);
    const whole = input.slice(from, start).trim() === "" && /^\s*(?:#.*)?\r?\n?$/.test(input.slice(end, to));
    if (whole && blankLines) while (to < input.length && /^[ \t]*\r?\n/.test(input.slice(to))) to = lineEnd(to);
    edits.push(whole ? { start: from, end: to, text: "" } : { start, end, text: "" });
  }
  let placed = false;
  const removedTables = new Set<AST.TOMLTable>();
  for (const table of tables) {
    if (!startsWith(table.resolvedKey, target)) continue;
    if (table.kind !== "standard") throw new Error(`Native registration conflicts with an array of tables at ${target.join(".")}`);
    removedTables.add(table);
    removeLines(table.range[0], table.range[1], true);
  }
  function scan(body: (AST.TOMLKeyValue | AST.TOMLTable)[], base: Key) {
    for (const entry of body) {
      if (entry.type !== "TOMLKeyValue") continue;
      const full = [...base, ...keys(entry)];
      if (startsWith(full, target)) {
        if (full.length === target.length && value !== undefined && !placed) {
          edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: tomlValue(value) });
          placed = true;
        } else removeLines(entry.range[0], entry.range[1]);
      } else if (startsWith(target, full)) {
        if (entry.value.type !== "TOMLInlineTable") throw new Error(`Native registration conflicts with ${full.join(".")}`);
        const current = getStaticTOMLValue(entry.value) as Record<string, unknown>;
        edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: tomlValue(setNested(current, target.slice(full.length), value)) });
        placed = true;
      }
    }
  }
  scan(top.body, []);
  for (const table of tables) if (!removedTables.has(table)) scan(table.body, table.resolvedKey);
  if (value !== undefined && !placed) {
    let scope: AST.TOMLTable | undefined;
    for (const table of tables) {
      if (!removedTables.has(table) && table.kind === "standard" && startsWith(target, table.resolvedKey) && table.resolvedKey.length < target.length && table.resolvedKey.length > (scope?.resolvedKey.length ?? 0)) scope = table;
    }
    const relative = target.slice(scope?.resolvedKey.length ?? 0);
    const assignment = `${relative.map(tomlKey).join(".")} = ${tomlValue(value)}\n`;
    let offset: number;
    if (scope) offset = lineEnd(scope.range[1]);
    else offset = tables.find((t) => !removedTables.has(t))?.range[0] ?? input.length;
    if (!scope && offset < input.length) offset = lineStart(offset);
    const prefix = offset > 0 && input[offset - 1] !== "\n" ? "\n" : "";
    const separator = !scope && offset < input.length ? "\n" : "";
    edits.push({ start: offset, end: offset, text: prefix + assignment + separator });
  }
  let output = input;
  for (const edit of edits.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start))) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  parseForESLint(output);
  return output;
}

export type ConfigFormat = "toml" | "json";

export function readNativeConfig(format: ConfigFormat, input: string): Record<string, unknown> {
  if (format === "toml") return normalized(getStaticTOMLValue(parseForESLint(input).ast)) as Record<string, unknown>;
  const errors: ParseError[] = [];
  const value: unknown = parseJson(input || "{}", errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native JSON configuration");
  return value as Record<string, unknown>;
}

function property(object: unknown, path: string[]): unknown {
  let value = object;
  for (const key of path) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Native registration parent is not a table: ${path.join(".")}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export const agentHome = (agent: Agent) => `home/${agent}`;
export function nativeConfigPath(agent: Agent): string { return agent === "codex" ? "home/codex/config.toml" : "home/claude/settings.json"; }
export function pluginId(record: PackageRecord): string { return `${record.plugin!.name}@${record.plugin!.harness === "codex" ? "woma" : "skills-dir"}`; }
export const marketplacePath = ".woma/marketplace/.agents/plugins/marketplace.json";

export function pluginInstallationPaths(record: PackageRecord): string[] {
  const plugin = record.plugin;
  if (!plugin) return [];
  return plugin.harness === "claude" ? [`home/claude/skills/${plugin.name}`] : [
    `.woma/marketplace/plugins/${plugin.name}`, `home/codex/plugins/cache/woma/${plugin.name}/${plugin.version}`,
  ];
}

/** The native value Woma writes for an MCP server, per agent. Secrets are referenced by variable name only. */
export function nativeMcpServer(agent: Agent, server: McpServer): Record<string, unknown> {
  if (agent === "codex") {
    if (server.url) return { url: server.url, ...(server.bearer_token_env_var ? { bearer_token_env_var: server.bearer_token_env_var } : {}) };
    return { command: server.command, ...(server.args?.length ? { args: server.args } : {}), ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
      ...(server.env_vars?.length ? { env_vars: server.env_vars } : {}) };
  }
  // Claude Code passes its own environment to stdio servers, so env_vars need no entry.
  if (server.url) return { type: "http", url: server.url, ...(server.bearer_token_env_var ? { headers: { Authorization: `Bearer \${${server.bearer_token_env_var}}` } } : {}) };
  return { type: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {} };
}

export interface ConfigFile { agent: Agent; path: string; format: ConfigFormat; plugins: boolean; mcp: string[] | undefined }
export function configFiles(agent: Agent): ConfigFile[] {
  return agent === "codex"
    ? [{ agent, path: "home/codex/config.toml", format: "toml", plugins: true, mcp: ["mcp_servers"] }]
    : [{ agent, path: "home/claude/settings.json", format: "json", plugins: true, mcp: undefined }, { agent, path: "home/claude/.claude.json", format: "json", plugins: false, mcp: ["mcpServers"] }];
}

function lockPlugins(lock: EnvironmentLock | undefined, agent: Agent): PackageRecord[] {
  if (!lock || !lock.recipe.agents.includes(agent)) return [];
  return Object.values(lock.packages).filter((p) => p.plugin?.harness === agent);
}

export function lockMcpServers(lock: EnvironmentLock | undefined, agent: Agent): Map<string, Record<string, unknown>> {
  const servers = new Map<string, Record<string, unknown>>();
  if (!lock || !lock.recipe.agents.includes(agent)) return servers;
  for (const [name, server] of Object.entries(lock.recipe.mcp_servers)) {
    if (!server.agents || server.agents.includes(agent)) servers.set(name, nativeMcpServer(agent, server));
  }
  return servers;
}

/**
 * Reconcile Woma's registrations in one native configuration file.
 * Only keys Woma owns are edited; a key the user changed natively is never overwritten silently.
 */
export function reconcileConfigFile(file: ConfigFile, prefix: string, input: string, previous: EnvironmentLock | undefined, next: EnvironmentLock | undefined): string {
  const before = file.plugins ? lockPlugins(previous, file.agent) : [];
  const after = file.plugins ? lockPlugins(next, file.agent) : [];
  const oldMcp = file.mcp ? lockMcpServers(previous, file.agent) : new Map();
  const newMcp = file.mcp ? lockMcpServers(next, file.agent) : new Map();
  if (!before.length && !after.length && !oldMcp.size && !newMcp.size) return input;
  const parsed = readNativeConfig(file.format, input);
  let output = input;
  function edit(path: string[], value: unknown) {
    output = file.format === "toml" ? editToml(output, path, value)
      : applyEdits(output || "{}", modify(output || "{}", path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (file.plugins && file.agent === "codex") {
    const source = property(parsed, ["marketplaces", "woma", "source"]);
    const type = property(parsed, ["marketplaces", "woma", "source_type"]);
    const expected = path.join(prefix, ".woma/marketplace");
    if (before.length && (source !== expected || type !== "local")) throw new Error("Native marketplace registration drift: marketplaces.woma");
    if (!before.length && (source !== undefined || type !== undefined)) throw new Error("Native marketplace name woma is already in use");
    if (before.length === 0 && after.length) {
      edit(["marketplaces", "woma", "source_type"], "local");
      edit(["marketplaces", "woma", "source"], expected);
    } else if (before.length && after.length === 0) edit(["marketplaces", "woma"], undefined);
  }
  const oldIds = new Set(before.map(pluginId));
  const nextIds = new Set(after.map(pluginId));
  for (const id of new Set([...oldIds, ...nextIds])) {
    const key = file.agent === "codex" ? ["plugins", id, "enabled"] : ["enabledPlugins", id];
    const enabled = property(parsed, key);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`Invalid native plugin enable state: ${id}`);
    if (!nextIds.has(id)) edit(key, undefined);
    // Installing a plugin is an explicit request to use it; later native enable/disable choices are preserved.
    else if (!oldIds.has(id) && enabled === undefined) edit(key, true);
  }
  for (const name of new Set([...oldMcp.keys(), ...newMcp.keys()])) {
    const key = [...file.mcp!, name];
    const current = property(parsed, key);
    const was = oldMcp.get(name);
    const wanted = newMcp.get(name);
    if (wanted) {
      if (was && sameValue(was, wanted)) continue;
      if (was && current !== undefined && !sameValue(current, was) && !sameValue(current, wanted)) throw new Error(`MCP server ${name} was changed in ${file.path} outside Woma; restore it or remove it with woma mcp remove ${name}`);
      if (!sameValue(current, wanted)) edit(key, wanted);
    } else if (current !== undefined && sameValue(current, was)) edit(key, undefined);
  }
  readNativeConfig(file.format, output);
  return output;
}

/** Report Woma-owned registrations that no longer match the environment. */
export function configDrift(file: ConfigFile, input: string, lock: EnvironmentLock): string[] {
  const issues: string[] = [];
  const servers = file.mcp ? lockMcpServers(lock, file.agent) : new Map();
  if (!servers.size) return issues;
  const parsed = readNativeConfig(file.format, input);
  for (const [name, wanted] of servers) {
    if (!sameValue(property(parsed, [...file.mcp!, name]), wanted)) issues.push(`MCP server ${name} differs from the environment in ${file.path}`);
  }
  return issues;
}

export function codexMarketplace(packages: PackageRecord[]): string {
  return `${JSON.stringify({ name: "woma", plugins: packages.filter((p) => p.plugin?.harness === "codex").map((p) => ({
    name: p.plugin!.name, source: { source: "local", path: `./plugins/${p.plugin!.name}` },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity",
  })) }, null, 2)}\n`;
}

export function presentAgents(lock: EnvironmentLock): Agent[] { return AGENTS.filter((agent) => lock.recipe.agents.includes(agent)); }
