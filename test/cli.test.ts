import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createEnvironment, exportEnvironment } from "../src/environment.js";
import { shellQuote } from "../src/shell.js";
import { fixture, skill } from "./helpers.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/src/cli.js");

test("CLI preserves native arguments, exit status, and missing-runtime errors", async (t) => {
  const f = await fixture(t);
  const prefix = await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const env = { ...process.env, WOMA_HOME: process.env.WOMA_HOME! };
  const result = await exec(process.execPath, [cli, "run", "-p", prefix, process.execPath, "-e", "console.log(JSON.stringify({args:process.argv.slice(1),home:process.env.CODEX_HOME}))", "--", "--model", "value with spaces", "--name=native"], { env });
  assert.deepEqual(JSON.parse(result.stdout), { args: ["--model", "value with spaces", "--name=native"], home: `${prefix}/home` });
  await assert.rejects(exec(process.execPath, [cli, "run", "-p", prefix, process.execPath, "-e", "process.exit(37)"], { env }), (error: unknown) => (error as { code: number }).code === 37);
  await assert.rejects(exec(process.execPath, [cli, "run", "-p", prefix, "claude", "--version"], { env }), /contains codex/);
  const source = await skill(path.join(f.root, "review"));
  await exec(process.execPath, [cli, "install", "-p", prefix, source], { env });
  const lock = path.join(f.root, "woma.lock");
  await exec(process.execPath, [cli, "export", "-p", prefix, "--explicit", "-f", lock], { env });
  const clone = path.join(f.root, "clone");
  await exec(process.execPath, [cli, "create", "-p", clone, "-f", lock], { env });
  const version = await exec(process.execPath, [cli, "run", "-p", clone, "codex", "--version"], { env });
  assert.equal(version.stdout.trim(), "codex 0.154.0");
  await exec(process.execPath, [cli, "env", "remove", "-p", clone, "--yes"], { env });
  await assert.rejects(stat(clone), { code: "ENOENT" });
  await rename(path.join(prefix, "bin/codex"), path.join(prefix, "bin/codex.missing"));
  await assert.rejects(exec(process.execPath, [cli, "run", "-p", prefix, "codex", "--version"], { env }), /no system runtime fallback/);
});

for (const shell of ["bash", "zsh"]) {
  test(`${shell} activates independently, never stacks PATH, and restores unset values`, async (t) => {
    try { await exec(shell, ["--version"]); } catch { t.skip(`${shell} unavailable`); return; }
    const f = await fixture(t);
    const a = await createEnvironment({ name: "a" }, { harness: "codex", provider: f.provider });
    const b = await createEnvironment({ name: "b" }, { harness: "claude", provider: f.provider });
    const bin = path.join(f.root, "bin"); await mkdir(bin);
    await writeFile(path.join(bin, "woma"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", WOMA_HOME: process.env.WOMA_HOME! };
    for (const key of Object.keys(env)) if (key.startsWith("WOMA_") && key !== "WOMA_HOME") delete env[key];
    const before = await readFile(path.join(a, ".woma/state.json"), "utf8");
    const flags = shell === "bash" ? ["--noprofile", "--norc", "-c"] : ["-f", "-c"];
    const script = `set -eu\nunset CLAUDE_CONFIG_DIR\noriginal_path="$PATH"\neval "$(woma shell hook ${shell})"\ntest -z "\${WOMA_PREFIX+x}"\nwoma activate a\ntest "$CODEX_HOME" = ${shellQuote(`${a}/home`)}\nwoma activate a\ntest "$PATH" = ${shellQuote(`${a}/bin`)}:"$original_path"\nwoma activate -n b\ntest "$PATH" = ${shellQuote(`${b}/bin`)}:"$original_path"\ntest "$CODEX_HOME" = ''\nwoma deactivate\ntest "$PATH" = "$original_path"\ntest -z "\${CLAUDE_CONFIG_DIR+x}"\ntest -z "\${WOMA_PREFIX+x}"\ntest "\${CODEX_HOME+x}" = x\n`;
    await exec(shell, [...flags, script], { env });
    const other = await exec(shell, [...flags, `eval "$(woma shell hook ${shell})"; woma activate a; printf '%s' "$WOMA_PREFIX"`], { env });
    assert.equal(other.stdout, a);
    assert.equal(await readFile(path.join(a, ".woma/state.json"), "utf8"), before);
  });
}

test("run forwards termination signals and reports signal termination", async (t) => {
  const f = await fixture(t);
  await createEnvironment({ prefix: f.prefix }, { harness: "codex", provider: f.provider });
  const child = spawn(process.execPath, [cli, "run", "-p", f.prefix, process.execPath, "-e", "process.stdout.write('ready'); setInterval(()=>{}, 1000)"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("run signal test timed out")); }, 15_000);
    child.stdout.on("data", () => child.kill("SIGTERM"));
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: null, signal: "SIGTERM" });
});
