# Changelog

## Unreleased

- Replaced the foundational authoring assistant with a general `harness-package-builder` for wrapping resources and creating dependency-based Packages with optional coordinating Skills.
- Added explicit migration of existing Agent Skills into a selected Environment and shared Codex system Skills through runtime links.
- Added deterministic, offline-capable Environment bundle export/import with complete Package closures and atomic destination publication.
- Added global, content-addressed Package storage and user-global named Environment recipes and locks.
- Added atomic global per-Environment Codex and Claude views backed by Package Store symlinks.
- Added shell selection of Environment views for direct `codex` and `claude` launches while preserving shared Agent runtime state.
- Added cross-process Environment, Package Store, project activation, and runtime locks with stale-lock recovery.
- Made Project Memory discovery stable across shell-local target changes while preserving instruction symlinks and file modes.
- Added a shared runtime root for first-use authentication and session state, including activation-time reconciliation of Agent file replacement and Claude runtime fields.
- Added an implicit, non-removable `base` Environment.
- Made Package Store entries read-only and Agent view publication generation-atomic.
- Made `base` repairable from its lock even when its cache or view is damaged.
- Hardened shell selection, foundational Package identity, exact Skill visibility, and canonical project locking.
- Replaced Claude Environment-to-Environment shallow merges with an authoritative shared runtime snapshot.
- Made `harness-project-memory` and `harness-package-builder` foundational in every Environment.
- Added recursive Package dependencies and installable natural-language methods expressed by ordinary coordinating Skills.
- Added atomic Environment view updates and installation with ordinary-error rollback.
- Added isolated Project Memory with Agent startup discovery and Package-to-Skill mapping.
- Added `harness info --json` as the machine-readable Agent and Memory context interface.
