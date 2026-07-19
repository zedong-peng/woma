import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderShellHook, resolveShell } from "../src/shell.js";

const run = promisify(execFile);

test("shell resolution supports explicit and login-shell bash or zsh", () => {
  assert.equal(resolveShell("bash"), "bash");
  assert.equal(resolveShell(undefined, "/bin/zsh"), "zsh");
  assert.throws(() => resolveShell("fish"), /choose bash or zsh/);
});

test("bash hook keeps the shell Environment across project directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-hook-"));
  try {
    const project = path.join(root, "project");
    const nested = path.join(project, "src", "nested");
    const hookPath = path.join(root, "hook.bash");
    await mkdir(nested, { recursive: true });
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    await run("bash", ["-n", hookPath]);
    const script = 'source "$1"\ncd "$2"\n__harness_prompt_update\nprintf \'%s|%s|%s|%s\' "$HARNESS_PROMPT_PREFIX" "$HARNESS_ENV" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"';
    const options = { env: { ...process.env, HARNESS_HOME: path.join(root, "home"), HARNESS_ENV: "research" } };
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested], options);
    assert.equal(
      stdout,
      `(harness:research) |research|${path.join(root, "home", "environments", "research", "view", "codex")}|${path.join(root, "home", "environments", "research", "view", "claude")}`,
    );

    await mkdir(path.join(nested, ".harness"));
    const inner = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested], options);
    assert.equal(
      inner.stdout,
      `(harness:research) |research|${path.join(root, "home", "environments", "research", "view", "codex")}|${path.join(root, "home", "environments", "research", "view", "claude")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zsh hook installs an idempotent precmd prompt prefix", () => {
  const hook = renderShellHook("zsh");
  assert.doesNotMatch(hook, /state\.json|__harness_find_state/);
  assert.match(hook, /add-zsh-hook precmd __harness_prompt_update/);
  assert.match(hook, /PROMPT='\$\{HARNESS_PROMPT_PREFIX\}'/);
  assert.match(hook, /HARNESS_SHELL_HOOK_INSTALLED/);
  assert.match(hook, /HARNESS_ORIGINAL_CODEX_HOME/);
  assert.match(hook, /CLAUDE_CONFIG_DIR=.*environments.*view\/claude/);
});

test("bash hook updates the parent shell after activate and deactivate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-activation-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "harness");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "harness --project /tmp/project activate research",
      'printf \'%s|%s\\n\' "$HARNESS_ENV" "$CODEX_HOME"',
      "harness deactivate",
      'printf \'%s|%s\\n\' "$HARNESS_ENV" "$CLAUDE_CONFIG_DIR"',
    ].join("\n");
    const harnessHome = path.join(root, "home");
    const { stdout } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", script, "bash", hookPath],
      { env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_HOME: harnessHome } },
    );
    assert.equal(
      stdout,
      `research|${path.join(harnessHome, "environments", "research", "view", "codex")}\nbase|${path.join(harnessHome, "environments", "base", "view", "claude")}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
