import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProject } from "../src/detect.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("detects Node scripts and the checked-in package manager", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-detect-"));
  try {
    await write(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest", bench: "node bench.js", lint: "eslint ." } }),
    );
    await write(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const result = await detectProject(root, ["claude"]);
    assert.deepEqual(result.stacks, ["Node.js"]);
    assert.deepEqual(result.bindings, {
      build: "pnpm run build",
      test: "pnpm test",
      benchmark: "pnpm run bench",
      lint: "pnpm run lint",
    });
    assert.deepEqual(result.targets, ["claude"]);
    assert.equal(result.agent, "claude");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers repository Make targets and fills missing Rust bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-detect-"));
  try {
    await write(path.join(root, "Makefile"), "build:\n\tcargo build --release\n\ntest:\n\tcargo nextest run\n");
    await write(path.join(root, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    const result = await detectProject(root, ["codex", "claude"]);
    assert.deepEqual(result.stacks, ["Make", "Rust"]);
    assert.deepEqual(result.bindings, {
      build: "make build",
      test: "make test",
      benchmark: "cargo bench",
    });
    assert.equal(result.agent, "codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports invalid package metadata instead of guessing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-detect-"));
  try {
    await write(path.join(root, "package.json"), "{ invalid");
    await assert.rejects(detectProject(root, ["codex"]), /invalid package\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs Bun package test scripts instead of invoking the built-in test runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-detect-"));
  try {
    await write(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "custom-test-command" } }));
    await write(path.join(root, "bun.lock"), "");
    const result = await detectProject(root, ["codex"]);
    assert.equal(result.bindings.test, "bun run test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
