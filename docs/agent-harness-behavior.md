# What Woma Owns

Each environment contains one or more agents. Each agent has a stable, real native home: `home/claude` or `home/codex`. Activation sets each agent's home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) so the user's installed agents use the environment; `PATH` is untouched. It does not load packages or copy native state. Two shells can select different environments independently. Switching restores the saved original variables before applying the new selection, so environments never stack. Deactivation restores unset variables as unset and empty variables as empty.

| Surface | Owner | What Woma does | Exported |
| --- | --- | --- | --- |
| Agent executables (`claude`, `codex`) and their versions | User | Not installed, pinned or updated; `list` and `doctor` report what is on PATH | Only which agents the environment uses |
| Installed Skills and plugins | Woma | Snapshot, validate, update and remove; detect drift | Source, commit and integrity |
| MCP servers declared in the environment | Woma | Write the owned entries; report and preserve native edits | Yes, with secrets referenced by variable name only |
| Plugin and marketplace registration keys | Woma, with the local enable choice | Structural edits with change checks | Reconstructed; enable choice not exported |
| Model, provider, permission and other settings | User or agent | Preserve | No |
| Native installations outside Woma ownership | User or agent | Preserve; adopt only when that path is installed explicitly | No |
| Sign-in, sessions, caches, Memory | User or agent | Preserve; `doctor` reports only whether a sign-in exists | No |
| Project configuration, keychains, external commands and services | External | Not managed | No |

**Native installations.** Native tools may install new content under an agent home. Woma does not scan for it or add it to the environment automatically. `woma install <path>` snapshots and validates a package first. If the source is exactly the native destination Woma would own, the existing content is adopted. A different source colliding with unmanaged content fails.

**MCP servers.** Servers added with `woma mcp add` or listed in an environment file are written into each agent's native configuration. A server with the same name that you added natively is replaced when you add it through Woma. If you later edit a Woma-owned server natively, `doctor` reports it, Woma refuses to overwrite it, and removing it from the environment leaves your edited entry in place.

**Configuration files.** Replacing `config.toml`, `settings.json` or `.claude.json` atomically in an editor is supported. These are ordinary files, never links. Changing a plugin's enable state is local configuration, not drift. Changing managed package files is drift: `doctor` reports it, and update and remove refuse to touch the changed files.

**Concurrency.** Woma serializes its own changes. External writers are not part of its lock protocol. Changes are checked immediately before publishing, and rollback keeps unexpected writes, together with a diagnostic and a retained backup. Do not run native installers during a Woma change. A running agent may keep its startup configuration, so start a new session after a change.

**Clean by default.** New environments have no default packages. Woma does not migrate sign-in, copy provider configuration, scan native homes, activate implicitly, or read credentials. User, project and system configuration and OS keychains may still influence native behavior. Selecting an environment is not a sandbox.

**Removing things.** Removing an agent (`woma remove codex`) deletes its launcher, its release link and Woma's installations for it, but keeps `home/codex` with its sign-in and sessions. `env remove` deletes the whole environment directory, including sign-in, sessions, caches, Memory, configuration and unmanaged installations; its prompt lists that loss. The shared content store remains, but neither an environment file nor a lock is a backup of native state.
