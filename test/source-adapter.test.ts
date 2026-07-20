import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createEnvironment,
  environmentPath,
  installIntoEnvironment,
  readEnvironmentLock,
} from "../src/environment.js";
import { hashDirectory, pathExists } from "../src/fs.js";
import { installPackageSource, installPackageTree, syncLockedPackage } from "../src/package.js";
import { environmentViewPath } from "../src/view.js";
import { removeTestTree } from "./helpers.js";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = path.join(repositoryRoot, "test", "fixtures", "source-adapter");
let cliRun = 0;

async function runCli(args: string[], cwd: string, home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = path.join(repositoryRoot, "dist", "src", "cli.js");
  const previous = {
    argv: process.argv,
    cwd: process.cwd(),
    harnessHome: process.env.HARNESS_HOME,
    exitCode: process.exitCode,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
  };
  let stdout = "";
  let stderr = "";
  process.argv = [process.execPath, cli, ...args];
  process.chdir(cwd);
  process.env.HARNESS_HOME = home;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await import(`${pathToFileURL(cli).href}?source-adapter-test=${cliRun++}`);
    return { code: typeof process.exitCode === "number" ? process.exitCode : 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    if (previous.harnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous.harnessHome;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdoutWrite;
    process.stderr.write = previous.stderrWrite;
  }
}

async function write(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function skill(name: string, description = `Use ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

test("a root harness.yaml remains authoritative", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-native-source-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const pkg = await installPackageSource(path.join(fixtures, "native"));
    assert.equal(pkg.manifest.metadata.name, "native-fixture");
    assert.equal(pkg.manifest.metadata.version, "1.2.3");
    assert.deepEqual(pkg.manifest.spec.platforms, ["codex"]);
    assert.deepEqual(pkg.manifest.spec.skills.map((item) => item.name), ["native-skill"]);
  } finally {
    await removeTestTree(root);
  }
});

test("a root SKILL.md becomes one implicit Package without modifying its source", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-standalone-source-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const source = path.join(fixtures, "standalone");
  try {
    const before = await hashDirectory(source);
    const pkg = await installPackageSource(source);
    assert.equal(pkg.manifest.metadata.name, "standalone-research");
    assert.match(pkg.manifest.metadata.version, /^0\.0\.0\+local\.[a-f0-9]{12}$/);
    assert.deepEqual(pkg.manifest.spec.skills, [{ name: "standalone-research", path: "./skills/standalone" }]);
    assert.equal(await pathExists(path.join(source, "harness.yaml")), false);
    assert.equal(await hashDirectory(source), before);
    assert.match(await readFile(path.join(pkg.root, "skills", "standalone", "references", "method.md"), "utf8"), /supporting content/);
  } finally {
    await removeTestTree(root);
  }
});

test("inspect uses implicit Package normalization", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-inspect-implicit-"));
  try {
    const result = await runCli(["inspect", path.join(fixtures, "standalone")], repositoryRoot, path.join(root, "home"));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^standalone-research@0\.0\.0\+local\.[a-f0-9]{12}$/m);
    assert.match(result.stdout, /skills\s+standalone-research/);
  } finally {
    await removeTestTree(root);
  }
});

test("direct skills children become one deterministic implicit multi-Skill Package", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-multi-source-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const source = path.join(fixtures, "ResearchStudio", "ResearchStudio-Idea");
  try {
    const before = await hashDirectory(source);
    const pkg = await installPackageSource(source);
    assert.equal(pkg.manifest.metadata.name, "researchstudio-idea");
    assert.match(pkg.manifest.metadata.version, /^0\.0\.0\+local\.[a-f0-9]{12}$/);
    assert.deepEqual(pkg.manifest.spec.skills, [
      { name: "experiment-design", path: "./skills/experiment-design" },
      { name: "idea-generation", path: "./skills/idea-generation" },
    ]);
    assert.deepEqual(pkg.manifest.spec.dependencies, []);
    assert.deepEqual(pkg.manifest.spec.entrypoints, []);
    assert.equal(await pathExists(path.join(source, "harness.yaml")), false);
    assert.equal(await hashDirectory(source), before);
  } finally {
    await removeTestTree(root);
  }
});

test("dependency resolution uses implicit Package normalization", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependency-implicit-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const packageRoot = path.join(root, "native-parent");
    await write(
      path.join(packageRoot, "harness.yaml"),
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: native-parent
  version: 1.0.0
  description: Native parent of an implicit Skill Package.
spec:
  platforms: [codex, claude]
  dependencies:
    - name: standalone-research
      version: "*"
      source: ${JSON.stringify(path.join(fixtures, "standalone"))}
`,
    );
    const installation = await installPackageTree(packageRoot);
    assert.deepEqual(installation.packages.map((pkg) => pkg.lock.name), ["standalone-research", "native-parent"]);
    assert.deepEqual(installation.root.lock.dependencies, ["standalone-research"]);
  } finally {
    await removeTestTree(root);
  }
});

test("a Package collection root is rejected without changing Environment state", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-collection-source-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    await createEnvironment(project, "research", ["codex"]);
    const beforeRecipe = await readFile(environmentPath(project, "research"));
    const beforeLock = await readEnvironmentLock(project, "research");
    const beforeView = await hashDirectory(environmentViewPath("research"));

    await assert.rejects(
      installIntoEnvironment(project, "research", path.join(fixtures, "ResearchStudio")),
      /Unsupported Package source layout.*expected harness\.yaml, SKILL\.md, or skills\/\*\/SKILL\.md/,
    );
    assert.deepEqual(await readFile(environmentPath(project, "research")), beforeRecipe);
    assert.deepEqual(await readEnvironmentLock(project, "research"), beforeLock);
    assert.equal(await hashDirectory(environmentViewPath("research")), beforeView);
  } finally {
    await removeTestTree(root);
  }
});

