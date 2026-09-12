import path from "node:path";

export type SupportedShell = "bash" | "zsh";
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
export function resolveShell(shell?: string): SupportedShell {
  const name = path.basename(shell ?? process.env.SHELL ?? "bash");
  if (name !== "bash" && name !== "zsh") throw new Error(`Unsupported shell: ${name}; use Bash or Zsh`);
  return name;
}

export function renderShellHook(shell: SupportedShell): string {
  return `# woma shell hook (${shell})\nwoma() {\n  local __woma_code\n  case "\${1-}" in\n    activate|deactivate)\n      __woma_code="$(command woma shell "$@")" || return $?\n      eval "$__woma_code"\n      ;;\n    *) command woma "$@" ;;\n  esac\n}\n`;
}
