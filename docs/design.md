# Woma Design

## Positioning

Woma is a Conda-like environment manager for AI coding agent harnesses.

An AI agent is a base model plus a harness: the Skills, plugins, and MCP servers it can call. Woma gives a chosen harness an identity, isolates it from other harnesses, and gives it a lifecycle: create, install, switch, update, export and recreate.

The 1.0 release is built around four user scenarios:

1. **Share a harness.** Someone assembles Skills from GitHub, registries, plugin marketplaces and local folders, and others recreate exactly that setup from one file (`environment.yaml`, `woma.lock`, or a pack).
2. **Isolate harnesses.** Separate work, such as paper writing and development, uses separate environments that evolve independently.
3. **Share across agents.** Claude Code and Codex in the same environment use the same Skills and MCP servers.
4. **Attribute results.** An experiment or evaluation can name the exact harness it ran with. Direct Harbor integration is planned.

## Scope

An environment contains:

- one or more agents (Claude Code, Codex) to wire up. Woma uses the agents installed on the user's PATH and does not download, pin or update them
- packages: Skills, native plugins, and dependency collections, each locked to a Git commit or a content snapshot
- MCP servers, with secrets referenced by environment-variable name

Model, provider and permission settings, sign-in, sessions, caches, Memory, project configuration, external executables and remote services are outside the environment. The agent or the user owns them. Credential values never enter an environment file, lock or pack.

## Conda reference

[Conda environments](https://docs.conda.io/projects/conda/en/latest/user-guide/concepts/environments.html) provide the user model: a directory holds an independently evolving installation set, a name locates it, and activation selects it for a shell. Woma follows the `create`, `install`, `update`, `remove`, `list`, `search`, `env list`, `activate`/`deactivate`, `run`, `export` and `-n`/`-p` conventions. `environment.yaml`, `export --explicit` and `export --pack` correspond to `environment.yml`, `conda list --explicit` and `conda-pack`. The shared content store corresponds to Conda's package cache.

Package identity follows Conda's "package from a channel at a version" idea. A Skill is identified by its source (a repository and path, a name in a repository or marketplace, or a local directory) and a version (a ref locked to a commit), and it is verified by a content hash. Registries (skills.sh, Claude Code plugin marketplaces, the openai/skills catalog) only resolve names to repository locations. Locking, verification, export and recreation are Woma's responsibility. The [Conda reference study](conda-reference.md) records how Conda treats foreign and manually edited packages.

Intentional differences from Conda:

- **No base environment.** There is no implicit base and no auto-activation.
- **No silent re-solving.** No dependency solver silently changes existing resolutions.
- **Opaque native state.** Native configuration and runtime state stay opaque, except for the specific keys Woma owns.
- **Content, not behavior.** Exact locks guarantee managed content, not agent versions or model behavior.
- **Agents are not packages.** Conda installs the interpreter; Woma leaves Claude Code and Codex to the user's own installer and only points them at an environment.

## Storage

```text
$WOMA_HOME/
  store/v2/<sha256>/...         immutable, read-only package content
  environments/<name>/...       named prefixes
  prefixes.json                 known explicit prefixes
  locks/...                     serialized Woma writers

<prefix>/
  home/claude/                  CLAUDE_CONFIG_DIR: real native home and writable state
  home/codex/                   CODEX_HOME
  .woma/
    state.json                  authoritative lock and owned-path inventory
    marketplace/...             Codex-only local plugin marketplace
    transactions/...            temporary publication backups and journal
```

The modules are split by responsibility:

| Module | Responsibility |
| --- | --- |
| `source.ts` | Source syntax, Git fetch |
| `registry.ts` | Named resolution through marketplaces and Skill names; skills.sh search |
| `package.ts` | Package records, agent targeting, dependency closure, Git-origin detection |
| `agents.ts` | Finding the installed agents and their versions |
| `native.ts` | Agent layout and native configuration edits |
| `transaction.ts` | Publication |
| `portable.ts` | Portable export and packs |
| `environment.ts` | Environment operations |

Every environment gets its own copies of Skills and plugins, because agents may write to them and edits must be detectable as drift. Writable native state is never shared through the store, and no mutable configuration file is a symlink.

## Modification protocol

Environment writers take a lock keyed by the canonical prefix. A change runs in this order:

1. Validate existing content.
2. Resolve requested changes and dependency constraints.
3. Verify snapshots.
4. Stage managed files.
5. Prepare narrow native configuration edits: plugin registration and owned MCP entries.

Every write checks the expected previous content, and the authoritative state file is published last.

On an ordinary failure, Woma restores only the paths it changed. If an external writer changes a path during rollback, Woma keeps that path and its backup and reports an incomplete rollback. An interrupted transaction blocks later changes and is reported by `doctor`. This is not a crash-safe database.

Woma does not adopt source changes during activation, import native content automatically, copy whole configurations, or merge runtime state. Explicit adoption snapshots and validates a native installation before recording ownership. An owned MCP entry that was edited natively is never overwritten; Woma reports it instead.

## Reproduction boundary

- **Environment file.** Records direct intent: agents, package sources and MCP servers.
- **Lock.** Records the exact package closure. It does not depend on the operating system.
- **Pack.** Adds every package snapshot, so local-only packages travel too.

Exports read Woma metadata, except in one case: turning a pushed local checkout into a portable Git source reads Git metadata from that checkout. All digests are verified on recreation, and Git sources must remain retrievable at their locked commits unless cached. Recreating an environment does not reproduce agent versions, credentials, sessions, caches, Memory, provider settings, plugin enable choices, external commands, remote services, projects or model behavior.

## Compatibility

Environment format v3 (Woma 1.0) supports multiple agents per environment and MCP servers.

- **Woma 0.7 (v2).** v2 environments are listed and can be exported. Their locks and recipes can be used with `create -f`. To change one, recreate it: `woma export -p OLD --explicit -f old.lock`, then `woma create -n NEW -f old.lock`. Sign-in and sessions are not carried over.
- **v1.** v1 environments are listed as legacy and never touched.
