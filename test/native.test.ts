import assert from "node:assert/strict";
import test from "node:test";
import { configFiles, editToml, readNativeConfig, reconcileConfigFile } from "../src/native.js";

test("TOML registration edits preserve comments, multiline strings, inline tables, and unrelated fields", () => {
  const original = '# keep\nmodel = """line one\n[not-a-table]\nline three"""\nplugins = { "p@woma" = { enabled = true, note = "keep" }, external = { enabled = true } }\n';
  const updated = editToml(original, ["plugins", "p@woma", "enabled"], false);
  assert.match(updated, /# keep/);
  assert.match(updated, /\[not-a-table\]/);
  const data = readNativeConfig("toml", updated) as { plugins: Record<string, { enabled?: boolean; note?: string }> };
  assert.equal(data.plugins["p@woma"]!.enabled, false);
  assert.equal(data.plugins.external!.enabled, true);
  const removed = editToml(updated, ["plugins", "p@woma", "enabled"], undefined);
  assert.equal((readNativeConfig("toml", removed).plugins as typeof data.plugins)["p@woma"]!.note, "keep");
  const inserted = editToml(removed, ["plugins", "p@woma", "enabled"], true);
  assert.equal((readNativeConfig("toml", inserted).plugins as typeof data.plugins)["p@woma"]!.enabled, true);
});

test("TOML insertions respect existing table scope and quoted keys", () => {
  let text = 'model = "x"\n[plugins."external@market"]\nenabled = true # retained\n';
  text = editToml(text, ["marketplaces", "woma", "source_type"], "local");
  text = editToml(text, ["marketplaces", "woma", "source"], "/tmp/a 'b");
  text = editToml(text, ["plugins", "new@woma", "enabled"], false);
  text = editToml(text, ["plugins", "external@market", "note"], "keep");
  const value = readNativeConfig("toml", text) as { marketplaces: { woma: { source: string } }; plugins: Record<string, { enabled: boolean; note?: string }> };
  assert.equal(value.marketplaces.woma.source, "/tmp/a 'b");
  assert.equal(value.plugins["new@woma"]!.enabled, false);
  assert.equal(value.plugins["external@market"]!.enabled, true);
  assert.equal(value.plugins["external@market"]!.note, "keep");
  assert.match(text, /# retained/);
});

test("TOML tables written by native tools are replaced and removed as a whole", () => {
  const original = '# top\nmodel = "m"\n\n[mcp_servers.github]\ncommand = "old"\nargs = ["a"]\n\n[mcp_servers.github.env]\nTOKEN = "x"\n\n[profiles.fast]\nmodel = "f" # mine\n';
  const server = { command: "npx", args: ["-y", "server"], env_vars: ["GITHUB_TOKEN"] };
  const replaced = editToml(original, ["mcp_servers", "github"], server);
  assert.deepEqual((readNativeConfig("toml", replaced).mcp_servers as Record<string, unknown>).github, server);
  assert.match(replaced, /# top\nmodel = "m"/);
  assert.match(replaced, /\[profiles\.fast\]\nmodel = "f" # mine/);
  assert.doesNotMatch(replaced, /"old"|TOKEN = /);
  assert.match(replaced, /^# top\nmodel = "m"\n\nmcp_servers\.github = \{[^\n]*\}\n\n\[profiles\.fast\]/);
  const removed = editToml(replaced, ["mcp_servers", "github"], undefined);
  assert.equal(readNativeConfig("toml", removed).mcp_servers, undefined);
  assert.match(removed, /\[profiles\.fast\]/);
  const scoped = editToml('[mcp_servers]\nother = { command = "o" }\n', ["mcp_servers", "github"], { command: "npx" });
  assert.match(scoped, /\[mcp_servers\]\nother = \{ command = "o" \}\ngithub = \{ command = "npx" \}\n/);
  const dotted = editToml('mcp_servers.github.command = "old"\nmcp_servers.github.args = []\n', ["mcp_servers", "github"], { command: "new" });
  assert.deepEqual(readNativeConfig("toml", dotted), { mcp_servers: { github: { command: "new" } } });
  assert.throws(() => editToml('mcp_servers = "text"\n', ["mcp_servers", "github"], { command: "x" }), /conflicts with mcp_servers/);
});

test("native reconciliation ignores config when no registrations are needed", () => {
  for (const file of [...configFiles("codex"), ...configFiles("claude")]) assert.equal(reconcileConfigFile(file, "/tmp/env", "opaque user file", undefined, undefined), "opaque user file");
});
