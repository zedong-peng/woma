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
  "__woma_prompt_update() {",
  "  local active",
  '  active="${WOMA_ENV:-}"',
  '  if [[ -z "$active" ]]; then WOMA_PROMPT_PREFIX=""; return; fi',
  '  case "$active" in',
  '    *[!a-z0-9._-]*) WOMA_PROMPT_PREFIX="" ;;',
  '    *) WOMA_PROMPT_PREFIX="(woma:$active) " ;;',
  "  esac",
  "}",
];

function commandWrapper(): string[] {
  return [
    "woma() {",
    '  command woma "$@"',
    "  local woma_exit_code=$?",
    '  [[ "$woma_exit_code" -eq 0 ]] || return "$woma_exit_code"',
    "  local argument command_name environment_name skip_next=0 seen_command=0",
    '  for argument in "$@"; do',
    '    if [[ "$skip_next" -eq 1 ]]; then skip_next=0; continue; fi',
    '    case "$argument" in -h|--help) return "$woma_exit_code" ;; esac',
    '    if [[ "$seen_command" -eq 0 ]]; then',
    '      case "$argument" in',
    '        -p|--project) skip_next=1 ;;',
    '        --project=*|-*) ;;',
    '        help) return "$woma_exit_code" ;;',
    '        *) command_name="$argument"; seen_command=1 ;;',
    '      esac',
    '      continue',
    '    fi',
    '    [[ "$command_name" == "activate" ]] || continue',
    '    case "$argument" in',
    '      -p|--project) skip_next=1 ;;',
    '      --project=*|-*) ;;',
    '      *) [[ -n "$environment_name" ]] || environment_name="$argument" ;;',
    "    esac",
    "  done",
    '  case "$command_name" in',
    '    activate) __woma_apply_env "${environment_name:-base}" || return 1 ;;',
    '    deactivate) __woma_restore_original_env ;;',
    "  esac",
    '  return "$woma_exit_code"',
    "}",
  ];
}

const environmentSelection = [
  "__woma_restore_original_env() {",
  "  unset WOMA_ENV",
  '  export CODEX_HOME="$WOMA_ORIGINAL_CODEX_HOME"',
  '  export CLAUDE_CONFIG_DIR="$WOMA_ORIGINAL_CLAUDE_CONFIG_DIR"',
  '  export PI_CODING_AGENT_DIR="$WOMA_ORIGINAL_PI_CODING_AGENT_DIR"',
  '  export QODER_CONFIG_DIR="$WOMA_ORIGINAL_QODER_CONFIG_DIR"',
  '  if [[ -n "$WOMA_ORIGINAL_OPENCODE_CONFIG" ]]; then export OPENCODE_CONFIG="$WOMA_ORIGINAL_OPENCODE_CONFIG"; else unset OPENCODE_CONFIG; fi',
  '  if [[ -n "$WOMA_ORIGINAL_OPENCODE_CONFIG_DIR" ]]; then export OPENCODE_CONFIG_DIR="$WOMA_ORIGINAL_OPENCODE_CONFIG_DIR"; else unset OPENCODE_CONFIG_DIR; fi',
  "}",
  "",
  "__woma_apply_env() {",
  "  local active home",
  '  active="${1:-base}"',
  '  case "$active" in',
  '    ""|[!a-z0-9]*|*[!a-z0-9._-]*) return 1 ;;',
  "  esac",
  '  [[ ${#active} -le 80 ]] || return 1',
  '  home="${WOMA_HOME:-$HOME/.woma}"',
  '  [[ -f "$home/environments/$active/environment.yaml" && -f "$home/environments/$active/view/view.json" ]] || return 1',
  '  export WOMA_ENV="$active"',
  '  if [[ -d "$home/environments/$active/view/codex/skills" && -d "$home/environments/$active/home/codex" ]]; then',
  '    export CODEX_HOME="$home/environments/$active/home/codex"',
  "  else",
  '    export CODEX_HOME="$WOMA_ORIGINAL_CODEX_HOME"',
  "  fi",
  '  if [[ -d "$home/environments/$active/view/claude/skills" && -d "$home/environments/$active/home/claude" ]]; then',
  '    export CLAUDE_CONFIG_DIR="$home/environments/$active/home/claude"',
  "  else",
  '    export CLAUDE_CONFIG_DIR="$WOMA_ORIGINAL_CLAUDE_CONFIG_DIR"',
  "  fi",
  '  if [[ -d "$home/environments/$active/view/pi/skills" && -d "$home/environments/$active/home/pi" ]]; then',
  '    export PI_CODING_AGENT_DIR="$home/environments/$active/home/pi"',
  "  else",
  '    export PI_CODING_AGENT_DIR="$WOMA_ORIGINAL_PI_CODING_AGENT_DIR"',
  "  fi",
  '  if [[ -d "$home/environments/$active/view/qoder/skills" && -d "$home/environments/$active/home/qoder" ]]; then',
  '    export QODER_CONFIG_DIR="$home/environments/$active/home/qoder"',
  "  else",
  '    export QODER_CONFIG_DIR="$WOMA_ORIGINAL_QODER_CONFIG_DIR"',
  "  fi",
  '  if [[ -d "$home/environments/$active/view/opencode/skills" && -d "$home/environments/$active/home/opencode" ]]; then',
  '    export OPENCODE_CONFIG="$home/environments/$active/home/opencode/opencode.json"',
  '    export OPENCODE_CONFIG_DIR="$home/environments/$active/home/opencode"',
  "  else",
  '    if [[ -n "$WOMA_ORIGINAL_OPENCODE_CONFIG" ]]; then export OPENCODE_CONFIG="$WOMA_ORIGINAL_OPENCODE_CONFIG"; else unset OPENCODE_CONFIG; fi',
  '    if [[ -n "$WOMA_ORIGINAL_OPENCODE_CONFIG_DIR" ]]; then export OPENCODE_CONFIG_DIR="$WOMA_ORIGINAL_OPENCODE_CONFIG_DIR"; else unset OPENCODE_CONFIG_DIR; fi',
  "  fi",
  "}",
  "",
  ...commandWrapper(),
];

