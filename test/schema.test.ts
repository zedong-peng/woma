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
  assert.deepEqual(manifest.spec.dependencies, []);
  assert.deepEqual(manifest.spec.entrypoints, []);
  assert.deepEqual(manifest.spec.requirements, { env: [], commands: [] });
  assert.deepEqual(manifest.spec.mcpServers, []);
  assert.deepEqual(manifest.spec.hooks, []);
});

test("manifest parser accepts package dependencies and skill entrypoints", () => {
  const manifest = parseManifest(`
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: auto-research
  version: 1.0.0
  description: Compose a complete research method.
spec:
  dependencies:
    - name: paper-search
      version: ^1.2.0
      source: gh:example/paper-search#v1.2.0
  entrypoints:
    - name: research
      skill: auto-research
      description: Run the complete research method.
  skills:
    - name: auto-research
      path: ./skills/auto-research
`);

  assert.equal(manifest.spec.dependencies[0]?.name, "paper-search");
  assert.equal(manifest.spec.dependencies[0]?.version, "^1.2.0");
  assert.equal(manifest.spec.entrypoints[0]?.skill, "auto-research");
});

test("manifest parser rejects invalid dependency version ranges", () => {
  assert.throws(
    () =>
      parseManifest(`
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: auto-research
  version: 1.0.0
  description: Compose a complete research method.
spec:
  dependencies:
    - name: paper-search
      version: definitely-not-semver
      source: gh:example/paper-search
  skills: []
`),
    /spec\.dependencies\.0\.version: must be a valid semver range/,
  );
});

test("manifest parser rejects legacy command bindings", () => {
  assert.throws(
    () =>
      parseManifest(`
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: legacy-bindings
  version: 1.0.0
  description: Legacy binding fixture.
spec:
  requirements:
    bindings:
      - name: test
`),
    /spec\.requirements.*Unrecognized key.*bindings/s,
  );
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
