import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = path.resolve("dist/src/cli.js");

test("concurrent installs serialize and preserve both successful updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-concurrent-install-"));
  const home = path.join(root, "home");
  const env = { ...process.env, HARNESS_HOME: home };
  try {
    await run(process.execPath, [cli, "env", "create", "race", "--target", "codex"], { cwd: root, env });

    await Promise.all([
      run(process.execPath, [cli, "install", "-n", "race", "builtin:paper-search"], { cwd: root, env }),
      run(process.execPath, [cli, "install", "-n", "race", "builtin:idea-gen"], { cwd: root, env }),
    ]);

    const lock = JSON.parse(await readFile(path.join(home, "environments", "race", "lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    };
    assert.deepEqual(new Set(Object.keys(lock.packages)), new Set([
      "harness-project-memory",
      "meta-skill-builder",
      "paper-search",
      "idea-gen",
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abandoned Environment lock is recovered after its stale threshold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stale-lock-"));
  const home = path.join(root, "home");
  const lock = path.join(home, "locks", "environments", "tools.lock");
  const env = { ...process.env, HARNESS_HOME: home };
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({ token: "abandoned", pid: 2_000_000_000, hostname: os.hostname(), acquiredAt: "2000-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);

    await run(process.execPath, [cli, "env", "create", "tools", "--target", "codex"], { cwd: root, env });

    const recipe = await readFile(path.join(home, "environments", "tools", "environment.yaml"), "utf8");
    assert.match(recipe, /name: tools/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent first use initializes base exactly once across processes", async () => {
  for (let index = 0; index < 4; index += 1) {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-concurrent-base-"));
    const home = path.join(root, "home");
    const env = { ...process.env, HARNESS_HOME: home };
    try {
      await Promise.all([
        run(process.execPath, [cli, "shell", "hook", "bash"], { cwd: root, env }),
        run(process.execPath, [cli, "shell", "hook", "bash"], { cwd: root, env }),
      ]);
      const lock = JSON.parse(await readFile(path.join(home, "environments", "base", "lock.json"), "utf8")) as {
        packages: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(lock.packages), ["harness-project-memory", "meta-skill-builder"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("different Environments serialize repair of one shared Package cache entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-concurrent-cache-repair-"));
  const home = path.join(root, "home");
  const env = { ...process.env, HARNESS_HOME: home };
  try {
    for (const name of ["a", "b"]) {
      await run(process.execPath, [cli, "env", "create", name, "--target", "codex"], { cwd: root, env });
      await run(process.execPath, [cli, "install", "-n", name, "builtin:paper-search"], { cwd: root, env });
    }
    const lock = JSON.parse(await readFile(path.join(home, "environments", "a", "lock.json"), "utf8")) as {
      packages: Record<string, { cacheKey: string }>;
    };
    const cacheKey = lock.packages["paper-search"]!.cacheKey;
    const skill = path.join(home, "packages", "paper-search", cacheKey, "skills", "paper-search", "SKILL.md");
    await writeFile(skill, "corrupt\n", "utf8");

    await Promise.all([
      run(process.execPath, [cli, "sync", "-n", "a"], { cwd: root, env }),
      run(process.execPath, [cli, "sync", "-n", "b"], { cwd: root, env }),
    ]);

    assert.match(await readFile(skill, "utf8"), /paper-search/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
