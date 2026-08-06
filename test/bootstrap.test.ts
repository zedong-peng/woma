import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultEnvironmentPath,
  initializeBootstrap,
  initializationStatePath,
  removeInitializedEnvironment,
  renameInitializedEnvironment,
} from "../src/bootstrap.js";
import {
  createEnvironment,
  ensureBaseEnvironment,
  environmentPath,
  environmentSnapshot,
  installIntoEnvironment,
} from "../src/environment.js";
import { environmentAgentHomePath, environmentSkillsPath, environmentViewPath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withBootstrapEnvironment(operation: (root: string, home: string, codex: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "woma-bootstrap-"));
  const home = path.join(root, "home");
  const codex = path.join(root, "original-codex");
  const previous = {
    home: process.env.WOMA_HOME,
    codex: process.env.WOMA_ORIGINAL_CODEX_HOME,
    claude: process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR,
    active: process.env.WOMA_ENV,
  };
  process.env.WOMA_HOME = home;
  process.env.WOMA_ORIGINAL_CODEX_HOME = codex;
  process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR = path.join(root, "original-claude");
  delete process.env.WOMA_ENV;
  try {
    await operation(root, home, codex);
  } finally {
    restoreEnvironment("WOMA_HOME", previous.home);
    restoreEnvironment("WOMA_ORIGINAL_CODEX_HOME", previous.codex);
    restoreEnvironment("WOMA_ORIGINAL_CLAUDE_CONFIG_DIR", previous.claude);
    restoreEnvironment("WOMA_ENV", previous.active);
    await removeTestTree(root);
  }
}

test("init creates a clean base and snapshots supported existing Codex state once", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy-model"\n');
    await write(
      path.join(codex, "hooks.json"),
      `${JSON.stringify({ hooks: { SessionStart: [{ command: "legacy-hook" }] }, custom: true }, null, 2)}\n`,
    );
    await write(path.join(codex, "auth.json"), '{"token":"private"}\n');
    await write(path.join(codex, "sessions", "old.jsonl"), "private session\n");
    await write(path.join(codex, "plugins", "old-plugin", "plugin.json"), "{}\n");
    await write(path.join(codex, "skills", ".system", "SKILL.md"), "system managed\n");
    await write(
      path.join(codex, "skills", "review-notes", "SKILL.md"),
      "---\nname: review-notes\ndescription: Existing review notes.\n---\n\nOriginal snapshot.\n",
    );

    const initialized = await initializeBootstrap(root);
    assert.equal(initialized.defaultEnvironment, "codex");
    assert.deepEqual(initialized.importedSkills, ["review-notes"]);
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "codex\n");
    assert.deepEqual(JSON.parse(await readFile(initializationStatePath(), "utf8")), {
      version: 1,
      status: "complete",
      defaultEnvironment: "codex",
    });

    const base = await environmentSnapshot(root, "base");
    assert.deepEqual(base.environment.spec.targets, ["codex", "claude"]);
    assert.deepEqual(base.lock.packages, {});
    assert.doesNotMatch(await readFile(path.join(environmentAgentHomePath("base", "codex"), "config.toml"), "utf8"), /legacy-model/);
    assert.deepEqual(JSON.parse(await readFile(path.join(environmentAgentHomePath("base", "codex"), "hooks.json"), "utf8")), {});

    const imported = await environmentSnapshot(root, "codex");
    assert.deepEqual(imported.environment.spec.targets, ["codex"]);
    assert.deepEqual(Object.keys(imported.lock.packages), ["review-notes"]);
    assert.match(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "config.toml"), "utf8"), /legacy-model/);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "hooks.json"), "utf8")),
      { hooks: { SessionStart: [{ command: "legacy-hook" }] }, custom: true },
    );
    assert.match(
      await readFile(path.join(environmentSkillsPath("codex"), "review-notes", "SKILL.md"), "utf8"),
      /Original snapshot/,
    );
    await assert.rejects(access(path.join(environmentSkillsPath("codex"), ".system")), { code: "ENOENT" });
    for (const entry of ["auth.json", "sessions", "plugins"]) {
      await assert.rejects(access(path.join(environmentAgentHomePath("codex", "codex"), entry)), { code: "ENOENT" });
    }
    assert.equal(await readFile(path.join(codex, "auth.json"), "utf8"), '{"token":"private"}\n');

    await write(path.join(codex, "config.toml"), 'model = "changed-later"\n');
    await write(path.join(codex, "hooks.json"), '{"changed":true}\n');
    await write(
      path.join(codex, "skills", "review-notes", "SKILL.md"),
      "---\nname: review-notes\ndescription: Changed later.\n---\n\nChanged later.\n",
    );
    await write(
      path.join(codex, "skills", "added-later", "SKILL.md"),
      "---\nname: added-later\ndescription: Added later.\n---\n",
    );

    const repeated = await initializeBootstrap(root);
    assert.equal(repeated.defaultEnvironment, "codex");
    assert.deepEqual(repeated.importedSkills, []);
    assert.deepEqual(repeated.actions, []);
    const stable = await environmentSnapshot(root, "codex");
    assert.deepEqual(Object.keys(stable.lock.packages), ["review-notes"]);
    assert.match(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "config.toml"), "utf8"), /legacy-model/);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "hooks.json"), "utf8")),
      { hooks: { SessionStart: [{ command: "legacy-hook" }] }, custom: true },
    );
    assert.match(
      await readFile(path.join(environmentSkillsPath("codex"), "review-notes", "SKILL.md"), "utf8"),
      /Original snapshot/,
    );
    await assert.rejects(access(path.join(environmentSkillsPath("codex"), "added-later")), { code: "ENOENT" });

    await rm(environmentViewPath("codex"), { force: true });
    await installIntoEnvironment(root, "codex", "builtin:paper-search");
    assert.doesNotMatch(
      await readFile(path.join(environmentAgentHomePath("codex", "codex"), "config.toml"), "utf8"),
      /changed-later/,
    );
  });
});

