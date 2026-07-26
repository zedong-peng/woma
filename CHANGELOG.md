# Changelog

## Unreleased

- Added `harness uninstall` with active-or-named Environment selection, dry-run resource plans, shared-dependency retention, orphan pruning, foundational Package protection, and atomic rollback across recipes, locks, stable Agent homes, and views.
- Added direct Git subdirectory installation with optional full-commit selection and immutable commit/content-integrity provenance preserved through sync, `harness list`, and portable bundles.
- Added opt-in Pi Agent targets with isolated `PI_CODING_AGENT_DIR` homes, atomic Skill views, shell activation, and explicit rejection of unsupported Pi MCP/Hook resources.
- Changed explicit Skill migration to create and atomically install one independently versioned Package per Skill.
- Added `harness list` to show an Environment's locked Packages and every Package-managed Skill, MCP server, and hook with providing Package versions and effective target platforms.
- Added a current-user Codex/Claude process check and mandatory interactive confirmation before migration while an Agent is running.
- Added explicit `harness migrate sessions` snapshots from original Agent homes into Environment-owned ordinary files, including structured JSONL history merging, without implicit initialization-time migration or links back to the source.
- Replaced shared runtime adoption with stable per-Environment Agent homes and inherited Environment-specific credentials/provider settings, so unknown state and SQLite databases are never copied across view generations.
- Added deterministic installation of standalone Skills and direct conventional multi-Skill sources through one shared Source Adapter.
- Replaced the foundational authoring assistant with a general `harness-package-builder` for wrapping resources and creating dependency-based Packages with optional coordinating Skills.
- Added explicit migration of existing Agent Skills into a selected Environment and stable per-Environment Codex system Skills.
- Added deterministic, offline-capable Environment bundle export/import with complete Package closures and atomic destination publication.
- Added global, content-addressed Package storage and user-global named Environment recipes and locks.
- Added atomic global per-Environment Codex and Claude views backed by Package Store symlinks.
- Added shell selection of stable Environment Agent homes for direct `codex` and `claude` launches.
- Added cross-process Environment, Package Store, and project activation locks with stale-lock recovery.
- Made Project Memory discovery stable across shell-local target changes while preserving instruction symlinks and file modes.
- Added an implicit, non-removable `base` Environment.
- Made Package Store entries read-only and Agent view publication generation-atomic.
- Made `base` repairable from its lock even when its cache or view is damaged.
- Hardened shell selection, foundational Package identity, exact Skill visibility, and canonical project locking.
- Made `harness-project-memory` and `harness-package-builder` foundational in every Environment.
- Added recursive Package dependencies and installable natural-language methods expressed by ordinary coordinating Skills.
- Added atomic Environment view updates and installation with ordinary-error rollback.
- Added isolated Project Memory with Agent startup discovery and Package-to-Skill mapping.
- Added `harness info --json` as the machine-readable Agent and Memory context interface.
