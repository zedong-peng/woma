# Changelog

## 1.0.0 - 2026-09-29

First stable release. Woma manages the harness of your Claude Code and Codex (Skills, plugins and MCP servers) as one named, shareable, reproducible environment.

- **Multi-agent environments.** One environment can hold Claude Code and Codex together (`woma create -n NAME claude codex`). Skills and MCP servers are installed once for every agent; native plugins go only to their own agent. Agents can be added (`woma install codex`) and removed (`woma remove codex`, which keeps that agent's sign-in and sessions on disk).
- **Breaking: Woma uses your installed agents.** Woma no longer downloads, pins or wraps Claude Code and Codex. Every environment runs the `claude` and `codex` on your PATH; activation only sets `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and leaves `PATH` alone. `codex@VERSION` and `woma update codex` are refused with a pointer to your own installer. `list` shows the installed version and location, and `create`, `activate` and `doctor` report a missing agent with its install command. Environment files list agents as `agents: [claude, codex]`.
- **Locks and packs work across operating systems.** With no agent binaries in them, a lock or pack made on Linux recreates the environment on macOS, and vice versa.
- **Skills as versioned packages.** New sources: `gh:owner/repo/path#ref`, GitHub browser URLs, and `NAME@owner/repo[#ref]`. Named sources are resolved through Claude Code plugin marketplaces, Codex plugin marketplaces and `SKILL.md` names, so `pdf@anthropics/skills`, `yeet@openai/skills` and `skill-creator@anthropics/claude-plugins-official` all work. Every source is locked to a commit and a content hash.
- **Search.** `woma search QUERY` searches the skills.sh directory.
- **Folders of Skills.** A directory whose child directories contain `SKILL.md` installs as one Skill collection.
- **MCP servers.** `woma mcp add/remove/list` manages MCP servers, written natively to Codex `config.toml` and Claude Code `.claude.json`. Secrets are referenced by variable name (`env_vars`, `bearer_token_env_var`) and never stored. Native edits to Woma-owned entries are reported and never overwritten.
- **Portable exports.** `woma export` writes a hand-editable `environment.yaml` with portable sources, and local paths relative to the output file. A local package that is a clean checkout of a pushed commit is exported as that Git commit. `woma export --pack FILE` writes a single `.tgz` including local-only packages. `woma create -f` accepts environment files, locks and packs; environment files may list bare sources.
- **Plugins enabled on install.** Installing a native plugin now enables it. Later native enable/disable choices are preserved.
- **Sign-in guidance.** `create` and `doctor` show how each agent will authenticate, and recommend tokens exported in the shell (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) to share one sign-in across environments. Woma still never reads or copies credentials.
- **Friendlier CLI output.** `list`, `install`, `update` and `env list` are clearer.
- **License.** MIT.
- **Breaking: new layout.** Environment format v3: agent homes move to `home/claude` and `home/codex`, and recipes use `agents:` instead of `harness:`/`runtime:`. Woma 0.7 environments are listed and can still be exported; recreate them with `woma export -p OLD --explicit -f old.lock && woma create -n NEW -f old.lock`. Woma 0.7 locks and recipes are accepted by `create -f`; their pinned agent release is ignored.
- **Breaking: removed files.** The `woma-project-memory` example package, `docs/project-memory.md`, and the v1 `.woma/` project files in this repository are gone. Woma does not manage Memory.

## 0.7.0 - 2026-09-12

First release of the v2 environment contract. Breaking: v1 environments, commands, and
bundles are superseded and require explicit recreation.

- Replace the multi-target projection model with v2 single-harness environments and independently pinned official Codex/Claude runtime releases.
- Add explicit runtime/package updates, native Plugin installation, stable real configuration files, selective registration ownership, and transactional rollback with drift checks.
- Standardize name/prefix selection, shell-only activation, child execution with signal propagation, recipe export, and exact managed-content locks.
- Remove implicit base/bootstrap, automatic import, capture, shared writable Skills, generic MCP/Hook translation, and offline bundles. Legacy environments remain untouched and require explicit recreation.
- Update documentation and examples to the minimal package format. `performance-engineering` is now a plain Skill package; the native Claude example demonstrates an upstream Hook format.

## Previous v1 Development

These entries describe the superseded implementation, not the v2 command contract.

- Added a formal pure `AgentAdapter` contract, canonical capability projection layer, static built-in registry, and one shared transactional publisher; migrated Codex, Claude Code, Pi, and Qoder CLI projections and added OpenCode Skills/MCP support through `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` overlays without overriding `XDG_*` or claiming native credentials, sessions, caches, Hooks, or Plugins.
- Added automatic first-run bootstrap to `woma init`: it creates a clean `base`, detects supported existing Codex state, creates a separate `codex` Environment with a one-time copy of `config.toml` and `hooks.json`, snapshots ordinary Skills as Packages, and selects the imported Environment by default without changing the original Codex home.
- Added versioned `pending`/`complete` initialization state, atomically reserved imported-Environment ownership markers, collision refusal, locked rollback, read-only dry runs, and shell startup selection from the initialized default; repeated initialization never synchronizes later source changes, rename/remove serialize and roll back default reference updates, and `init --reverse` preserves bootstrap state and Environments.
- Made `base` configuration and credentials clean by default and made Codex Hook views continue from their Environment-local copy instead of rereading the original home.
- Proposed reproducible multi-Agent Environments containing one or more version-locked Agent Runtime Packages, isolated per-Agent homes, and one Agent-independent capability Package closure; recognized Agent-native capability installations become Packages on the next explicit activation, while benchmark orchestration remains outside Woma's platform boundary.
- Changed Codex `auth.json` to Agent-owned opaque state: new Environments no longer read or seed it, view updates no longer manage it, and legacy Woma credential links detach transactionally into ordinary stable-home files.
- Breaking: removed Woma-owned Project Memory, startup injection, and Memory paths in `info --json`. Environment schema v2 starts empty and upgrades v1 by pruning the exact formerly implicit helper roots without touching user-owned Memory data. `woma-project-memory` remains available as an explicit, removable ordinary built-in Package with no core or Agent-native Memory integration.
- Breaking: renamed the project, npm package, CLI, environment variables, paths, manifests, bundle format, and built-in Packages to Woma. Existing installations and project metadata must be recreated with the Woma names.
- Added opt-in Qoder CLI Agent targets with isolated `QODER_CONFIG_DIR` homes, atomic Skill views, Package MCP servers and Hooks merged into the managed `settings.json`, shell activation, and inclusion in `--target all`; Woma does not capture, migrate, or seed Qoder credentials or sessions.
- Added Conda-style top-level `create`, `export`, `remove`, `run`, and `rename` commands; portable bundles are now restored with `create --file`, and the former `env import` command has been removed.
- Changed `woma deactivate` to leave Woma Environment management, restore the original Agent homes, and clear the shell selection; use `woma activate base` to select Woma `base` explicitly.
- Removed the public `woma shell` command; `woma init` is now the sole shell-integration entrypoint and continues to install a static startup hook.
- Added one stable Skill root per Environment shared by every target Agent, so an ordinary Skill installed through Codex, Claude Code, Pi, Qoder CLI, or OpenCode is immediately visible to all targets without a second command; legacy per-Agent layouts merge transactionally, automatically deduplicate verifiably equivalent same-name entries, reject differing collisions, keep hidden state excluded from inventory, and leave other Environments isolated.
- Removed the public `woma sync` command; install and non-dry-run uninstall now repair the existing locked Package closure before applying their requested mutation.
- Added `woma remove` (`uninstall` alias) with active-or-named Environment selection, dry-run resource plans, shared-dependency retention, orphan pruning, and atomic rollback across recipes, locks, stable Agent homes, and views.
- Added direct Git subdirectory installation with optional full-commit selection and immutable commit/content-integrity provenance preserved through Package repair, `woma list`, and portable bundles.
- Reassigned `woma init` to Conda-style shell initialization with a static hook, managed profile block, dry-run, reversal, and post-install guidance; moved its former Package scaffold to the provider-oriented `woma skeleton workflow` interface while retaining `woma-package-builder` for full authoring.
- Made shell-hook generation read-only and independent of Environment initialization, locks, validation, Package loading, and repair, with bounded shell-side fallback to the original Agent homes.
- Added opt-in Pi Agent targets with isolated `PI_CODING_AGENT_DIR` homes, atomic Skill views, shell activation, and explicit rejection of unsupported Pi MCP/Hook resources.
- Changed explicit Skill migration to create and atomically install one independently versioned Package per Skill.
- Added `woma list` to show an Environment's locked Packages and every Package-managed Skill, MCP server, and hook with providing Package versions and effective target platforms.
- Added a current-user Codex/Claude process check and mandatory interactive confirmation before migration while an Agent is running.
- Added explicit `woma migrate sessions` snapshots from original Agent homes into Environment-owned ordinary files, including structured JSONL history merging, without implicit initialization-time migration or links back to the source.
- Replaced shared runtime adoption with stable per-Environment Agent homes and inherited managed provider settings and Claude credentials, so unknown state and SQLite databases are never copied across view generations. Codex credentials remain Codex-owned opaque state.
- Added deterministic installation of standalone Skills and direct conventional multi-Skill sources through one shared Source Adapter.
- Added the optional `woma-package-builder` for wrapping resources and creating dependency-based Packages with optional coordinating Skills.
- Added explicit migration of existing Agent Skills into a selected Environment and stable per-Environment Codex system Skills.
- Added deterministic, offline-capable Environment bundle export/import with complete Package closures and atomic destination publication.
- Added global, content-addressed Package storage and user-global named Environment recipes and locks.
- Added atomic global per-Environment Codex and Claude views backed by Package Store symlinks.
- Added shell selection of stable Environment Agent homes for direct `codex` and `claude` launches.
- Added cross-process Environment, Package Store, and project activation locks with stale-lock recovery.
- Added an implicit, non-removable `base` Environment.
- Made Package Store entries read-only and Agent view publication generation-atomic.
- Made `base` repairable from its lock even when its cache or view is damaged.
- Hardened shell selection, Package identity, exact Skill visibility, and canonical project locking.
- Added recursive Package dependencies and installable natural-language methods expressed by ordinary coordinating Skills.
- Added atomic Environment view updates and installation with ordinary-error rollback.
- Added `woma info --json` as the machine-readable Environment interface.
