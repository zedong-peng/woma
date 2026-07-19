# Changelog

## Unreleased

- Added global, content-addressed Package storage and user-global named Environment recipes and locks.
- Added atomic global per-Environment Codex and Claude views backed by Package Store symlinks.
- Added shell selection of Environment views for direct `codex` and `claude` launches while preserving shared Agent runtime state.
- Added an implicit, non-removable `base` Environment.
- Made `harness-project-memory` and `meta-skill-builder` foundational in every Environment.
- Added recursive Package dependencies and installable natural-language meta-skills.
- Added atomic Environment view updates and installation with ordinary-error rollback.
- Added isolated Project Memory with Agent startup discovery and Package-to-Skill mapping.
- Added `harness info --json` as the machine-readable Agent and Memory context interface.
