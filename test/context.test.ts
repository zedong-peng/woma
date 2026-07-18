import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activeContextPath, prepareAgentContextTransition, renderActiveContext, type AgentContextEnvironment } from "../src/context.js";
import type { HarnessEnvironment, InstalledPackage, Platform } from "../src/types.js";

function context(environmentName: string, targets: Platform[], packageName: string): AgentContextEnvironment {
  const environment: HarnessEnvironment = {
    apiVersion: "harness.conda/environment-v1",
    kind: "HarnessEnvironment",
    metadata: { name: environmentName },
    spec: { targets, roots: [{ name: packageName, source: `builtin:${packageName}` }] },
  };
  const pkg: InstalledPackage = {
    root: `/cache/${packageName}`,
    manifest: {
      apiVersion: "harness.conda/v1",
      kind: "Harness",
      metadata: { name: packageName, version: "1.2.3", description: "Context fixture.", tags: [] },
      spec: {
        platforms: targets,
        dependencies: [],
        entrypoints: [],
        requirements: { env: [], commands: [] },
        skills: [{ name: `${packageName}-skill`, path: "./skill" }],
        mcpServers: [],
        hooks: [],
      },
    },
    lock: {
      name: packageName,
      version: "1.2.3",
      source: `builtin:${packageName}`,
      resolved: "builtin",
      integrity: "sha256-fixture",
      cacheKey: "fixture",
      dependencies: [],
      installedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  return { environment, names: [packageName], packages: new Map([[packageName, pkg]]) };
}

test("Agent context exposes active package Memory without embedding its contents", () => {
  const rendered = renderActiveContext(context("performance", ["codex"], "performance-engineering"));
  assert.match(rendered, /Environment: `performance`/);
  assert.match(rendered, /\.harness\/memory\/project\.md/);
  assert.match(rendered, /\.harness\/local\/memory\.md/);
  assert.match(rendered, /\.harness\/memory\/packages\/performance-engineering\.md/);
  assert.match(rendered, /Skills: `performance-engineering-skill`/);
  assert.match(rendered, /persist it automatically.*do not explicitly ask you to remember it/);
  assert.doesNotMatch(rendered, /cmake --build|npm test/);
});

test("Agent context transition preserves user instructions and rolls back exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-agent-context-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const original = "# User instructions\n\nKeep this content.\n";
  try {
    await writeFile(agentsPath, original, "utf8");
    const prepared = await prepareAgentContextTransition(root, undefined, context("tools", ["codex"], "paper-search"));
    const rollback = await prepared.apply();

    assert.match(await readFile(activeContextPath(root), "utf8"), /paper-search@1\.2\.3/);
    assert.match(await readFile(agentsPath, "utf8"), /harness-conda:project-memory/);
    assert.match(await readFile(agentsPath, "utf8"), /Keep this content/);
    await assert.rejects(readFile(path.join(root, "CLAUDE.md"), "utf8"), /ENOENT/);

    await rollback();
    assert.equal(await readFile(agentsPath, "utf8"), original);
    await assert.rejects(readFile(activeContextPath(root), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent context switches adapters, cleans up on deactivation, and rejects discovery drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-agent-context-switch-"));
  const agentsPath = path.join(root, "AGENTS.md");
  const claudePath = path.join(root, "CLAUDE.md");
  const codex = context("codex-tools", ["codex"], "paper-search");
  const claude = context("claude-tools", ["claude"], "idea-gen");
  try {
    await (await prepareAgentContextTransition(root, undefined, codex)).apply();
    const switched = await prepareAgentContextTransition(root, codex, claude);
    await switched.apply();

    await assert.rejects(readFile(agentsPath, "utf8"), /ENOENT/);
    assert.match(await readFile(claudePath, "utf8"), /harness-conda:project-memory/);
    assert.match(await readFile(activeContextPath(root), "utf8"), /idea-gen/);

    await writeFile(claudePath, (await readFile(claudePath, "utf8")).replace("At the beginning", "At some point"), "utf8");
    await assert.rejects(prepareAgentContextTransition(root, claude, undefined), /discovery block was modified/);

    await writeFile(claudePath, (await readFile(claudePath, "utf8")).replace("At some point", "At the beginning"), "utf8");
    await rm(activeContextPath(root), { force: true });
    await assert.rejects(
      prepareAgentContextTransition(root, claude, undefined, { requirePrevious: true }),
      /active-context\.md is missing/,
    );
    await writeFile(activeContextPath(root), renderActiveContext(claude), "utf8");
    await (await prepareAgentContextTransition(root, claude, undefined)).apply();
    await assert.rejects(readFile(activeContextPath(root), "utf8"), /ENOENT/);
    await assert.rejects(readFile(claudePath, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
