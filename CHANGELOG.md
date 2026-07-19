# Changelog

## Unreleased

- Added global, content-addressed Package storage and user-global named Environment recipes and locks.
- Added atomic global per-Environment Codex and Claude views backed by Package Store symlinks.
- Added shell selection of Environment views for direct `codex` and `claude` launches while preserving shared Agent runtime state.
- Added cross-process Environment, project activation, and runtime locks with stale-lock recovery.
- Made Project Memory discovery stable across shell-local target changes while preserving instruction symlinks and file modes.
- Added a shared runtime root for first-use authentication and session state, including activation-time reconciliation of Agent file replacement and logout.
- Added an implicit, non-removable `base` Environment.
- Made `harness-project-memory` and `meta-skill-builder` foundational in every Environment.
- Added recursive Package dependencies and installable natural-language meta-skills.
- Added atomic Environment view updates and installation with ordinary-error rollback.
- Added isolated Project Memory with Agent startup discovery and Package-to-Skill mapping.
- Added `harness info --json` as the machine-readable Agent and Memory context interface.
