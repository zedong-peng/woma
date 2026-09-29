# Commands

Environment commands accept `-n/--name NAME` or `-p/--prefix PATH`. Without either, they use the active environment (`WOMA_PREFIX`). If no environment is active, they fail: there is no default environment. Named environments live in `$WOMA_HOME/environments/<name>`, and `WOMA_HOME` defaults to `~/.woma`.

## Environments

| Command | Effect |
| --- | --- |
| `init [bash\|zsh] [--reverse] [--dry-run]` | Install or remove the shell integration used by `activate`. The rest of your profile is preserved. |
| `create -n NAME AGENT... [SOURCE...]` | Create an environment. `AGENT` is `claude` or `codex`. Woma uses the agents installed on your PATH and does not manage their versions, so `codex@VERSION` is refused. A missing agent is reported, not fatal. Optional sources are installed in the same step. |
| `create -n NAME -f FILE` | Create from an environment file (`environment.yaml`), an exact lock (`woma.lock`, including Woma 0.7 locks), or a pack (`.tgz`). Relative local sources in an environment file resolve beside the file. |
| `activate NAME` / `activate -p PATH` | Select the environment in the current Bash/Zsh shell: set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so the installed agents use it. `PATH` is untouched. Nothing is installed or written. |
| `deactivate` | Restore the variables saved at activation, including the difference between unset and empty. Environments never stack. |
| `run [-n NAME] COMMAND [ARGS...]` | Run one command in an environment without activating it. Arguments, exit status and signals pass through unchanged. Options after `COMMAND` belong to that command. |
| `list [--json]` | Show agents (the installed version and location), packages (kind, agents, source and commit) and MCP servers. |
| `env list [--json]` | List known environments with their agents. `*` marks the active one. Woma 0.7 environments are labeled for recreation. |
| `env remove [-y]` | Delete an inactive environment and all of its local state, including sign-in and sessions. Asks for confirmation unless `-y` is given. |
| `doctor` | Check that each agent is installed, and check managed files, snapshots, native registrations and interrupted transactions. Shows how each agent will sign in. Nothing is repaired. |

## Packages and agents

| Command | Effect |
| --- | --- |
| `install SOURCE...` | Snapshot and install packages. Skills go to every agent the package supports. Native plugins go to their own agent and are enabled. Existing packages keep their locked versions. |
| `install claude` / `install codex` | Add an agent to the environment. Existing Skills and MCP servers are installed for it. |
| `install SOURCE --subdir PATH --commit SHA` | Select a Git subdirectory and an exact commit (one source only). |
| `update [NAME...]` | Re-resolve the named packages from their recorded sources, together with their dependencies. With no names, every direct package is refreshed. Agents are not updated by Woma: use `claude update`, `npm install -g @openai/codex`, or however you installed them. |
| `remove NAME...` | Remove direct packages and prune dependencies nothing else needs. `remove codex` removes an agent; its `home/codex` sign-in and sessions stay on disk. The last agent cannot be removed. |
| `search QUERY [--limit N]` | Search [skills.sh](https://skills.sh). Results are `NAME@owner/repo` sources, ready for `install`. |

Package sources:

| Source | Meaning |
| --- | --- |
| `./path`, `~/path`, `/abs/path`, `path/SKILL.md` | A local package. It is snapshotted when installed and is not read again afterwards. |
| `gh:owner/repo[/path][#ref]` | A GitHub repository or one of its directories, at a branch, tag or commit (default: `HEAD`). |
| `https://github.com/owner/repo/tree/REF/path` | A GitHub browser URL. `blob/.../SKILL.md` URLs work too. |
| `NAME@owner/repo[#ref]` | A plugin or Skill named `NAME` in a repository. Woma looks in the Claude marketplace (`.claude-plugin/marketplace.json`), then the Codex marketplace (`.agents/plugins/marketplace.json`), then `SKILL.md` names. |
| `https://skills.sh/owner/repo/NAME` | Same as `NAME@owner/repo`. |
| `https://host/repo.git#ref::path`, `git@host:repo.git`, `git+file:///repo` | Any Git repository, with an optional ref and subdirectory. |

## MCP servers

| Command | Effect |
| --- | --- |
| `mcp add NAME -- COMMAND [ARGS...]` | Add or replace a stdio server for every agent in the environment. |
| `mcp add NAME --url URL` | Add a streamable HTTP server. |
| `--env KEY=VALUE` | A literal, non-secret variable for the server. |
| `--env-var NAME` | Pass `NAME` from your shell to the server. Only the name is stored. |
| `--bearer-token-env-var NAME` | Send `Authorization: Bearer $NAME` to an HTTP server. |
| `--agent claude` | Register the server only for the given agent (repeatable). |
| `mcp remove NAME...` | Remove servers. An entry that was edited outside Woma is left in place. |
| `mcp list [--json]` | List servers. |

## Export

| Command | Effect |
| --- | --- |
| `export [-f FILE]` | Write the environment file: agents, direct package sources and MCP servers. With `-f`, local paths are written relative to the file's directory. |
| `export --explicit [-f FILE]` | Write the exact lock: the agents, every package's commit or snapshot integrity, the full dependency graph, and MCP servers. |
| `export --pack FILE` | Write a single `.tgz` file containing the exact lock and every package snapshot. |

Environment files, locks and packs do not depend on the operating system: one made on Linux works on macOS.

In both the environment file and the lock, a local package whose directory is a clean checkout of an already-pushed commit is written as that Git commit. Other local packages are listed on stderr as not portable.

`claude` and `codex` are your own installations; `woma run -n NAME claude` runs the one on PATH with that environment's home. Start a new agent session after changing an environment, because a running agent may keep its startup configuration.
