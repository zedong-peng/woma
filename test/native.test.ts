import assert from "node:assert/strict";
import test from "node:test";
import { editToml, readNativeConfig, reconcileNativeConfig } from "../src/native.js";

test("TOML registration edits preserve comments, multiline strings, inline tables, and unrelated fields", () => {
  const original = '# keep\nmodel = """line one\n[not-a-table]\nline three"""\nplugins = { "p@woma" = { enabled = true, note = "keep" }, external = { enabled = true } }\n';
  const updated = editToml(original, ["plugins", "p@woma", "enabled"], false);
  assert.match(updated, /# keep/);
  assert.match(updated, /\[not-a-table\]/);
  const data = readNativeConfig("codex", updated) as { plugins: Record<string, { enabled?: boolean; note?: string }> };
  assert.equal(data.plugins["p@woma"]!.enabled, false);
  assert.equal(data.plugins.external!.enabled, true);
  const removed = editToml(updated, ["plugins", "p@woma", "enabled"], undefined);
  assert.equal((readNativeConfig("codex", removed).plugins as typeof data.plugins)["p@woma"]!.note, "keep");
  const inserted = editToml(removed, ["plugins", "p@woma", "enabled"], true);
  assert.equal((readNativeConfig("codex", inserted).plugins as typeof data.plugins)["p@woma"]!.enabled, true);
});

test("TOML insertions respect existing table scope and quoted keys", () => {
  let text = 'model = "x"\n[plugins."external@market"]\nenabled = true # retained\n';
  text = editToml(text, ["marketplaces", "woma", "source_type"], "local");
  text = editToml(text, ["marketplaces", "woma", "source"], "/tmp/a 'b");
  text = editToml(text, ["plugins", "new@woma", "enabled"], false);
  text = editToml(text, ["plugins", "external@market", "note"], "keep");
  const value = readNativeConfig("codex", text) as { marketplaces: { woma: { source: string } }; plugins: Record<string, { enabled: boolean; note?: string }> };
  assert.equal(value.marketplaces.woma.source, "/tmp/a 'b");
  assert.equal(value.plugins["new@woma"]!.enabled, false);
  assert.equal(value.plugins["external@market"]!.enabled, true);
  assert.equal(value.plugins["external@market"]!.note, "keep");
  assert.match(text, /# retained/);
});

test("native reconciliation ignores config when no plugin registrations are needed", () => {
  assert.equal(reconcileNativeConfig("codex", "/tmp/env", "opaque user file", [], []), "opaque user file");
});
