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
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-hook-"));
  try {
    const project = path.join(root, "project");
    const nested = path.join(project, "src", "nested");
    const hookPath = path.join(root, "hook.bash");
    await mkdir(nested, { recursive: true });
    await fakeEnvironment(path.join(root, "home"), "research", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    await run("bash", ["-n", hookPath]);
    const script = 'source "$1"\ncd "$2"\n__woma_prompt_update\nprintf \'%s|%s|%s|%s\' "$WOMA_PROMPT_PREFIX" "$WOMA_ENV" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"';
    const options = { env: { ...process.env, WOMA_HOME: path.join(root, "home"), WOMA_ENV: "research" } };
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested], options);
    assert.equal(
      stdout,
      `(woma:research) |research|${path.join(root, "home", "environments", "research", "home", "codex")}|${path.join(root, "home", "environments", "research", "home", "claude")}`,
    );

    await mkdir(path.join(nested, ".woma"));
    const inner = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested], options);
    assert.equal(
      inner.stdout,
      `(woma:research) |research|${path.join(root, "home", "environments", "research", "home", "codex")}|${path.join(root, "home", "environments", "research", "home", "claude")}`,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("zsh hook installs an idempotent precmd prompt prefix", () => {
  const hook = renderShellHook("zsh");
  assert.doesNotMatch(hook, /state\.json|__woma_find_state/);
  assert.match(hook, /add-zsh-hook precmd __woma_prompt_update/);
  assert.match(hook, /PROMPT='\$\{WOMA_PROMPT_PREFIX\}'/);
  assert.match(hook, /WOMA_SHELL_HOOK_INSTALLED/);
  assert.match(hook, /WOMA_ORIGINAL_CODEX_HOME/);
  assert.match(hook, /CLAUDE_CONFIG_DIR=.*environments.*home\/claude/);
  assert.match(hook, /WOMA_ORIGINAL_PI_CODING_AGENT_DIR/);
  assert.match(hook, /PI_CODING_AGENT_DIR=.*environments.*home\/pi/);
  assert.match(hook, /WOMA_ORIGINAL_QODER_CONFIG_DIR/);
  assert.match(hook, /QODER_CONFIG_DIR=.*environments.*home\/qoder/);
  assert.equal((hook.match(/^woma\(\) \{/gm) ?? []).length, 1);
  assert.doesNotMatch(hook, /\bwoma-conda\b/);
});

test("zsh hook updates the parent shell after activate", async (context) => {
  const zsh = await findExecutable("zsh");
  if (!zsh) return context.skip("zsh is not installed");
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-zsh-activation-"));
  try {
    const hookPath = path.join(root, "hook.zsh");
    const executable = path.join(root, "bin", "woma");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const womaHome = path.join(root, "home");
    await fakeEnvironment(womaHome, "research", ["codex"]);
    await fakeEnvironment(womaHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("zsh"), "utf8");
    const script = [
      'source "$1"',
      "woma activate research",
      '__woma_prompt_update',
      'printf \'%s|%s|%s\' "$WOMA_PROMPT_PREFIX" "$WOMA_ENV" "$CODEX_HOME"',
    ].join("\n");
    const { stdout } = await run(zsh, ["-f", "-c", script, "zsh", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, WOMA_HOME: womaHome },
    });
    assert.equal(
      stdout,
      `(woma:research) |research|${path.join(womaHome, "environments", "research", "home", "codex")}`,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("bash hook restores the original Agent homes after deactivate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-activation-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "woma");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const womaHome = path.join(root, "home");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const originalPi = path.join(root, "original-pi");
    await fakeEnvironment(womaHome, "research", ["codex"]);
    await fakeEnvironment(womaHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "woma --project /tmp/project activate research",
      'printf \'%s|%s\\n\' "$WOMA_ENV" "$CODEX_HOME"',
      "woma deactivate",
      "__woma_prompt_update",
      'printf \'%s|%s|%s|%s|%s\\n\' "${WOMA_ENV-unset}" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$PI_CODING_AGENT_DIR" "$WOMA_PROMPT_PREFIX"',
    ].join("\n");
    const { stdout } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", script, "bash", hookPath],
      {
        env: {
          ...process.env,
          PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
          WOMA_HOME: womaHome,
          WOMA_ORIGINAL_CODEX_HOME: originalCodex,
          WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
          WOMA_ORIGINAL_PI_CODING_AGENT_DIR: originalPi,
          CODEX_HOME: originalCodex,
          CLAUDE_CONFIG_DIR: originalClaude,
          PI_CODING_AGENT_DIR: originalPi,
        },
      },
    );
    assert.equal(
      stdout,
      `research|${path.join(womaHome, "environments", "research", "home", "codex")}\nunset|${originalCodex}|${originalClaude}|${originalPi}|\n`,
    );
  } finally {
    await removeTestTree(root);
  }
});

test("bash hook keeps activate base distinct from deactivate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-base-activation-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "woma");
    const womaHome = path.join(root, "home");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await fakeEnvironment(womaHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "woma deactivate",
      "woma activate base",
      "__woma_prompt_update",
      'printf \'%s|%s|%s\' "$WOMA_ENV" "$CODEX_HOME" "$WOMA_PROMPT_PREFIX"',
    ].join("\n");
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, WOMA_HOME: womaHome },
    });
    assert.equal(stdout, `base|${path.join(womaHome, "environments", "base", "home", "codex")}|(woma:base) `);
  } finally {
    await removeTestTree(root);
  }
});

