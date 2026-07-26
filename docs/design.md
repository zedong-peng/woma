# Architecture and isolation model

## Ownership boundaries

Harness Conda separates reusable Agent capabilities from repository knowledge.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$HARNESS_HOME/packages/` |
| Environment recipes and locks | User-global | `$HARNESS_HOME/environments/<name>/` |
| Codex, Claude, and Pi Environment views | User-global | `$HARNESS_HOME/environments/<name>/view/` |
| Opaque Agent state | Per Environment | `$HARNESS_HOME/environments/<name>/home/<agent>/` |
| Explicit Skill migration snapshots | User-global | `$HARNESS_HOME/migrations/skills/<skill-name>/<content-hash>/` |
| Mutation locks | User-global | `$HARNESS_HOME/locks/` |
| Environment selection | Current shell | `HARNESS_ENV` (defaults to `base`) |
| Shared and Package-specific Memory | Project-local | `<project>/.harness/memory/` |
| Machine-specific Memory | Project-local, uncommitted | `<project>/.harness/local/` |

An Environment recipe records root Packages and Agent targets. Its lock records the exact recursive dependency closure. Multiple Environments referencing the same Package resolution share one immutable cache entry. Uninstalling a root recomputes reachability from every remaining root, retains shared dependencies, and removes newly unreachable Packages only from that Environment's lock and managed view; immutable Package Store entries remain shared and untouched.

`base` is lazily initialized on first use and cannot be removed. Before its first successful creation, Harness performs metadata-only checks on the fixed original Codex/Claude Skill and session paths supported by explicit migration. It does not enumerate directory children, read contents, follow symlinks, or retain discovered details. If relevant state exists, the CLI emits one notice to stderr after successful creation; the base recipe itself is the durable one-time boundary. Initialization never imports ordinary Agent state. This mirrors Conda's separation between discovering validated prefixes and explicitly creating, cloning, or importing environments: discovery is not adoption, and arbitrary Agent homes are not registered as Harness Environments. Every Environment must contain the built-in `harness-project-memory` and `harness-package-builder` roots; those identities and sources are reserved. An existing `base` is accepted only after its recipe, lock, Package closure, and complete Agent view validate successfully. `harness sync -n base` deliberately bypasses the healthy-view precondition so a parseable recipe and lock can repair missing Package entries and rebuild the view.

Existing ordinary Agent Skills enter Harness only through explicit `harness migrate skills`. Migration discovers the selected Codex and Claude sources, creates one single-Skill Package per deduplicated Skill, validates every temporary Package, and checks Package and Skill ownership against a locked target snapshot. Each read-only source directory is keyed by the Skill name and a deterministic hash of its content and origins. All changed Packages enter the normal Environment installation transaction together, so the lock, recipe, and complete view publish atomically. A repeated identical migration is a no-op; changing one Skill creates a new immutable snapshot and replaces only that Package root in the selected Environment. Dry runs never publish source snapshots or mutate the Package Store or Environment.

## Source normalization

Every installable locator is first materialized as a local directory and then passed through one Source Adapter. A root `harness.yaml` passes through unchanged. Otherwise, only a root standalone `SKILL.md` or direct conventional `skills/*/SKILL.md` children are copied into temporary staging with a deterministic generated manifest. Git metadata, Harness project state, dependency caches, and OS metadata are excluded by the same copy policy used for Package publication. The original source is never modified.

The adapter is shared by direct installation, inspection, recursive dependency resolution, and lock repair. Consequently an implicit Package has the same identity and normalized bytes when installed repeatedly or reconstructed by `sync`. No recursive candidate search occurs: nested repositories, examples, vendored Skills, and Package collections cannot silently expand the ownership boundary of one install command.

## Portable Environment bundles

A `.harness-env` file is a versioned, gzip-compressed JSON document containing one Environment recipe, its exact lock, and every regular file in the locked Package closure. Binary files are Base64 encoded and file read/execute modes are preserved. Stable key ordering and a deterministic gzip stream make repeated exports of an unchanged Environment byte-identical.

Import limits compressed, decompressed, file-count, and decoded payload sizes. It rejects unsafe or duplicate paths, symbolic and special files, writable bundled modes, malformed Base64, duplicate or missing Packages, cache-key drift, Package identity or integrity drift, invalid dependency graphs, foundational Package spoofing, unsupported targets, `base`, and existing destination names. Bundled foundational Packages must exactly match the builtins shipped with the importing Harness Conda installation. All Package trees are materialized and validated in temporary storage before Package Store publication. The Environment recipe, lock, and view are then published through the ordinary Environment transaction, so a normal failure leaves no partially visible Environment.

Bundles deliberately exclude per-Environment Agent homes, project files, Project Memory, machine-local Memory, and actual environment-variable values. Source strings and Package content are retained for provenance and offline restoration; a bundle should therefore be treated as executable Package input, not as a credential or session backup.

## Activation and direct Agent launch

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
stable per-Environment CODEX_HOME / CLAUDE_CONFIG_DIR / PI_CODING_AGENT_DIR
        |
        v
direct codex, claude, or pi
```

Package Store replacements are copied into read-only immutable generations and fully validated before an atomic cache-key symlink switch. Skill directories in every view resolve through that stable cache pointer, so repair readers see either the old or new Package and never a missing entry. Every Environment update builds a complete `.view.gen-<id>` directory and atomically replaces the stable `view` symlink, so direct Agent readers never observe mixed Skill, MCP, and Hook generations. Recipe and lock metadata commit under the Environment lock before the view pointer changes and roll back if publication fails.

Each Environment has stable target Agent homes that are never generation-swapped. Harness-owned and Environment-specific configuration links through the Environment `view`: Codex `auth.json`, `config.toml`, `hooks.json`, and `skills`; Claude `.credentials.json`, `settings.json`, and `skills`; Pi only `skills`. Codex and Claude credentials and provider settings are seeded from the original Agent home only when an Environment is first built, then inherited from the current generation so user edits through `$CODEX_HOME` or `$CLAUDE_CONFIG_DIR` survive later publication. Pi settings, credentials, model catalogs, Pi Packages, and sessions are ordinary Pi-owned files in the stable `$PI_CODING_AGENT_DIR`; a new Environment does not copy the original `~/.pi/agent` state. Harness strips and regenerates its marked Codex MCP blocks and exact Claude Hook entries while preserving user-owned provider settings. Claude `.claude.json` remains in the stable home, where Harness transactionally updates only Package-managed `mcpServers`. Codex `skills/.system` points to a stable Environment-specific directory outside the generation. Pi has no Harness MCP or Hook adapter, so Package validation rejects those resources when they target Pi instead of silently omitting them.

Every other path is opaque Agent-owned state. Environment initialization and view publication do not enumerate, inspect, copy, merge, adopt, or relink unknown files, including SQLite main, WAL, and SHM files. `harness migrate sessions` is a separate explicit operation over documented session and history paths: it builds and verifies a link-free temporary snapshot, preflights target conflicts, structurally merges JSONL records, then publishes ordinary files into the selected stable home under the Environment lock. Structured files are atomically replaced and restored on ordinary publication failure. Retired generations contain only managed resources and remain available to processes that still have those files open.

The shell hook saves the original Agent configuration roots and wraps both installed CLI names, `harness` and `harness-conda`. It validates that the selected Environment and complete view exist before changing the parent shell, falls back to `base` for a stale inherited selection, and parses only a real top-level `activate` or `deactivate` command. Help requests and unrelated arguments never change Environment state. For unsupported targets it restores the original Agent configuration root. It never proxies `codex`, `claude`, or `pi`.

The Memory manager is available through the view like any other Skill. Harness initializes marker-delimited startup instructions in project `AGENTS.md` for Codex and Pi and `CLAUDE.md` for Claude. These discovery pointers are stable project configuration: Environment activation may add a missing pointer but never removes one based on shell-local target selection. Existing instruction symlinks and file modes are preserved. At Agent startup, the Memory Skill calls `harness info --json`, reads project and local Memory, maps selected Skills to their Packages, and reads Package-specific Memory before use.

Harness does not proxy Agent commands and does not maintain session-to-Environment metadata. Resuming a session under a different Environment is user-managed.

## Conda parity

The implementation provides:

- one global physical Package cache;
- global named Environment recipes and independent dependency locks;
- one global target-specific view per Environment;
- Environment-isolated Skill, MCP, and Hook visibility;
- direct Agent launch through stable shell-selected per-Environment homes;
- Environment-isolated opaque Agent state;
- project-local Memory independent of Environment storage.
- safe root Package removal with orphan dependency pruning and immutable cache retention.

Updating an Environment transactionally refreshes the managed paths in its global view. All projects and newly started Agent processes selecting that Environment therefore observe the same package closure without reactivation. Already-running Agent processes may retain startup-time Skill discovery and should be restarted after an Environment change.

Harness does not yet bind Agent session IDs to Environments. A resumed session uses whichever Environment is selected in the current shell; maintaining that consistency remains the user's responsibility.

## Transaction boundary

Environment mutations are serialized with filesystem-backed per-Environment locks. Activation holds the target lock through the project transition, preventing concurrent install, sync, or uninstall from invalidating the selected generation. Project locks are keyed by canonical real paths so symlink aliases serialize together. Recipes and locks are re-read inside the lock, and multi-file inspection uses the same locked snapshot. Package cache publication, reads, permission changes, corruption repair, and verification use per-Package locks. Package resolution and validation complete before one complete view generation is atomically published. Install and uninstall share the same publication path: recipe, lock, stable managed-home links, Package-managed Claude MCP fields, and the complete view pointer remain inside the ordinary-error rollback boundary. Opaque Agent state is outside the transaction because Harness never mutates it. Abrupt process termination and unanticipated filesystem failure remain outside the guarantee because there is no persistent transaction journal.
