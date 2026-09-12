import path from "node:path";
import { shellQuote } from "./shell.js";
import type { EnvironmentState } from "./types.js";

const variables = ["PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "CODEX_MANAGED_BY_NPM", "WOMA_PREFIX", "WOMA_ENV"] as const;
const saved = (key: string) => `WOMA_SAVED_${key}`;

export function originalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (environment.WOMA_SHELL_ACTIVE === "1") {
    for (const key of variables) {
      if (environment[`${saved(key)}_SET`] === "1") result[key] = environment[saved(key)] ?? "";
      else delete result[key];
      delete result[saved(key)]; delete result[`${saved(key)}_SET`];
    }
  }
  delete result.WOMA_SHELL_ACTIVE;
  return result;
}

export function selectedEnvironment(prefix: string, state: EnvironmentState, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = originalEnvironment(environment);
  for (const key of variables) {
    result[`${saved(key)}_SET`] = result[key] === undefined ? "0" : "1";
    result[saved(key)] = result[key] ?? "";
  }
  result.WOMA_SHELL_ACTIVE = "1";
  result.WOMA_PREFIX = prefix;
  result.WOMA_ENV = state.lock.recipe.name;
  result.PATH = `${path.join(prefix, "bin")}${result.PATH === undefined ? "" : `${path.delimiter}${result.PATH}`}`;
  if (state.lock.recipe.harness === "codex") {
    result.CODEX_HOME = path.join(prefix, "home");
    result.CODEX_MANAGED_BY_NPM = "1";
  } else {
    result.CLAUDE_CONFIG_DIR = path.join(prefix, "home");
    result.DISABLE_AUTOUPDATER = "1";
  }
  return result;
}

export function renderSelection(next: NodeJS.ProcessEnv): string {
  const names = [...variables, "WOMA_SHELL_ACTIVE", ...variables.flatMap((v) => [saved(v), `${saved(v)}_SET`])];
  return names.map((key) => next[key] === undefined ? `unset ${key}` : `export ${key}=${shellQuote(next[key]!)}`).join("\n") + "\n";
}