test("woma shell wrapper updates the parent shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-alias-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "woma");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const womaHome = path.join(root, "home");
    await fakeEnvironment(womaHome, "research", ["codex"]);
    await fakeEnvironment(womaHome, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = 'source "$1"\nwoma activate research\nprintf \'%s|%s\' "$WOMA_ENV" "$CODEX_HOME"';
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, WOMA_HOME: womaHome },
    });
    assert.equal(stdout, `research|${path.join(womaHome, "environments", "research", "home", "codex")}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook restores the original Agent home for an unsupported target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-target-"));
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
          WOMA_HOME: home,
          WOMA_ENV: "codex-only",
          WOMA_ORIGINAL_CODEX_HOME: originalCodex,
          WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
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
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-pi-target-"));
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
        WOMA_HOME: home,
        WOMA_ENV: "pi-only",
        WOMA_ORIGINAL_CODEX_HOME: originalCodex,
        WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
        WOMA_ORIGINAL_PI_CODING_AGENT_DIR: originalPi,
      },
    });
    assert.equal(stdout, `${originalCodex}|${originalClaude}|${path.join(home, "environments", "pi-only", "home", "pi")}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook selects Qoder home and restores unsupported Agent homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-qoder-target-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const originalQoder = path.join(root, "original-qoder");
    await fakeEnvironment(home, "qoder-only", ["qoder"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = 'source "$1"\nprintf \'%s|%s|%s\' "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$QODER_CONFIG_DIR"';
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: {
        ...process.env,
        WOMA_HOME: home,
        WOMA_ENV: "qoder-only",
        WOMA_ORIGINAL_CODEX_HOME: originalCodex,
        WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
        WOMA_ORIGINAL_QODER_CONFIG_DIR: originalQoder,
      },
    });
    assert.equal(stdout, `${originalCodex}|${originalClaude}|${path.join(home, "environments", "qoder-only", "home", "qoder")}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell wrapper changes state only for a real activation command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-parser-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const executable = path.join(root, "bin", "woma");
    const home = path.join(root, "home");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await fakeEnvironment(home, "research", ["codex"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      "woma activate research --help",
      'printf \'%s\\n\' "$WOMA_ENV"',
      "woma inspect activate",
      'printf \'%s\\n\' "$WOMA_ENV"',
      "woma env create deactivate",
      'printf \'%s\\n\' "$WOMA_ENV"',
      "woma activate research",
      'printf \'%s\\n\' "$WOMA_ENV"',
    ].join("\n");
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath], {
      env: { ...process.env, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`, WOMA_HOME: home },
    });
    assert.equal(stdout, "base\nbase\nbase\nresearch\n");
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook falls back from a phantom inherited Environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-phantom-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const { stdout, stderr } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"\nprintf \'%s\' "$WOMA_ENV"', "bash", hookPath],
      { env: { ...process.env, WOMA_HOME: home, WOMA_ENV: "missing" } },
    );
    assert.equal(stdout, "base");
    assert.match(stderr, /Environment missing is unavailable; using base/);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook uses the initialization default when WOMA_ENV is unset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-default-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await fakeEnvironment(home, "codex", ["codex"]);
    await writeFile(path.join(home, "default-environment"), "codex\n", "utf8");
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const { stdout } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"\nprintf \'%s|%s\' "$WOMA_ENV" "$CODEX_HOME"', "bash", hookPath],
      { env: { ...process.env, WOMA_HOME: home, WOMA_ENV: "" } },
    );
    assert.equal(stdout, `codex|${path.join(home, "environments", "codex", "home", "codex")}`);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook rejects an invalid initialized default before resolving paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-invalid-default-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const home = path.join(root, "home");
    await fakeEnvironment(home, "base", ["codex", "claude"]);
    await mkdir(path.join(home, "view"), { recursive: true });
    await writeFile(path.join(home, "environment.yaml"), "metadata:\n  name: outside\n", "utf8");
    await writeFile(path.join(home, "view", "view.json"), "{}\n", "utf8");
    await writeFile(path.join(home, "default-environment"), "..\n", "utf8");
    await writeFile(hookPath, renderShellHook("bash"), "utf8");

    const { stdout, stderr } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"\nprintf \'%s\' "$WOMA_ENV"', "bash", hookPath],
      { env: { ...process.env, WOMA_HOME: home, WOMA_ENV: "" } },
    );
    assert.equal(stdout, "base");
    assert.match(stderr, /Environment \.\. is unavailable; using base/);
  } finally {
    await removeTestTree(root);
  }
});

test("shell hook restores original Agent homes when no Environment is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-shell-no-environment-"));
  try {
    const hookPath = path.join(root, "hook.bash");
    const originalCodex = path.join(root, "original-codex");
    const originalClaude = path.join(root, "original-claude");
    const originalPi = path.join(root, "original-pi");
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    const script = [
      'source "$1"',
      'printf \'%s|%s|%s|%s|%s\' "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$PI_CODING_AGENT_DIR" "${WOMA_ENV-unset}" "$WOMA_PROMPT_PREFIX"',
    ].join("\n");
    const { stdout, stderr } = await run(
      "bash",
      ["--noprofile", "--norc", "-c", script, "bash", hookPath],
      {
        env: {
          ...process.env,
          WOMA_HOME: path.join(root, "missing-home"),
          WOMA_ENV: "missing",
          WOMA_ORIGINAL_CODEX_HOME: originalCodex,
          WOMA_ORIGINAL_CLAUDE_CONFIG_DIR: originalClaude,
          WOMA_ORIGINAL_PI_CODING_AGENT_DIR: originalPi,
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
