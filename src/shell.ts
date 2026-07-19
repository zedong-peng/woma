import path from "node:path";

export type SupportedShell = "bash" | "zsh";

export function resolveShell(requested?: string, loginShell = process.env.SHELL): SupportedShell {
  const name = requested ?? (loginShell ? path.basename(loginShell) : "");
  if (name !== "bash" && name !== "zsh") {
    throw new Error(`Unsupported shell: ${name || "unknown"}; choose bash or zsh`);
  }
  return name;
}

const updatePrompt = [
  "__harness_prompt_update() {",
  "  local active",
  '  active="${HARNESS_ENV:-}"',
  '  [[ -n "$active" ]] || active="base"',
  '  case "$active" in',
  '    *[!a-z0-9._-]*) HARNESS_PROMPT_PREFIX="" ;;',
  '    *) HARNESS_PROMPT_PREFIX="(harness:$active) " ;;',
  "  esac",
  "}",
];

const environmentSelection = [
  "__harness_apply_env() {",
  "  local active home",
  '  active="${1:-base}"',
  '  case "$active" in',
  '    *[!a-z0-9._-]*|"") return 1 ;;',
  "  esac",
  '  home="${HARNESS_HOME:-$HOME/.harness-conda}"',
  '  export HARNESS_ENV="$active"',
  '  if [[ -d "$home/environments/$active/view/codex/skills" ]]; then',
  '    export CODEX_HOME="$home/environments/$active/view/codex"',
  "  else",
  '    export CODEX_HOME="$HARNESS_ORIGINAL_CODEX_HOME"',
  "  fi",
  '  if [[ -d "$home/environments/$active/view/claude/skills" ]]; then',
  '    export CLAUDE_CONFIG_DIR="$home/environments/$active/view/claude"',
  "  else",
  '    export CLAUDE_CONFIG_DIR="$HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR"',
  "  fi",
  "}",
  "",
  "harness() {",
  "  command harness \"$@\"",
  "  local status=$?",
  '  [[ "$status" -eq 0 ]] || return "$status"',
  "  local argument command_name environment_name skip_next=0",
  '  for argument in "$@"; do',
  '    if [[ "$skip_next" -eq 1 ]]; then skip_next=0; continue; fi',
  '    if [[ "$command_name" == "activate" && -z "$environment_name" && "$argument" != -* ]]; then environment_name="$argument"; continue; fi',
  '    case "$argument" in',
  '      -p|--project) skip_next=1 ;;',
  '      --project=*|-*) ;;',
  '      activate|deactivate) [[ -n "$command_name" ]] || command_name="$argument" ;;',
  "    esac",
  "  done",
  '  case "$command_name" in',
  '    activate) __harness_apply_env "${environment_name:-base}" ;;',
  '    deactivate) __harness_apply_env base ;;',
  "  esac",
  "}",
];

function zshHook(): string {
  return [
    "# harness-conda shell hook (zsh)",
    ...updatePrompt,
    ...environmentSelection,
    'if [[ -z "${HARNESS_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  typeset -g HARNESS_SHELL_HOOK_INSTALLED=1",
    '  export HARNESS_ORIGINAL_CODEX_HOME="${HARNESS_ORIGINAL_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"',
    '  export HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR="${HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"',
    '  typeset -g HARNESS_PROMPT_PREFIX=""',
    "  setopt PROMPT_SUBST",
    "  PROMPT='${HARNESS_PROMPT_PREFIX}'\"$PROMPT\"",
    "  autoload -Uz add-zsh-hook",
    "  add-zsh-hook precmd __harness_prompt_update",
    "fi",
    '__harness_apply_env "${HARNESS_ENV:-base}"',
    "__harness_prompt_update",
    "",
  ].join("\n");
}

function bashHook(): string {
  return [
    "# harness-conda shell hook (bash)",
    ...updatePrompt,
    ...environmentSelection,
    'if [[ -z "${HARNESS_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  HARNESS_SHELL_HOOK_INSTALLED=1",
    '  export HARNESS_ORIGINAL_CODEX_HOME="${HARNESS_ORIGINAL_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"',
    '  export HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR="${HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"',
    '  HARNESS_PROMPT_PREFIX=""',
    "  shopt -s promptvars",
    "  PS1='${HARNESS_PROMPT_PREFIX}'\"${PS1-}\"",
    '  case ";${PROMPT_COMMAND-};" in',
    '    *";__harness_prompt_update;"*) ;;',
    '    *) PROMPT_COMMAND="__harness_prompt_update${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    "  esac",
    "fi",
    '__harness_apply_env "${HARNESS_ENV:-base}"',
    "__harness_prompt_update",
    "",
  ].join("\n");
}

export function renderShellHook(shell: SupportedShell): string {
  return shell === "zsh" ? zshHook() : bashHook();
}
