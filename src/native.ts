import { getStaticTOMLValue, parseForESLint, type AST } from "toml-eslint-parser";
import { applyEdits, modify, parse as parseJson, type ParseError } from "jsonc-parser";
import path from "node:path";
import { satisfies } from "semver";
import type { Harness, PackageRecord } from "./types.js";

type Key = (string | number)[];
const prefixOf = (a: Key, b: Key) => a.length <= b.length && a.every((v, i) => v === b[i]);
const keys = (entry: AST.TOMLKeyValue): string[] => entry.key.keys.map((k) => k.type === "TOMLBare" ? k.name : k.value);

function tomlValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`).join(", ")} }`;
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  throw new Error("Unsupported native TOML registration value");
}

export function editToml(input: string, target: string[], value: unknown): string {
  const ast = parseForESLint(input).ast;
  const tables = ast.body[0].body;
  let table: AST.TOMLTopLevelTable | AST.TOMLTable = ast.body[0];
  let scope: Key = [];
  for (const candidate of tables) {
    if (candidate.type === "TOMLTable" && prefixOf(candidate.resolvedKey, target) && candidate.resolvedKey.length > scope.length) {
      if (candidate.kind !== "standard") throw new Error("Native registration conflicts with an array of tables");
      table = candidate; scope = candidate.resolvedKey;
    }
  }
  function inBody(body: (AST.TOMLKeyValue | AST.TOMLTable)[], base: Key, inline?: AST.TOMLInlineTable): string | undefined {
    for (const [index, entry] of body.entries()) {
      if (entry.type !== "TOMLKeyValue") continue;
      const full = [...base, ...keys(entry)];
      if (!prefixOf(full, target)) continue;
      if (full.length === target.length) {
        if (value !== undefined) return input.slice(0, entry.value.range[0]) + tomlValue(value) + input.slice(entry.value.range[1]);
        let [start, end] = entry.range;
        if (inline) {
          const next = body[index + 1];
          const previous = body[index - 1];
          if (next) end = next.range[0];
          else if (previous) start = previous.range[1];
        }
        return input.slice(0, start) + input.slice(end);
      }
      if (entry.value.type !== "TOMLInlineTable") throw new Error(`Native registration conflicts with ${full.join(".")}`);
      return inBody(entry.value.body, full, entry.value);
    }
    if (value === undefined) return input;
    const assignment = `${target.slice(base.length).map((k) => JSON.stringify(k)).join(".")} = ${tomlValue(value)}`;
    if (inline) {
      const offset = inline.range[1] - 1;
      return input.slice(0, offset) + `${body.length ? ", " : ""}${assignment}` + input.slice(offset);
    }
    return undefined;
  }
  const result = inBody(table.body, scope);
  if (result !== undefined) { parseForESLint(result); return result; }
  const assignment = `${target.slice(scope.length).map((k) => JSON.stringify(k)).join(".")} = ${tomlValue(value)}\n`;
  const firstTable = tables.find((t) => t.type === "TOMLTable");
  let offset = table.type === "TOMLTopLevelTable" ? firstTable?.range[0] ?? input.length : input.indexOf("\n", table.range[1]);
  if (offset === -1) offset = input.length;
  else if (table.type !== "TOMLTopLevelTable") offset++;
  const output = input.slice(0, offset) + (offset && input[offset - 1] !== "\n" ? "\n" : "") + assignment + input.slice(offset);
  parseForESLint(output);
  return output;
}

export function readNativeConfig(harness: Harness, input: string): Record<string, unknown> {
  if (harness === "codex") return getStaticTOMLValue(parseForESLint(input).ast) as Record<string, unknown>;
  const errors: ParseError[] = [];
  const value: unknown = parseJson(input || "{}", errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native settings.json");
  return value as Record<string, unknown>;
}

function property(object: unknown, keys: string[]): unknown {
  let value = object;
  for (const key of keys) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Native registration parent is not a table: ${keys.join(".")}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function nativeConfigPath(harness: Harness): string { return harness === "codex" ? "home/config.toml" : "home/settings.json"; }
export function pluginId(record: PackageRecord): string { return `${record.plugin!.name}@${record.plugin!.harness === "codex" ? "woma" : "skills-dir"}`; }
export const marketplacePath = ".woma/marketplace/.agents/plugins/marketplace.json";

export function pluginInstallationPaths(record: PackageRecord): string[] {
  const plugin = record.plugin;
  if (!plugin) return [];
  return plugin.harness === "claude" ? [`home/skills/${plugin.name}`] : [
    `.woma/marketplace/plugins/${plugin.name}`, `home/plugins/cache/woma/${plugin.name}/${plugin.version}`,
  ];
}

export function validateNativeContract(record: PackageRecord, version: string): void {
  if (!record.plugin) return;
  const minimum = record.plugin.harness === "codex" ? "0.154.0" : "2.1.269";
  if (!satisfies(version, `>=${minimum}`, { includePrerelease: true })) throw new Error(`${record.plugin.harness} native plugins require runtime >=${minimum}; ${version} has no verified Woma adapter contract`);
}

export function reconcileNativeConfig(harness: Harness, prefix: string, input: string, previous: PackageRecord[], next: PackageRecord[]): string {
  const before = previous.filter((p) => p.plugin);
  const after = next.filter((p) => p.plugin);
  if (!before.length && !after.length) return input;
  const parsed = readNativeConfig(harness, input);
  let output = input;
  function edit(keys: string[], value: unknown) {
    output = harness === "codex" ? editToml(output, keys, value) : applyEdits(output || "{}", modify(output || "{}", keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (harness === "codex") {
    const source = property(parsed, ["marketplaces", "woma", "source"]);
    const type = property(parsed, ["marketplaces", "woma", "source_type"]);
    const expected = path.join(prefix, ".woma/marketplace");
    if (before.length && (source !== expected || type !== "local")) throw new Error("Native marketplace registration drift: marketplaces.woma");
    if (!before.length && (source !== undefined || type !== undefined)) throw new Error("Native marketplace name woma is already in use");
    if (before.length === 0 && after.length) {
      edit(["marketplaces", "woma", "source_type"], "local");
      edit(["marketplaces", "woma", "source"], expected);
    } else if (before.length && after.length === 0) {
      edit(["marketplaces", "woma", "source_type"], undefined);
      edit(["marketplaces", "woma", "source"], undefined);
    }
  }
  const oldIds = new Set(before.map(pluginId));
  const nextIds = new Set(after.map(pluginId));
  for (const id of new Set([...oldIds, ...nextIds])) {
    const key = harness === "codex" ? ["plugins", id, "enabled"] : ["enabledPlugins", id];
    const enabled = property(parsed, key);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error(`Invalid native plugin enable state: ${id}`);
    if (!nextIds.has(id)) edit(key, undefined);
    else if (!oldIds.has(id) && enabled === undefined) edit(key, false);
  }
  readNativeConfig(harness, output);
  return output;
}

export function codexMarketplace(packages: PackageRecord[]): string {
  return `${JSON.stringify({ name: "woma", plugins: packages.filter((p) => p.plugin?.harness === "codex").map((p) => ({
    name: p.plugin!.name, source: { source: "local", path: `./plugins/${p.plugin!.name}` },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity",
  })) }, null, 2)}\n`;
}
