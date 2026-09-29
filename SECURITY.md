# Security Boundaries

Woma installs code and instructions chosen by the user. An integrity digest proves content identity, not trustworthiness. Review package sources before installing them. **Native plugins are enabled when installed**, and their Hooks and MCP commands then run under the agent's own permissions and lifecycle. Woma does not reinterpret or sandbox them.

## Sources and registries

- **Agent releases.** Official npm release artifacts are downloaded over HTTPS and checked against the registry's SHA-512 integrity. Archive paths and file types are validated, and a SHA-256 snapshot integrity is recorded. Package scripts and global installers never run. Unsupported release layouts fail. Woma never falls back to a system agent executable, and agent auto-update checks are disabled where supported.
- **Git sources.** Git sources resolve to full commits. Credentials in HTTPS URLs are rejected; use Git's credential helper. Git submodules, symlinks, special files, archive links and path traversal are refused.
- **Named sources.** `NAME@owner/repo` reads marketplace manifests and `SKILL.md` names inside a repository. A marketplace entry may point to a third-party repository, and Woma fetches that repository at the recorded commit or ref. `woma search` only lists results from skills.sh. Neither is an endorsement.
- **Local sources.** Local sources become immutable snapshots. Snapshots omit `.git`, `.woma` and `.DS_Store`; everything else is kept, so do not put secrets in a package directory. Woma refuses to snapshot native homes or directories that contain native state files such as `auth.json` or `.credentials.json`.

## Secrets and sign-in

- **Credentials.** Woma never reads, copies or links agent credentials. `woma doctor` checks only whether a credential file or token variable exists, never its value.
- **MCP servers.** `env_vars` and `bearer_token_env_var` record variable *names* only; values are read from the user's shell when the server starts. Literal `env` values are stored in the environment and in its exports, so they must not contain secrets.

## Exports and packs

Exports read Woma metadata only and never scan or archive native homes. They can still disclose repository URLs and local paths, so review them before sharing. A pack (`--pack`) contains the full content of every installed package; review it like a source archive before sharing.

To turn a local package into a Git source for export, Woma runs read-only Git commands in the source repository: it reads the status, the remote-tracking branches, the remote URL, and an archive of the commit. It uses a pushed commit only when that commit's content is byte-identical to the installed snapshot.

## Environment integrity

- **Store.** Package snapshots live in the read-only content store. Do not modify files under `.woma/`.
- **Agents.** Woma runs the `claude` and `codex` found on your PATH and does not verify or update them; install them from their official sources.
- **What Woma owns.** Woma owns only its installed paths and the registration keys it wrote. It leaves user settings, native installations, sessions, credentials, caches and Memory in place. MCP entries changed outside Woma are reported and never overwritten silently.
- **Concurrency.** Environment writers serialize by prefix. Content drift blocks further changes. On an ordinary failure Woma rolls back its own changes; unexpected external edits are kept, along with backup paths and a diagnostic. Concurrency safety does not extend to writers that ignore Woma's lock, and there is no automatic crash recovery. After an interrupted transaction, review its journal and backups before changing the environment again.

## Scope

Activation selects an environment for the shell; it is not a security boundary. Native tools may still use OS keychains, project settings, external services and inherited environment variables. Run untrusted packages in an appropriate sandbox.

Deleting an environment permanently removes its whole directory and all local native state. The confirmation prompt lists what will be lost, and neither a lock nor a recipe can restore it. Legacy environments are never migrated or deleted automatically.