test("init records a one-time clean-base decision when Codex has nothing supported to import", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    const initialized = await initializeBootstrap(root);
    assert.equal(initialized.defaultEnvironment, "base");
    assert.deepEqual(initialized.importedSkills, []);
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "base\n");
    await access(environmentPath(root, "base"));
    await assert.rejects(access(environmentPath(root, "codex")), { code: "ENOENT" });

    await write(path.join(codex, "config.toml"), 'model = "too-late"\n');
    const repeated = await initializeBootstrap(root);
    assert.equal(repeated.defaultEnvironment, "base");
    await assert.rejects(access(environmentPath(root, "codex")), { code: "ENOENT" });
  });
});

test("init still imports Codex state when another command created base first", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy-model"\n');
    await ensureBaseEnvironment(root);

    const initialized = await initializeBootstrap(root);
    assert.equal(initialized.defaultEnvironment, "codex");
    await access(environmentPath(root, "codex"));
    assert.match(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "config.toml"), "utf8"), /legacy-model/);
  });
});

test("invalid Codex configuration is rejected before bootstrap and can be retried", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, home, codex) => {
    await write(path.join(codex, "config.toml"), "model = [\n");

    await assert.rejects(initializeBootstrap(root, true), /Cannot merge .*config\.toml/);
    await assert.rejects(access(home), { code: "ENOENT" });
    await write(path.join(codex, "config.toml"), 'model = "valid"\n');
    await write(path.join(codex, "hooks.json"), "[\n");
    await assert.rejects(initializeBootstrap(root, true), /Cannot merge .*hooks\.json/);
    await assert.rejects(access(home), { code: "ENOENT" });
    await write(path.join(codex, "hooks.json"), "{}\n");
    await write(path.join(codex, "config.toml"), "model = [\n");
    await assert.rejects(initializeBootstrap(root), /Cannot merge .*config\.toml/);
    await assert.rejects(access(environmentPath(root, "base")), { code: "ENOENT" });
    await assert.rejects(access(environmentPath(root, "codex")), { code: "ENOENT" });
    await assert.rejects(access(initializationStatePath()), { code: "ENOENT" });
    await assert.rejects(access(defaultEnvironmentPath()), { code: "ENOENT" });

    await write(path.join(codex, "config.toml"), 'model = "fixed"\n');
    const recovered = await initializeBootstrap(root);
    assert.equal(recovered.defaultEnvironment, "codex");
    assert.match(await readFile(path.join(environmentAgentHomePath("codex", "codex"), "config.toml"), "utf8"), /fixed/);
  });
});

