# Architecture and isolation model

## Ownership boundaries

Harness Conda separates reusable Agent capabilities from repository knowledge.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$HARNESS_HOME/packages/` |
| Environment recipes and locks | User-global | `$HARNESS_HOME/environments/<name>/` |
| Codex and Claude Environment views | User-global | `$HARNESS_HOME/environments/<name>/view/` |
| Authentication and session runtime | User-global, shared | `$HARNESS_HOME/runtime/<agent>/` |
| Explicit Skill migration snapshots | User-global | `$HARNESS_HOME/migrations/skills/<content-hash>/` |
| Mutation locks | User-global | `$HARNESS_HOME/locks/` |
| Environment selection | Current shell | `HARNESS_ENV` (defaults to `base`) |
| Shared and Package-specific Memory | Project-local | `<project>/.harness/memory/` |
| Machine-specific Memory | Project-local, uncommitted | `<project>/.harness/local/` |

An Environment recipe records root Packages and Agent targets. Its lock records the exact recursive dependency closure. Multiple Environments referencing the same Package resolution share one immutable cache entry.

`base` is lazily initialized on first use and cannot be removed. Initialization is deterministic and never scans ordinary Skills from the original Agent homes. Every Environment must contain the built-in `harness-project-memory` and `meta-skill-builder` roots; those identities and sources are reserved. An existing `base` is accepted only after its recipe, lock, Package closure, and complete Agent view validate successfully. `harness sync -n base` deliberately bypasses the healthy-view precondition so a parseable recipe and lock can repair missing Package entries and rebuild the view.

Existing ordinary Agent Skills enter Harness only through explicit `harness migrate skills`. Migration discovers the selected Codex and Claude sources, validates a complete temporary Package, checks Skill ownership against a locked target snapshot, and publishes a read-only source directory keyed by a deterministic hash of Skill names, contents, and origins. It then delegates to the normal Package installation transaction. A repeated identical migration is a no-op; changed sources create a new immutable snapshot and replace the migration root only in the selected Environment. Dry runs never publish the source snapshot or mutate the Package Store or Environment.

## Portable Environment bundles

A `.harness-env` file is a versioned, gzip-compressed JSON document containing one Environment recipe, its exact lock, and every regular file in the locked Package closure. Binary files are Base64 encoded and file read/execute modes are preserved. Stable key ordering and a deterministic gzip stream make repeated exports of an unchanged Environment byte-identical.

Import limits compressed, decompressed, file-count, and decoded payload sizes. It rejects unsafe or duplicate paths, symbolic and special files, writable bundled modes, malformed Base64, duplicate or missing Packages, cache-key drift, Package identity or integrity drift, invalid dependency graphs, foundational Package spoofing, unsupported targets, `base`, and existing destination names. Bundled foundational Packages must exactly match the builtins shipped with the importing Harness Conda installation. All Package trees are materialized and validated in temporary storage before Package Store publication. The Environment recipe, lock, and view are then published through the ordinary Environment transaction, so a normal failure leaves no partially visible Environment.

Bundles deliberately exclude `$HARNESS_HOME/runtime`, project files, Project Memory, machine-local Memory, and actual environment-variable values. Source strings and Package content are retained for provenance and offline restoration; a bundle should therefore be treated as executable Package input, not as a credential or session backup.

## Activation and direct Agent launch

Every Environment owns one reusable Agent view:

```text
global Environment recipe and lock
        |
        v
content-addressed Package store
        |
        v
global Codex/Claude Environment view
        |
        v
shell-selected CODEX_HOME / CLAUDE_CONFIG_DIR
        |
        v
direct codex or claude
```

Package Store replacements are copied into read-only immutable generations and fully validated before an atomic cache-key symlink switch. Skill directories in every view resolve through that stable cache pointer, so repair readers see either the old or new Package and never a missing entry. Every Environment update builds a complete `.view.gen-<id>` directory and atomically replaces the stable `view` symlink, so direct Agent readers never observe mixed Skill, MCP, and Hook generations. Recipe and lock metadata commit under the Environment lock before the view pointer changes and roll back if publication fails.

Non-Harness authentication and session paths are linked through a stable shared runtime root, seeded from the user's original Agent configuration roots. Codex `skills/.system` uses the same model: every Codex Environment contains one validated `.system` link to `$HARNESS_HOME/runtime/codex/skills/.system`, while Package Skill ownership metadata and exact visibility checks cover the remaining entries. Codex can therefore update system Skills without mutating an Environment closure.

Known first-use paths are linked before they exist, arbitrary runtime files are adopted byte-for-byte, and runtime links must target their exact shared path. Retired view generations remain available to running Agents and are reconciled during later operations in the selected Environment. Updating an inactive Environment reads shared runtime state but never contributes its own stale state. Claude non-`mcpServers` fields use one authoritative shared snapshot; switching replaces that snapshot exactly, including field deletion, while the target Environment retains only its own and user-baseline MCP definitions.

The shell hook saves the original Agent configuration roots and wraps both installed CLI names, `harness` and `harness-conda`. It validates that the selected Environment and complete view exist before changing the parent shell, falls back to `base` for a stale inherited selection, and parses only a real top-level `activate` or `deactivate` command. Help requests and unrelated arguments never change Environment state. For unsupported targets it restores the original Agent configuration root. It never proxies `codex` or `claude`.

The Memory manager is available through the view like any other Skill. Harness initializes marker-delimited startup instructions in both project `AGENTS.md` and `CLAUDE.md`. These discovery pointers are stable project configuration: Environment activation may add a missing pointer but never removes one based on shell-local target selection. Existing instruction symlinks and file modes are preserved. At Agent startup, the Memory Skill calls `harness info --json`, reads project and local Memory, maps selected Skills to their Packages, and reads Package-specific Memory before use.

Harness does not proxy Agent commands and does not maintain session-to-Environment metadata. Resuming a session under a different Environment is user-managed.

## Conda parity

The implementation provides:

- one global physical Package cache;
- global named Environment recipes and independent dependency locks;
- one global target-specific view per Environment;
- Environment-isolated Skill, MCP, and Hook visibility;
- direct Agent launch through shell-selected configuration roots;
- project-local Memory independent of Environment storage.

Updating an Environment transactionally refreshes the managed paths in its global view. All projects and newly started Agent processes selecting that Environment therefore observe the same package closure without reactivation. Already-running Agent processes may retain startup-time Skill discovery and should be restarted after an Environment change.

Harness does not yet bind Agent session IDs to Environments. A resumed session uses whichever Environment is selected in the current shell; maintaining that consistency remains the user's responsibility.

## Transaction boundary

Environment mutations are serialized with filesystem-backed per-Environment locks. Activation holds the target lock through project and runtime commit, preventing concurrent install, sync, or removal from invalidating the selected generation. Project locks are keyed by canonical real paths so symlink aliases serialize together. Recipes and locks are re-read inside the lock, and multi-file inspection uses the same locked snapshot. Package cache publication, reads, permission changes, corruption repair, and verification use per-Package locks. Package resolution and validation complete before one complete view generation is atomically published. Recipe and lock commit remains inside the ordinary-error rollback boundary; failures restore the previous view pointer and metadata. Activation applies project changes before runtime reconciliation, preflights all logical runtime changes, and rolls project changes back when reconciliation fails. Abrupt process termination and unanticipated filesystem failure remain outside the guarantee because there is no persistent transaction journal.
