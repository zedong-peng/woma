import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderShellHook, resolveShell } from "../src/shell.js";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);

async function fakeEnvironment(home: string, name: string, targets: ("codex" | "claude")[]): Promise<void> {
  const root = path.join(home, "environments", name);
  await mkdir(path.join(root, "view"), { recursive: true });
  await writeFile(path.join(root, "environment.yaml"), `metadata:\n  name: ${name}\n`, "utf8");
  await writeFile(path.join(root, "view", "view.json"), "{}\n", "utf8");
  for (const target of targets) await mkdir(path.join(root, "view", target, "skills"), { recursive: true });
}

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
    await fakeEnvironment(path.join(root, "home"), "research", ["codex", "claude"]);
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
    await removeTestTree(root);
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
    const harnessHome = path.join(root, "home");
    await fakeEnvironment(harnessHome, "research", ["codex"]);
    await fakeEnvironment(harnessHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "harness --project /tmp/project activate research",
      'printf \'%s|%s\\n\' "$HARNESS_ENV" "$CODEX_HOME"',
      "harness deactivate",
      'printf \'%s|%s\\n\' "$HARNESS_ENV" "$CLAUDE_CONFIG_DIR"',
    ].join("\n");
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
    await removeTestTree(root);
  }
});

test("shell hook restores the original Agent home for an unsupported target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-target-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    await fakeEnvironment(home, "codex-only", ["codex"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = 'source "$1"\nprintf \'%s|%s\' "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"';
    const { stdout } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", script, "bash", hookPath],
      {
        env: {
          ...process.env,
          HARNESS_HOME: home,
          HARNESS_ENV: "codex-only",
          CODEX_HOME: originalCodex,
          CLAUDE_CONFIG_DIR: originalClaude,
        },
      },
    );
    assert.equal(stdout, `${path.join(home, "environments", "codex-only", "view", "codex")}|${originalClaude}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell wrapper changes state only for a real activation command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-parser-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "harness");
    const home = path.join(root, "home");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await fakeEnvironment(home, "research", ["codex"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "harness activate research --help",
      'printf \'%s\\n\' "$HARNESS_ENV"',
      "harness inspect activate",
      'printf \'%s\\n\' "$HARNESS_ENV"',
      "harness env create deactivate",
      'printf \'%s\\n\' "$HARNESS_ENV"',
      "harness activate research",
      'printf \'%s\\n\' "$HARNESS_ENV"',
    ].join("\n");
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_HOME: home },
    });
    assert.equal(stdout, "base\nbase\nbase\nresearch\n");
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook falls back from a phantom inherited Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-phantom-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const { stdout, stderr } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"\nprintf \'%s\' "$HARNESS_ENV"', "bash", hookPath],
      { env: { ...process.env, HARNESS_HOME: home, HARNESS_ENV: "missing" } },
    );
    assert.equal(stdout, "base");
    assert.match(stderr, /Environment missing is unavailable; using base/);
  } finally {
    await removeTestTree(root);
  }
});