test("renaming or removing the initialized default updates future init and shell selection", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy"\n');
    await initializeBootstrap(root);

    await renameInitializedEnvironment(root, "codex", "legacy-codex");
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "legacy-codex\n");
    assert.equal((await initializeBootstrap(root)).defaultEnvironment, "legacy-codex");

    await removeInitializedEnvironment(root, "legacy-codex");
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "base\n");
    assert.equal((await initializeBootstrap(root)).defaultEnvironment, "base");
  });
});

test("initialized rename and remove serialize their Environment and default mutations", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy"\n');
    await initializeBootstrap(root);

    let referencesEntered!: () => void;
    let releaseReferences!: () => void;
    const referencesUpdated = new Promise<void>((resolve) => (referencesEntered = resolve));
    const continueRename = new Promise<void>((resolve) => (releaseReferences = resolve));
    const renaming = renameInitializedEnvironment(root, "codex", "legacy-codex", {
      onReferencesUpdated: async () => {
        referencesEntered();
        await continueRename;
      },
    });
    await referencesUpdated;

    let removalFinished = false;
    const removal = removeInitializedEnvironment(root, "legacy-codex").then(() => {
      removalFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(removalFinished, false);

    releaseReferences();
    await Promise.all([renaming, removal]);
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "base\n");
    assert.deepEqual(JSON.parse(await readFile(initializationStatePath(), "utf8")), {
      version: 1,
      status: "complete",
      defaultEnvironment: "base",
    });
    await assert.rejects(access(environmentPath(root, "codex")), { code: "ENOENT" });
    await assert.rejects(access(environmentPath(root, "legacy-codex")), { code: "ENOENT" });
  });
});

test("initialized Environment mutations roll back partial default reference writes", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy"\n');
    await initializeBootstrap(root);
    const failure = { onInitializationStateWritten: () => Promise.reject(new Error("injected reference failure")) };

    await assert.rejects(renameInitializedEnvironment(root, "codex", "legacy-codex", failure), /injected reference failure/);
    await access(environmentPath(root, "codex"));
    await assert.rejects(access(environmentPath(root, "legacy-codex")), { code: "ENOENT" });
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "codex\n");
    assert.equal(
      (JSON.parse(await readFile(initializationStatePath(), "utf8")) as { defaultEnvironment: string }).defaultEnvironment,
      "codex",
    );

    await assert.rejects(removeInitializedEnvironment(root, "codex", failure), /injected reference failure/);
    await access(environmentPath(root, "codex"));
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "codex\n");
    assert.equal(
      (JSON.parse(await readFile(initializationStatePath(), "utf8")) as { defaultEnvironment: string }).defaultEnvironment,
      "codex",
    );

    await createEnvironment(root, "occupied", ["codex"]);
    await assert.rejects(renameInitializedEnvironment(root, "codex", "occupied"), /already exists/);
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "codex\n");
    process.env.WOMA_ENV = "codex";
    try {
      await assert.rejects(removeInitializedEnvironment(root, "codex"), /active in this shell/);
    } finally {
      delete process.env.WOMA_ENV;
    }
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "codex\n");
  });
});

