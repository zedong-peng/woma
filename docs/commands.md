# Commands

All environment commands accept `-n/--name` or `-p/--prefix`. Supplying both is an error. Without either, the active `WOMA_PREFIX` is used; absent activation is an error. `-p` never means project. `create` requires an explicit target. Name lookup uses `$WOMA_HOME/environments/<name>`; the default Woma state root is `~/.woma`.

| Command | Effect |
| --- | --- |
| `init [bash\|zsh] [--reverse] [--dry-run]` | Install/remove shell integration, preserving the rest of the profile. No environment creation or import. |
| `create -n NAME codex[@VERSION]` | Create a clean Codex environment; `claude[@VERSION]` selects Claude Code. Default version is resolved and locked once. |
| `create -p PREFIX -f FILE` | Create from a v2 recipe or exact lock. Existing prefixes are refused, including legacy environments. |
| `activate NAME` / `activate -p PREFIX` | Select the environment in the current Bash/Zsh shell. Reads metadata only; no installation, capture, network, or file writes. |
| `deactivate` | Restore original PATH and native home variables, including their unset/empty distinction. No stacking. |
| `run -n NAME EXECUTABLE [ARGS...]` | Apply the same selection to a child. Native arguments, exit status, and termination signals are preserved. |
| `install SOURCE...` | Snapshot local/Git sources, validate the complete graph, then publish managed content and registrations. |
| `install SOURCE --subdir PATH --commit SHA` | Select a Git package explicitly. Options require one source; SHA must be a complete commit. |
| `install codex@VERSION` | Explicitly change the current Codex runtime. `claude@VERSION` is equivalent in a Claude environment. |
| `update [PACKAGE...]` | Refresh named packages and their dependency subtrees. With no names, update the runtime and all direct packages. |
| `update codex[@VERSION]` | Explicit upgrade/downgrade; without a version, resolve latest. Does not re-resolve unrelated capability packages. |
| `remove PACKAGE...` | Remove direct requirements and prune unreachable dependencies. Removing the runtime is refused. |
| `list [--json]` | Read the managed runtime/package list. Unmanaged native content is not scanned or adopted. |
| `env list [--json]` | Read known prefixes, labeling v2, legacy, and invalid entries. No initialization. |
| `doctor` | Read and diagnose graph, snapshot, managed content, registration, and interrupted-transaction issues. No repair. |
| `export [-f FILE]` | Write the direct recipe to stdout or FILE; reads metadata only. |
| `export --explicit [-f FILE]` | Write the exact lock to stdout or FILE; reads metadata only. |
| `env remove [-y/--yes]` | Delete the inactive environment and all local native state. Interactive confirmation is required unless `--yes` is supplied. |

`run` options must precede its executable. Everything after the executable belongs to that program, including `-n`, `-p`, and `--help`. `woma run -n research codex --model MODEL` does not reinterpret Codex's arguments.

The generated `bin/<harness>` launcher invokes only the installed runtime. Its update check is disabled where supported. A direct `codex update` or `claude update` is redirected to `woma update`; the environment's version should be changed through Woma. Node.js remains a prerequisite for legacy JavaScript releases and is not itself locked by Woma.

Changing harness brands requires a new environment. A running harness may retain startup-time plugin discovery, so start a new process after a package change. Native enable/disable and provider configuration remain native workflows. Codex plugins use `NAME@woma`; Claude plugins use `NAME@skills-dir`.

Git sources support `gh:OWNER/REPO`, HTTPS/SSH URLs, and `git+file:///absolute/repository` for a local Git repository. A persisted subdirectory intent uses `URL#REF::SUBDIRECTORY`; `--subdir` constructs this form. Credentials in HTTPS URLs are rejected; use Git's credential helper.

Removed v1 workflows include `--project`, targets, bootstrap, automatic import, capture, session migration, shared Skill views, environment bundles, and rename. Existing native data stays where it was. There is no default environment or automatic activation.
