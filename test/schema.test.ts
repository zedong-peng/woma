import assert from "node:assert/strict";
import test from "node:test";
import { parseManifest } from "../src/schema.js";

test("manifest parser applies portable defaults", () => {
  const manifest = parseManifest(`
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: test-harness
  version: 1.2.3
  description: Test harness.
spec:
  skills: []
`);

  assert.deepEqual(manifest.metadata.tags, []);
  assert.deepEqual(manifest.spec.platforms, ["codex", "claude"]);
  assert.deepEqual(manifest.spec.requirements, { env: [], commands: [], bindings: [] });
  assert.deepEqual(manifest.spec.mcpServers, []);
  assert.deepEqual(manifest.spec.hooks, []);
});

test("manifest parser reports field paths", () => {
  assert.throws(
    () =>
      parseManifest(`
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: Bad Name
  version: latest
  description: Test harness.
spec:
  skills: []
`),
    /metadata\.name:.*\nmetadata\.version:/,
  );
});
