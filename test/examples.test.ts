import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createEnvironment, doctorEnvironment, installPackages, readEnvironment } from "../src/environment.js";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { resolvePackage } from "../src/package.js";
import { parseRecipeInput } from "../src/schema.js";
import { fixture } from "./helpers.js";

test("shipped examples use the minimal format and install through native layouts", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { agents: ["claude", "codex"] });
  for (const name of ["auto-research", "performance-engineering", "reproducibility-core", "woma-package-builder", "native-codex-review", "native-claude-review"]) {
    await installPackages(f.prefix, [path.resolve("examples", name)]);
  }
  assert.ok((await readEnvironment(f.prefix)).lock.packages["paper-search"]);
  assert.deepEqual(await doctorEnvironment(f.prefix), []);
  assert.equal((await readEnvironment(f.prefix)).lock.packages["native-claude-review"]!.plugin?.harness, "claude");
  await assert.rejects(resolvePackage(path.resolve("test/fixtures/source-adapter/native")), /woma.yaml accepts only/);
});

test("the example environment file is valid", async () => {
  const recipe = parseRecipeInput(parseYaml(await readFile("examples/research-harness/environment.yaml", "utf8")));
  assert.deepEqual(recipe.agents, ["claude", "codex"]);
  assert.equal(recipe.packages.length, 3);
  assert.deepEqual(recipe.mcp_servers.github?.env_vars, ["GITHUB_TOKEN"]);
});
