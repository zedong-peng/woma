import path from "node:path";

export type SupportedShell = "bash" | "zsh";

export function resolveShell(requested?: string, loginShell = process.env.SHELL): SupportedShell {
  const name = requested ?? (loginShell ? path.basename(loginShell) : "");
  if (name !== "bash" && name !== "zsh") {
    throw new Error(`Unsupported shell: ${name || "unknown"}; choose bash or zsh`);
  }
  return name;
}

const findStateZsh = [
  "__harness_find_state() {",
  '  local directory="$PWD"',
  "  while true; do",
  '    if [[ -d "$directory/.harness" ]]; then',
  '      print -r -- "$directory/.harness/state.json"',
  "      return 0",
  "    fi",
  '    [[ "$directory" == "/" ]] && return 1',
  '    directory="${directory:h}"',
  "  done",
  "}",
];

const findStateBash = [
  "__harness_find_state() {",
  '  local directory="$PWD"',
  "  while true; do",
  '    if [[ -d "$directory/.harness" ]]; then',
  '      printf \'%s\\n\' "$directory/.harness/state.json"',
  "      return 0",
  "    fi",
  '    [[ "$directory" == "/" ]] && return 1',
  '    directory="${directory%/*}"',
  '    [[ -n "$directory" ]] || directory="/"',
  "  done",
  "}",
];

const updatePrompt = [
  "__harness_prompt_update() {",
  "  local state active",
  '  state="$(__harness_find_state 2>/dev/null)" || state=""',
  '  active=""',
  '  if [[ -f "$state" ]]; then',
  '    active="$(command sed -n \'/"activeEnvironment"[[:space:]]*:/,/^[[:space:]]*}/ s/^[[:space:]]*"name":[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$state")"',
  "  fi",
  '  case "$active" in',
  '    ""|*[!a-z0-9._-]*) HARNESS_PROMPT_PREFIX="" ;;',
  '    *) HARNESS_PROMPT_PREFIX="(harness:$active) " ;;',
  "  esac",
  "}",
];

function zshHook(): string {
  return [
    "# harness-conda shell hook (zsh)",
    ...findStateZsh,
    ...updatePrompt,
    'if [[ -z "${HARNESS_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  typeset -g HARNESS_SHELL_HOOK_INSTALLED=1",
    '  typeset -g HARNESS_PROMPT_PREFIX=""',
    "  setopt PROMPT_SUBST",
    "  PROMPT='${HARNESS_PROMPT_PREFIX}'\"$PROMPT\"",
    "  autoload -Uz add-zsh-hook",
    "  add-zsh-hook precmd __harness_prompt_update",
    "fi",
    "__harness_prompt_update",
    "",
  ].join("\n");
}

function bashHook(): string {
  return [
    "# harness-conda shell hook (bash)",
    ...findStateBash,
    ...updatePrompt,
    'if [[ -z "${HARNESS_SHELL_HOOK_INSTALLED:-}" ]]; then',
    "  HARNESS_SHELL_HOOK_INSTALLED=1",
    '  HARNESS_PROMPT_PREFIX=""',
    "  shopt -s promptvars",
    "  PS1='${HARNESS_PROMPT_PREFIX}'\"${PS1-}\"",
    '  case ";${PROMPT_COMMAND-};" in',
    '    *";__harness_prompt_update;"*) ;;',
    '    *) PROMPT_COMMAND="__harness_prompt_update${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    "  esac",
    "fi",
    "__harness_prompt_update",
    "",
  ].join("\n");
}

export function renderShellHook(shell: SupportedShell): string {
  return shell === "zsh" ? zshHook() : bashHook();
}
