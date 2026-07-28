import assert from "node:assert/strict";
import test from "node:test";
import { parseManifest } from "../src/schema.js";

test("manifest parser applies portable defaults", () => {
  const manifest = parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: test-woma
  version: 1.2.3
  description: Test woma.
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
apiVersion: woma.dev/v1
kind: Woma
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
apiVersion: woma.dev/v1
kind: Woma
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

test("manifest parser accepts complete SemVer and rejects malformed versions", () => {
  const manifest = parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: versioned
  version: 1.2.3-rc.1+build.7
  description: Version fixture.
spec:
  skills: []
`);
  assert.equal(manifest.metadata.version, "1.2.3-rc.1+build.7");
  assert.throws(
    () =>
      parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: versioned
  version: 1.2.3-..
  description: Version fixture.
spec:
  skills: []
`),
    /must be valid SemVer/,
  );
});

test("manifest parser accepts Pi as a Package platform", () => {
  const manifest = parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: pi-skill
  version: 1.0.0
  description: Pi platform fixture.
spec:
  platforms: [codex, claude, pi]
  skills: []
`);
  assert.deepEqual(manifest.spec.platforms, ["codex", "claude", "pi"]);
});

test("manifest parser accepts Qoder as a Package platform", () => {
  const manifest = parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: qoder-skill
  version: 1.0.0
  description: Qoder platform fixture.
spec:
  platforms: [codex, claude, pi, qoder]
  skills: []
`);
  assert.deepEqual(manifest.spec.platforms, ["codex", "claude", "pi", "qoder"]);
});

test("manifest parser rejects duplicate platform declarations", () => {
  assert.throws(
    () =>
      parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: duplicate-platform
  version: 1.0.0
  description: Platform fixture.
spec:
  platforms: [codex, codex]
  skills: []
`),
    /must not contain duplicates/,
  );
});

test("manifest parser rejects legacy command bindings", () => {
  assert.throws(
    () =>
      parseManifest(`
apiVersion: woma.dev/v1
kind: Woma
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
apiVersion: woma.dev/v1
kind: Woma
metadata:
  name: Bad Name
  version: latest
  description: Test woma.
spec:
  skills: []
`),
    /metadata\.name:.*\nmetadata\.version:/,
  );
});
