import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { renderShellHook, resolveShell } from "../src/shell.js";
import type { Platform } from "../src/types.js";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

async function fakeEnvironment(home: string, name: string, targets: Platform[]): Promise<void> {
  const root = path.join(home, "environments", name);
  await mkdir(path.join(root, "view"), { recursive: true });
  await writeFile(path.join(root, "environment.yaml"), `metadata:\n  name: ${name}\n`, "utf8");
  await writeFile(path.join(root, "view", "view.json"), "{}\n", "utf8");
  for (const target of targets) {
    await mkdir(path.join(root, "view", target, "skills"), { recursive: true });
    await mkdir(path.join(root, "home", target), { recursive: true });
  }
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
      `(harness:research) |research|${path.join(root, "home", "environments", "research", "home", "codex")}|${path.join(root, "home", "environments", "research", "home", "claude")}`,
    );

    await mkdir(path.join(nested, ".harness"));
    const inner = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested], options);
    assert.equal(
      inner.stdout,
      `(harness:research) |research|${path.join(root, "home", "environments", "research", "home", "codex")}|${path.join(root, "home", "environments", "research", "home", "claude")}`,
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
  assert.match(hook, /CLAUDE_CONFIG_DIR=.*environments.*home\/claude/);
  assert.match(hook, /HARNESS_ORIGINAL_PI_CODING_AGENT_DIR/);
  assert.match(hook, /PI_CODING_AGENT_DIR=.*environments.*home\/pi/);
});

test("zsh hook updates the parent shell after activate", async (context) => {
  const zsh = await findExecutable("zsh");
  if (!zsh) return context.skip("zsh is not installed");
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-zsh-activation-"));
  try {
    const hookPath = path.join(root, "hook.zsh");
    const executable = path.join(root, "bin", "harness");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const harnessHome = path.join(root, "home");
    await fakeEnvironment(harnessHome, "research", ["codex"]);
    await fakeEnvironment(harnessHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("zsh"), "utf8");
    const script = [
      'source "$1"',
      "harness activate research",
      '__harness_prompt_update',
      'printf \'%s|%s|%s\' "$HARNESS_PROMPT_PREFIX" "$HARNESS_ENV" "$CODEX_HOME"',
    ].join("\n");
    const { stdout } = await run(zsh, ["-f", "-c", script, "zsh", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_HOME: harnessHome },
    });
    assert.equal(
      stdout,
      `(harness:research) |research|${path.join(harnessHome, "environments", "research", "home", "codex")}`,
    );
  } finally {
    await removeTestTree(root);
  }
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
      `research|${path.join(harnessHome, "environments", "research", "home", "codex")}\nbase|${path.join(harnessHome, "environments", "base", "home", "claude")}\n`,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("harness-conda alias also updates the parent shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-alias-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "harness-conda");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const harnessHome = path.join(root, "home");
    await fakeEnvironment(harnessHome, "research", ["codex"]);
    await fakeEnvironment(harnessHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = 'source "$1"\nharness-conda activate research\nprintf \'%s|%s\' "$HARNESS_ENV" "$CODEX_HOME"';
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, HARNESS_HOME: harnessHome },
    });
    assert.equal(stdout, `research|${path.join(harnessHome, "environments", "research", "home", "codex")}`);
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
          HARNESS_ORIGINAL_CODEX_HOME: originalCodex,
          HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
          CODEX_HOME: originalCodex,
          CLAUDE_CONFIG_DIR: originalClaude,
        },
      },
    );
    assert.equal(stdout, `${path.join(home, "environments", "codex-only", "home", "codex")}|${originalClaude}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook selects Pi home and restores unsupported Agent homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-pi-target-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const originalPi = path.join(root, "original-pi");
    await fakeEnvironment(home, "pi-only", ["pi"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = 'source "$1"\nprintf \'%s|%s|%s\' "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$PI_CODING_AGENT_DIR"';
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: {
        ...process.env,
        HARNESS_HOME: home,
        HARNESS_ENV: "pi-only",
        HARNESS_ORIGINAL_CODEX_HOME: originalCodex,
        HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
        HARNESS_ORIGINAL_PI_CODING_AGENT_DIR: originalPi,
      },
    });
    assert.equal(stdout, `${originalCodex}|${originalClaude}|${path.join(home, "environments", "pi-only", "home", "pi")}`);
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

test("shell hook restores original Agent homes when no Environment is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-no-environment-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const originalPi = path.join(root, "original-pi");
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      'printf \'%s|%s|%s|%s|%s\' "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$PI_CODING_AGENT_DIR" "${HARNESS_ENV-unset}" "$HARNESS_PROMPT_PREFIX"',
    ].join("\n");
    const { stdout, stderr } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", script, "bash", hookPath],
      {
        env: {
          ...process.env,
          HARNESS_HOME: path.join(root, "missing-home"),
          HARNESS_ENV: "missing",
          HARNESS_ORIGINAL_CODEX_HOME: originalCodex,
          HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
          HARNESS_ORIGINAL_PI_CODING_AGENT_DIR: originalPi,
          CODEX_HOME: path.join(root, "stale-codex"),
          CLAUDE_CONFIG_DIR: path.join(root, "stale-claude"),
          PI_CODING_AGENT_DIR: path.join(root, "stale-pi"),
        },
      },
    );
    assert.equal(stdout, `${originalCodex}|${originalClaude}|${originalPi}|unset|`);
    assert.match(stderr, /Environment missing is unavailable; using original Agent homes/);
  } finally {
    await removeTestTree(root);
  }
});