const initialEnvironmentSelection = [
  '__woma_initial_env="${WOMA_ENV:-}"',
  'if [[ -z "$__woma_initial_env" ]]; then',
  '  __woma_default_file="${WOMA_HOME:-$HOME/.woma}/default-environment"',
  '  if [[ -f "$__woma_default_file" ]]; then IFS= read -r __woma_initial_env < "$__woma_default_file"; fi',
  '  __woma_initial_env="${__woma_initial_env:-base}"',
  "fi",
  'if ! __woma_apply_env "$__woma_initial_env"; then',
  '  __woma_unavailable_env="$__woma_initial_env"',
  '  if [[ "$__woma_unavailable_env" != "base" ]] && __woma_apply_env base; then',
  '    printf \'woma: Environment %s is unavailable; using base\\n\' "$__woma_unavailable_env" >&2',
  "  else",
  '    printf \'woma: Environment %s is unavailable; using original Agent homes\\n\' "$__woma_unavailable_env" >&2',
  "    __woma_restore_original_env",
  "  fi",
  "  unset __woma_unavailable_env",
  "fi",
  "unset __woma_default_file __woma_initial_env",
];

function zshHook(): string {
  return [
    "# woma shell hook (zsh)",
    ...updatePrompt,
    ...environmentSelection,
    'if [[ -z "${WOMA_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  typeset -g WOMA_SHELL_HOOK_INSTALLED=1",
    '  export WOMA_ORIGINAL_CODEX_HOME="${WOMA_ORIGINAL_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"',
    '  export WOMA_ORIGINAL_CLAUDE_CONFIG_DIR="${WOMA_ORIGINAL_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"',
    '  export WOMA_ORIGINAL_PI_CODING_AGENT_DIR="${WOMA_ORIGINAL_PI_CODING_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"',
    '  export WOMA_ORIGINAL_QODER_CONFIG_DIR="${WOMA_ORIGINAL_QODER_CONFIG_DIR:-${QODER_CONFIG_DIR:-$HOME/.qoder}}"',
    '  if [[ -z "${WOMA_ORIGINAL_OPENCODE_CONFIG+x}" ]]; then export WOMA_ORIGINAL_OPENCODE_CONFIG="${OPENCODE_CONFIG:-}"; fi',
    '  if [[ -z "${WOMA_ORIGINAL_OPENCODE_CONFIG_DIR+x}" ]]; then export WOMA_ORIGINAL_OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-}"; fi',
    '  typeset -g WOMA_PROMPT_PREFIX=""',
    "  setopt PROMPT_SUBST",
    "  PROMPT='${WOMA_PROMPT_PREFIX}'\"$PROMPT\"",
    "  autoload -Uz add-zsh-hook",
    "  add-zsh-hook precmd __woma_prompt_update",
    "fi",
    ...initialEnvironmentSelection,
    "__woma_prompt_update",
    "",
  ].join("\n");
}

function bashHook(): string {
  return [
    "# woma shell hook (bash)",
    ...updatePrompt,
    ...environmentSelection,
    'if [[ -z "${WOMA_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  WOMA_SHELL_HOOK_INSTALLED=1",
    '  export WOMA_ORIGINAL_CODEX_HOME="${WOMA_ORIGINAL_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"',
    '  export WOMA_ORIGINAL_CLAUDE_CONFIG_DIR="${WOMA_ORIGINAL_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"',
    '  export WOMA_ORIGINAL_PI_CODING_AGENT_DIR="${WOMA_ORIGINAL_PI_CODING_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"',
    '  export WOMA_ORIGINAL_QODER_CONFIG_DIR="${WOMA_ORIGINAL_QODER_CONFIG_DIR:-${QODER_CONFIG_DIR:-$HOME/.qoder}}"',
    '  if [[ -z "${WOMA_ORIGINAL_OPENCODE_CONFIG+x}" ]]; then export WOMA_ORIGINAL_OPENCODE_CONFIG="${OPENCODE_CONFIG:-}"; fi',
    '  if [[ -z "${WOMA_ORIGINAL_OPENCODE_CONFIG_DIR+x}" ]]; then export WOMA_ORIGINAL_OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-}"; fi',
    '  WOMA_PROMPT_PREFIX=""',
    "  shopt -s promptvars",
    "  PS1='${WOMA_PROMPT_PREFIX}'\"${PS1-}\"",
    '  case ";${PROMPT_COMMAND-};" in',
    '    *";__woma_prompt_update;"*) ;;',
    '    *) PROMPT_COMMAND="__woma_prompt_update${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    "  esac",
    "fi",
    ...initialEnvironmentSelection,
    "__woma_prompt_update",
    "",
  ].join("\n");
}

export function renderShellHook(shell: SupportedShell): string {
  return shell === "zsh" ? zshHook() : bashHook();
}
