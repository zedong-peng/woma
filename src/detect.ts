import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import type { Platform } from "./types.js";

export interface ProjectDetection {
  stacks: string[];
  bindings: Record<string, string>;
  targets: Platform[];
  agent: Platform;
}

async function commandExists(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (
      await access(path.join(directory, command), constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function file(root: string, name: string): Promise<string | undefined> {
  const filePath = path.join(root, name);
  if (!(await pathExists(filePath))) return undefined;
  return readFile(filePath, "utf8");
}

function setMissing(bindings: Record<string, string>, values: Record<string, string | undefined>): void {
  for (const [name, command] of Object.entries(values)) {
    if (command && !bindings[name]) bindings[name] = command;
  }
}

function makeTargets(available?: Platform[]): { targets: Platform[]; agent: Platform } {
  const targets: Platform[] = available && available.length > 0 ? [...new Set<Platform>(available)] : ["codex"];
  return { targets, agent: targets.includes("codex") ? "codex" : "claude" };
}

export async function detectProject(projectRoot: string, availableAgents?: Platform[]): Promise<ProjectDetection> {
  const root = path.resolve(projectRoot);
  const bindings: Record<string, string> = {};
  const stacks: string[] = [];

  const makefile = (await file(root, "Makefile")) ?? (await file(root, "makefile"));
  if (makefile) {
    stacks.push("Make");
    const targets = new Set(
      [...makefile.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=])/gm)].map((match) => match[1]!),
    );
    setMissing(bindings, {
      build: targets.has("build") ? "make build" : undefined,
      test: targets.has("test") ? "make test" : undefined,
      benchmark: targets.has("benchmark") ? "make benchmark" : targets.has("bench") ? "make bench" : undefined,
      lint: targets.has("lint") ? "make lint" : undefined,
    });
  }

  const justfile = (await file(root, "justfile")) ?? (await file(root, "Justfile"));
  if (justfile) {
    stacks.push("Just");
    const recipes = new Set([...justfile.matchAll(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:/gm)].map((match) => match[1]!));
    setMissing(bindings, {
      build: recipes.has("build") ? "just build" : undefined,
      test: recipes.has("test") ? "just test" : undefined,
      benchmark: recipes.has("benchmark") ? "just benchmark" : recipes.has("bench") ? "just bench" : undefined,
      lint: recipes.has("lint") ? "just lint" : undefined,
    });
  }

  const packageJson = await file(root, "package.json");
  if (packageJson) {
    stacks.push("Node.js");
    let parsed: unknown;
    try {
      parsed = JSON.parse(packageJson);
    } catch (error) {
      throw new Error(`Cannot detect project: invalid package.json: ${(error as Error).message}`);
    }
    const rawScripts =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).scripts : undefined;
    const scripts = rawScripts && typeof rawScripts === "object" && !Array.isArray(rawScripts) ? (rawScripts as Record<string, unknown>) : {};
    const manager = (await pathExists(path.join(root, "pnpm-lock.yaml")))
      ? "pnpm"
      : (await pathExists(path.join(root, "yarn.lock")))
        ? "yarn"
        : (await pathExists(path.join(root, "bun.lock"))) || (await pathExists(path.join(root, "bun.lockb")))
          ? "bun"
          : "npm";
    const run = (name: string): string | undefined => {
      if (typeof scripts[name] !== "string") return undefined;
      if (name === "test" && manager !== "bun") return `${manager} test`;
      return `${manager} run ${name}`;
    };
    setMissing(bindings, {
      build: run("build"),
      test: run("test"),
      benchmark: run("benchmark") ?? run("bench"),
      lint: run("lint"),
      dev: run("dev"),
    });
  }

  if (await pathExists(path.join(root, "Cargo.toml"))) {
    stacks.push("Rust");
    setMissing(bindings, { build: "cargo build", test: "cargo test", benchmark: "cargo bench" });
  }
  if (await pathExists(path.join(root, "go.mod"))) {
    stacks.push("Go");
    setMissing(bindings, { build: "go build ./...", test: "go test ./...", benchmark: "go test -bench=. ./..." });
  }
  if (
    (await pathExists(path.join(root, "pyproject.toml"))) ||
    (await pathExists(path.join(root, "setup.py"))) ||
    (await pathExists(path.join(root, "requirements.txt")))
  ) {
    stacks.push("Python");
    const test = (await pathExists(path.join(root, "uv.lock"))) ? "uv run pytest" : "python -m pytest";
    setMissing(bindings, { test });
  }
  if (await pathExists(path.join(root, "CMakeLists.txt"))) {
    stacks.push("CMake");
    setMissing(bindings, { build: "cmake --build build", test: "ctest --test-dir build" });
  }

  let agents = availableAgents;
  if (!agents) {
    agents = [];
    if (await commandExists("codex")) agents.push("codex");
    if (await commandExists("claude")) agents.push("claude");
  }
  return { stacks, bindings, ...makeTargets(agents) };
}