test("completed init falls back to base when its recorded default disappeared", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(path.join(codex, "config.toml"), 'model = "legacy"\n');
    await initializeBootstrap(root);
    await rm(path.dirname(environmentPath(root, "codex")), { recursive: true, force: true });

    const recovered = await initializeBootstrap(root);
    assert.equal(recovered.defaultEnvironment, "base");
    assert.equal(await readFile(defaultEnvironmentPath(), "utf8"), "base\n");
    assert.equal(
      (JSON.parse(await readFile(initializationStatePath(), "utf8")) as { defaultEnvironment: string }).defaultEnvironment,
      "base",
    );
  });
});

test("concurrent init calls publish one complete imported Environment", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    await write(
      path.join(codex, "skills", "concurrent-review", "SKILL.md"),
      "---\nname: concurrent-review\ndescription: Concurrent review.\n---\n",
    );

    const results = await Promise.all([initializeBootstrap(root), initializeBootstrap(root)]);
    assert.deepEqual(results.map((result) => result.defaultEnvironment), ["codex", "codex"]);
    assert.deepEqual(results.map((result) => result.importedSkills.length).sort(), [0, 1]);
    assert.deepEqual(Object.keys((await environmentSnapshot(root, "codex")).lock.packages), ["concurrent-review"]);
    assert.equal((JSON.parse(await readFile(initializationStatePath(), "utf8")) as { status: string }).status, "complete");
  });
});

test("pending init resumes an atomically reserved imported Environment", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, _home, codex) => {
    const initializationId = "e80ed5b9-afc9-44c7-8dbd-7f63f42d7543";
    await write(path.join(codex, "config.toml"), 'model = "reserved"\n');
    await write(
      initializationStatePath(),
      `${JSON.stringify({ version: 1, status: "pending", initializationId, importExistingCodex: true }, null, 2)}\n`,
    );
    await write(
      path.join(path.dirname(environmentPath(root, "codex")), ".woma-import.json"),
      `${JSON.stringify({ version: 1, kind: "WomaImportedCodexEnvironment", initializationId }, null, 2)}\n`,
    );

    const recovered = await initializeBootstrap(root);
    assert.equal(recovered.defaultEnvironment, "codex");
    await access(environmentPath(root, "codex"));
    assert.equal((JSON.parse(await readFile(initializationStatePath(), "utf8")) as { status: string }).status, "complete");
  });
});

test("init dry-run is read-only and rejects an existing unowned codex Environment", { concurrency: false }, async () => {
  await withBootstrapEnvironment(async (root, home, codex) => {
    await write(
      path.join(codex, "skills", "preview", "SKILL.md"),
      "---\nname: preview\ndescription: Preview.\n---\n",
    );
    const planned = await initializeBootstrap(root, true);
    assert.equal(planned.defaultEnvironment, "codex");
    assert.deepEqual(planned.importedSkills, ["preview"]);
    assert.match(planned.actions.map((entry) => entry.detail).join("\n"), /clean base Environment/);
    assert.match(planned.actions.map((entry) => entry.detail).join("\n"), /one-time import/);
    await assert.rejects(access(home), { code: "ENOENT" });

    await createEnvironment(root, "codex", ["codex"]);
    await write(path.join(codex, "config.toml"), 'model = "legacy-model"\n');
    await assert.rejects(initializeBootstrap(root), /Environment codex already exists/);
    await assert.rejects(access(initializationStatePath()), { code: "ENOENT" });
    assert.deepEqual((await environmentSnapshot(root, "codex")).lock.packages, {});

    await write(
      initializationStatePath(),
      `${JSON.stringify({
        version: 1,
        status: "pending",
        initializationId: "7f53a229-d490-4f2f-94ea-1a0e6166bb8d",
        importExistingCodex: true,
      }, null, 2)}\n`,
    );
    await assert.rejects(initializeBootstrap(root), /does not belong to this initialization/);
    assert.deepEqual((await environmentSnapshot(root, "codex")).lock.packages, {});
  });
});