test("implicit Packages reject invalid Skill frontmatter", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-invalid-skill-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const source = path.join(root, "invalid");
    await write(path.join(source, "SKILL.md"), "---\nname: invalid\ndescription: [unterminated\n---\n");
    await assert.rejects(installPackageSource(source), /invalid YAML frontmatter/);
    assert.equal(await pathExists(path.join(source, "harness.yaml")), false);
  } finally {
    await removeTestTree(root);
  }
});

test("implicit multi-Skill Packages reject duplicate Skill names", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-duplicate-skills-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const source = path.join(root, "duplicate-package");
    await write(path.join(source, "skills", "first", "SKILL.md"), skill("duplicate"));
    await write(path.join(source, "skills", "second", "SKILL.md"), skill("duplicate"));
    await assert.rejects(installPackageSource(source), /Duplicate skill name: duplicate/);
    assert.equal(await pathExists(path.join(source, "harness.yaml")), false);
  } finally {
    await removeTestTree(root);
  }
});

test("implicit Packages reject unsafe Skill names and symbolic links", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-unsafe-implicit-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const unsafeName = path.join(root, "unsafe-name");
    await write(path.join(unsafeName, "SKILL.md"), skill("../../escape"));
    await assert.rejects(installPackageSource(unsafeName), /metadata\.name:.*lowercase letters/);

    const linked = path.join(root, "linked-skill");
    await write(path.join(linked, "SKILL.md"), skill("linked-skill"));
    await write(path.join(root, "outside.txt"), "outside\n");
    await symlink(path.join(root, "outside.txt"), path.join(linked, "outside.txt"));
    await assert.rejects(installPackageSource(linked), /contains unsupported symlink/);
    assert.equal(await pathExists(path.join(linked, "harness.yaml")), false);
  } finally {
    await removeTestTree(root);
  }
});

test("repeated installation and sync reproduce implicit Package identity and bytes", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-repeat-implicit-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const source = path.join(fixtures, "ResearchStudio", "ResearchStudio-Idea");
  try {
    const first = await installPackageSource(source);
    const second = await installPackageSource(source);
    assert.equal(second.root, first.root);
    assert.deepEqual(second.manifest, first.manifest);
    assert.deepEqual(
      { ...second.lock, installedAt: undefined },
      { ...first.lock, installedAt: undefined },
    );

    await removeTestTree(first.root);
    const restored = await syncLockedPackage(first.lock);
    assert.equal(restored.root, first.root);
    assert.deepEqual(restored.manifest, first.manifest);
    assert.equal(await hashDirectory(restored.root), first.lock.integrity);
  } finally {
    await removeTestTree(root);
  }
});

test("Skill ownership conflicts use the ordinary Environment transaction", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-implicit-conflict-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  const project = path.join(root, "project");
  try {
    const first = path.join(root, "first-package");
    const second = path.join(root, "second-package");
    await write(path.join(first, "skills", "first", "SKILL.md"), skill("occupied-skill"));
    await write(path.join(second, "skills", "second", "SKILL.md"), skill("occupied-skill"));
    await createEnvironment(project, "tools", ["codex"]);
    await installIntoEnvironment(project, "tools", first);
    const beforeRecipe = await readFile(environmentPath(project, "tools"));
    const beforeLock = await readEnvironmentLock(project, "tools");
    const beforeView = await hashDirectory(environmentViewPath("tools"));

    await assert.rejects(
      installIntoEnvironment(project, "tools", second),
      /Skill occupied-skill is provided by both first-package and second-package/,
    );
    assert.deepEqual(await readFile(environmentPath(project, "tools")), beforeRecipe);
    assert.deepEqual(await readEnvironmentLock(project, "tools"), beforeLock);
    assert.equal(await hashDirectory(environmentViewPath("tools")), beforeView);
  } finally {
    await removeTestTree(root);
  }
});

test("local and Git sources use the same implicit normalization", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-git-implicit-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const local = await installPackageSource(path.join(fixtures, "standalone"));
    const repository = path.join(root, "standalone.git");
    await cp(path.join(fixtures, "standalone"), repository, { recursive: true });
    await run("git", ["init"], { cwd: repository });
    await run("git", ["add", "."], { cwd: repository });
    await run("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-m", "fixture"], {
      cwd: repository,
    });

    const fromGit = await installPackageSource(repository);
    assert.equal(fromGit.manifest.metadata.name, local.manifest.metadata.name);
    assert.equal(fromGit.manifest.metadata.description, local.manifest.metadata.description);
    assert.deepEqual(fromGit.manifest.spec, local.manifest.spec);
    assert.match(fromGit.manifest.metadata.version, /^0\.0\.0\+git\.[a-f0-9]{12}$/);
    assert.match(fromGit.lock.resolved, /^[a-f0-9]{40,64}$/);
    assert.equal(await pathExists(path.join(repository, "harness.yaml")), false);

    await removeTestTree(fromGit.root);
    const restored = await syncLockedPackage(fromGit.lock);
    assert.deepEqual(restored.manifest, fromGit.manifest);
    assert.equal(await hashDirectory(restored.root), fromGit.lock.integrity);
  } finally {
    await removeTestTree(root);
  }
});
