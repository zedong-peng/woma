# Architecture and isolation model

> [!NOTE]
> This document describes the current implemented architecture. The proposed next Environment model is documented in
> [Reproducible multi-Agent environments](proposals/reproducible-multi-agent-environments.md).

## Ownership boundaries

Woma manages reusable Agent capabilities and isolated Agent homes. Repository knowledge and Agent Memory remain outside its ownership boundary.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$WOMA_HOME/packages/` |
| Environment recipes and locks | User-global | `$WOMA_HOME/environments/<name>/` |
| Agent Environment views | User-global | `$WOMA_HOME/environments/<name>/view/` |
| Opaque Agent state | Per Environment | `$WOMA_HOME/environments/<name>/home/<agent>/` |
| Skill migration snapshots | User-global | `$WOMA_HOME/migrations/skills/<skill-name>/<content-hash>/` |
| One-time initialization state | User-global | `$WOMA_HOME/initialization.json`, `$WOMA_HOME/default-environment` |
| Mutation locks | User-global | `$WOMA_HOME/locks/` |
| Environment selection | Current shell | `WOMA_ENV`; the shell hook uses the initialized default when unset |

An Environment recipe records root Packages and Agent targets. Its lock records the exact recursive dependency closure. Multiple Environments referencing the same Package resolution share one immutable cache entry. Uninstalling a root recomputes reachability from every remaining root, retains shared dependencies, and removes newly unreachable Packages only from that Environment's lock and managed view; immutable Package Store entries remain shared and untouched.

`base` is lazily initialized on first use and cannot be removed. It starts with an empty root Package set and clean managed Agent configuration; it does not seed provider settings or credentials from an original Agent home. Before implicit creation outside `woma init`, Woma performs metadata-only checks on the fixed original Codex/Claude Skill and session paths supported by migration. It does not enumerate directory children, read contents, follow symlinks, or retain discovered details. If relevant state exists, the CLI emits one notice explaining that `woma init` can perform the supported Codex import. Creating `base` is not the initialization boundary: a later first `woma init` still evaluates the import. Built-ins such as `woma-package-builder` and `woma-project-memory` are ordinary, explicit, removable Packages. An existing `base` is accepted only after its recipe, lock, Package closure, and complete Agent view validate successfully. A non-dry-run install or uninstall repairs the current locked Package closure before changing it; reinstalling a root Package can therefore rebuild a damaged cache or view without a separate repair command.

The first `woma init` discovers supported existing Codex state. If it finds an ordinary Skill, regular `config.toml`, or regular `hooks.json`, it creates a Codex-only Environment named `codex`, copies the two configuration files through the normal managed view, and runs the ordinary Skill migration pipeline against that destination. Each Skill becomes one validated, read-only, content-addressed Package. The original home remains unchanged, and the copy has no live or reverse link to it. Authentication, hidden system Skills, Plugins, sessions, history, caches, databases, telemetry, native memory, and unknown paths are excluded. When nothing supported exists, init creates only the clean `base`. This decision is recorded once; later source changes require explicit migration.

Explicit `woma migrate skills` remains available for Codex changes made after initialization, Claude Skills, and other destinations. Migration discovers the selected Codex and Claude sources, creates one single-Skill Package per deduplicated Skill, validates every temporary Package, and checks Package and Skill ownership against a locked target snapshot. Each read-only source directory is keyed by the Skill name and a deterministic hash of its content and origins. All changed Packages enter the normal Environment installation transaction together, so the lock, recipe, and complete view publish atomically. A repeated identical migration is a no-op; changing one Skill creates a new immutable snapshot and replaces only that Package root in the selected Environment. Dry runs never publish source snapshots or mutate the Package Store or Environment.

An ordinary Skill written through any target Agent inside an already selected Environment immediately belongs to that Environment, just as a pip-installed package belongs to its active Conda environment. Every target Agent resolves its conventional `skills` path to the same stable Environment directory, so a Skill installed through Codex, Claude Code, Pi, Qoder CLI, or OpenCode is visible to all other targets without a Woma reconciliation command. Woma discovers non-hidden direct children with valid `SKILL.md` metadata during `list`, `info`, and `doctor`, labels their origin `external`, and never infers which tool created them. These Environment-local Skills are not Woma Packages: they do not enter the recipe, lock, Package Store, or bundle, and other Environments remain unchanged. Hidden paths such as Codex-owned `.system` are excluded from inventory. Woma does not watch directories or proxy Agent processes because all targets read the same stable storage directly.

## Source normalization

Every installable locator is first materialized as a local directory and then passed through one Source Adapter. A root `woma.yaml` passes through unchanged. Otherwise, only a root standalone `SKILL.md` or direct conventional `skills/*/SKILL.md` children are copied into temporary staging with a deterministic generated manifest. Git metadata, Woma project state, dependency caches, and OS metadata are excluded by the same copy policy used for Package publication. The original source is never modified.

Optional Package scaffolding follows the provider shape of `conda skeleton`, which is supplied by the separate `conda-build` toolchain rather than `conda init`. Woma ships `skeleton workflow <name>` because a coordinating Agent Skill is a domain-specific recipe type with no Conda equivalent. It generates an editable explicit Package under an output directory and deliberately does not resolve sources, install dependencies, or replace the optional `woma-package-builder` authoring capability.

The adapter is shared by direct installation, inspection, recursive dependency resolution, and lock repair. Consequently an implicit Package has the same identity and normalized bytes when installed repeatedly or reconstructed before another Environment mutation. No recursive candidate search occurs: nested repositories, examples, vendored Skills, and Package collections cannot silently expand the ownership boundary of one install command.

## Portable Environment bundles

A `.woma-env` file is a versioned, gzip-compressed JSON document containing one Environment recipe, its exact lock, and every regular file in the locked Package closure. Binary files are Base64 encoded and file read/execute modes are preserved. Stable key ordering and a deterministic gzip stream make repeated exports of an unchanged Environment byte-identical.

Import limits compressed, decompressed, file-count, and decoded payload sizes. It rejects unsafe or duplicate paths, symbolic and special files, writable bundled modes, malformed Base64, duplicate or missing Packages, cache-key drift, Package identity or integrity drift, invalid dependency graphs, unsupported targets, `base`, and existing destination names. All Package trees are materialized and validated in temporary storage before Package Store publication. The Environment recipe, lock, and view are then published through the ordinary Environment transaction, so a normal failure leaves no partially visible Environment.

Bundles deliberately exclude per-Environment Agent homes, Environment-local external Skills, all project files, and actual environment-variable values. Source strings and Package content are retained for provenance and offline restoration; a bundle should therefore be treated as executable Package input, not as a credential, session, or project-context backup.

## Activation and direct Agent launch

Target-native projection is implemented through the formal [Agent Adapter contract](agent-adapters.md). Core first resolves
the Package closure into canonical capabilities. The selected Adapter then validates immutable artifact snapshots and returns
a declarative plan without filesystem access. One shared publisher owns staging, links, atomic view replacement, stable-home
updates, and rollback. Adding an Agent therefore does not add another publication transaction or Package schema branch.

Every Environment owns one reusable Agent view:

```text
global Environment recipe and lock
        |
        v
content-addressed Package store
        |
        v
atomic target-specific managed-resource view
        |
        v
stable per-Environment Agent homes and Adapter-declared configuration overlays
        |
        v
direct codex, claude, pi, qodercli, or opencode
```

Package Store replacements are copied into read-only immutable generations and fully validated before an atomic cache-key symlink switch. Skill directories in every view resolve through that stable cache pointer, so repair readers see either the old or new Package and never a missing entry. Every Environment update builds a complete `.view.gen-<id>` directory and atomically replaces the stable `view` symlink, so direct Agent readers never observe mixed Skill, MCP, and Hook generations. Recipe and lock metadata commit under the Environment lock before the view pointer changes and roll back if publication fails.

Each Environment has stable target Agent homes that are never generation-swapped and one real `home/skills` directory shared by all targets. Every target home's conventional `skills` path links to that directory. Woma-owned Skill entries inside it link through the atomic `view/skills` projection, while non-hidden ordinary additions are Environment-local Skills with external origin. Other Environment-specific configuration links through Adapter-declared target views: Codex `config.toml` and `hooks.json`; Claude `.credentials.json` and `settings.json`; Qoder `settings.json`; and OpenCode `opencode.json`. Codex owns the ordinary `auth.json` in its stable Environment home; Woma does not seed it from the original home or include it in managed views. The clean `base` does not seed configuration or credentials. Other named Codex and Claude Environments seed supported provider settings and Claude credentials from the original Agent home only when first built, then inherit from the current generation so user edits through `$CODEX_HOME` or `$CLAUDE_CONFIG_DIR` survive later publication. The automatic `codex` import uses this one-time seed. Pi settings, credentials, model catalogs, Pi Packages, and sessions are ordinary Pi-owned files in the stable `$PI_CODING_AGENT_DIR`; a new Environment does not copy the original `~/.pi/agent` state. Woma strips and regenerates its marked Codex MCP blocks and exact Codex, Claude, and Qoder Hook entries while preserving user-owned settings in the Environment copy. Claude `.claude.json` remains in the stable home, where Woma transactionally updates only Package-managed `mcpServers`. Pi has no Woma MCP or Hook strategy, so Package validation rejects those resources instead of silently omitting them. Qoder MCP servers and Hooks live directly in the managed `settings.json` view. Woma never seeds or captures Qoder credentials; login state is ordinary Qoder-owned opaque data in the stable Environment home. OpenCode Skills and MCP servers use `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` overlays; Hooks are unsupported, and Woma deliberately does not override `XDG_*` or claim provider authentication, MCP OAuth, session, cache, or Plugin state. Those ambient OpenCode data paths may therefore be shared across Woma Environments.

Every other path is opaque Agent-owned state. Environment-local Skill inventory enumerates only direct, non-hidden children of the shared Skill root and reads only their `SKILL.md` frontmatter; it does not hash, copy, adopt, or package them. Apart from that read-only inventory, Environment initialization and view publication do not inspect unknown files, including SQLite main, WAL, and SHM files. `woma migrate sessions` is a separate explicit operation over documented session and history paths: it builds and verifies a link-free temporary snapshot, preflights target conflicts, structurally merges JSONL records, then publishes ordinary files into the selected stable home under the Environment lock. Structured files are atomically replaced and restored on ordinary publication failure. Retired generations contain only managed resources and remain available to processes that still have those files open.

`woma init` follows Conda's shell-initialization user model while adding one Agent-specific bootstrap. Redirecting `CODEX_HOME` without carrying forward supported capabilities would make an established Codex setup appear to disappear, so first init automatically creates the clean `base` and, when supported Codex state exists, the separate imported `codex` Environment described above. This is an intentional difference from `conda init`: Woma copies a narrow allowlist into a new managed Environment rather than adopting or modifying an arbitrary original home. It does not manage, copy, or lock the Codex executable.

Initialization validates the shell edit, Codex configuration, Hooks, and Skill import before publication, records a versioned `pending` state, and advances it to `complete` only after the default Environment is durable. Woma stages an ownership marker and atomically renames that reservation into the `codex` Environment root before creating the recipe. A process interruption therefore leaves either no destination or a marker-matched destination that pending init can resume. An existing unmarked `codex` name is a conflict. Creation, Skill installation, state commit, and rollback share the `codex` Environment lock; rollback deletes only a marker-matched Environment. The initialization lock serializes concurrent init, rename, and remove commands. Renaming the selected default follows the new name, and removing it resets the default to `base`; reference writes happen before the Environment mutation and roll back on ordinary failure, so an interruption preserves the old Environment rather than deleting the referenced state. A later init falls back to `base` if a recorded non-base default is incomplete. A dry run performs the same input validation but publishes nothing. Repeated init uses the completed decision and never resynchronizes the original home. `--reverse` removes only the static hook and managed profile block, preserving Environments, the default, and initialization state.

The rendered hook is static, so ordinary shell startup never launches Node, mutates Woma state, or acquires locks. It saves the original Codex, Claude, Pi, Qoder, and OpenCode configuration variables, reads `$WOMA_HOME/default-environment` when `WOMA_ENV` is unset, and selects only an Environment with a complete view. Init writes `codex` as the default after an import and `base` otherwise. A stale selection falls back to an existing `base`; if that is unavailable, the hook restores every original Agent home. It parses only a real top-level `activate` or `deactivate` command, never proxies `codex`, `claude`, `pi`, `qodercli`, or `opencode`, and restores unsupported target variables. A successful `deactivate` clears the shell selection and restores the original Agent homes; `woma activate base` selects the clean baseline explicitly.

Environment recipes and view metadata intentionally have no schema-version field during the initial build stage. Strict structural validation defines the current format, and version-like fields are rejected instead of enabling compatibility branches. Explicit Skill and session migration import documented Agent-owned state and do not migrate Woma schemas.

The current `woma-project-memory` built-in reuses the Package name but not the former core behavior. It enters an Environment only through explicit installation and follows ordinary root, lock, view, bundle, and removal semantics. Its Skill may read project-owned `.woma/memory.md` when selected and may update that file only on an explicit user request. The Woma runtime does not invoke the Skill, expose Memory paths, or inspect its project data.

`woma run` launches one command with a selected Environment's Agent homes without changing the parent shell. Woma does not maintain session-to-Environment metadata. Resuming a session under a different Environment is user-managed.

## Conda parity

The implementation provides:

- one global physical Package cache;
- global named Environment recipes and independent dependency locks;
- one global target-specific view per Environment;
- Environment-isolated Skill, MCP, and Hook visibility;
- direct Agent launch through stable shell-selected per-Environment homes;
- Environment-isolated opaque Agent state when the Agent exposes a dedicated home selector, with explicit ambient-state limitations otherwise;
- no ownership of Agent Memory or project context;
- safe root Package removal with orphan dependency pruning and immutable cache retention.

Updating an Environment transactionally refreshes the managed paths in its global view. All projects and newly started Agent processes selecting that Environment therefore observe the same package closure without reactivation. Already-running Agent processes may retain startup-time Skill discovery and should be restarted after an Environment change.

Woma does not yet bind Agent session IDs to Environments. A resumed session uses whichever Environment is selected in the current shell; maintaining that consistency remains the user's responsibility.

## Transaction boundary

Environment mutations are serialized with filesystem-backed per-Environment locks. Activation holds the target lock through validation and shell selection, preventing concurrent install or uninstall from invalidating the selected generation. Recipes and locks are re-read inside the lock, and multi-file inspection uses the same locked snapshot. Package cache publication, reads, permission changes, corruption repair, and verification use per-Package locks. Package resolution and validation complete before one complete view generation is atomically published. Install and uninstall repair the current lock first and share the same publication path: recipe, lock, shared Skill links, stable managed-home links, Package-managed Claude MCP fields, and the complete view pointer remain inside the ordinary-error rollback boundary. Ordinary Environment-local Skills are otherwise outside Woma transactions. Abrupt process termination and unanticipated filesystem failure remain outside the guarantee because there is no persistent transaction journal.
