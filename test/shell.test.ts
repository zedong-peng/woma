import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("bash hook finds an active environment from a project subdirectory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-shell-hook-"));
  try {
    const project = path.join(root, "project");
    const nested = path.join(project, "src", "nested");
    const hookPath = path.join(root, "hook.bash");
    await mkdir(path.join(project, ".harness"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(project, ".harness", "state.json"),
      `${JSON.stringify({
        stateVersion: 1,
        activations: {},
        activeEnvironment: { name: "base", packages: [], targets: ["codex"], activatedAt: new Date().toISOString() },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(hookPath, renderShellHook("bash"), "utf8");
    await run("bash", ["-n", hookPath]);
    const script = 'source "$1"\ncd "$2"\n__harness_prompt_update\nprintf \'%s\' "$HARNESS_PROMPT_PREFIX"';
    const { stdout } = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested]);
    assert.equal(stdout, "(harness:base) ");

    await mkdir(path.join(nested, ".harness"));
    const inner = await run("bash", ["--noprofile", "--norc", "-c", script, "bash", hookPath, nested]);
    assert.equal(inner.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zsh hook installs an idempotent precmd prompt prefix", () => {
  const hook = renderShellHook("zsh");
  assert.match(hook, /\[\[ -d "\$directory\/\.harness" \]\]/);
  assert.match(hook, /directory="\$\{directory:h\}"/);
  assert.match(hook, /add-zsh-hook precmd __harness_prompt_update/);
  assert.match(hook, /PROMPT='\$\{HARNESS_PROMPT_PREFIX\}'/);
  assert.match(hook, /HARNESS_SHELL_HOOK_INSTALLED/);
});
