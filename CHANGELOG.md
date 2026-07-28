# Changelog

## Unreleased

- Changed Environment recipes to `environment-v2`: new Environments have no implicit Package roots, and Project Memory and Package Builder are now optional built-ins that can be installed or removed like any other Package. Legacy implicit roots and exact legacy Project Memory discovery blocks migrate away without creating new project files or startup instructions.
- Added opt-in Qoder CLI Agent targets with isolated `QODER_CONFIG_DIR` homes, atomic Skill views, Package MCP servers and Hooks merged into the managed `settings.json`, shell activation, and inclusion in `--target all`; Harness does not capture, migrate, or seed Qoder credentials or sessions.
- Fixed `harness init` to remove legacy `eval "$(harness shell hook)"` profile lines while installing the managed block, so profiles written before the public `shell` command was removed no longer fail at shell startup.
- Added Conda-style top-level `create`, `export`, `remove`, `run`, and `rename` commands; portable bundles are now restored with `create --file`, and the former `env import` command has been removed.
- Changed `harness deactivate` to leave Harness Environment management, restore the original Agent homes, and clear the shell selection; use `harness activate base` to select Harness `base` explicitly.
- Removed the public `harness shell` command; `harness init` is now the sole shell-integration entrypoint and continues to install a static startup hook.
- Added one stable Skill root per Environment shared by every target Agent, so an ordinary Skill installed through Codex, Claude Code, Pi, or Qoder CLI is immediately visible to all targets without a second command; legacy per-Agent layouts merge transactionally, automatically deduplicate verifiably equivalent same-name entries, reject differing collisions, keep hidden state excluded from inventory, and leave other Environments isolated.
- Removed the public `harness sync` command; install and non-dry-run uninstall now repair the existing locked Package closure before applying their requested mutation.
- Added `harness remove` (`uninstall` alias) with active-or-named Environment selection, dry-run resource plans, shared-dependency retention, orphan pruning, foundational Package protection, and atomic rollback across recipes, locks, stable Agent homes, and views.
- Added direct Git subdirectory installation with optional full-commit selection and immutable commit/content-integrity provenance preserved through Package repair, `harness list`, and portable bundles.
- Reassigned `harness init` to Conda-style shell initialization with a static hook, managed profile block, dry-run, reversal, and post-install guidance; moved its former Package scaffold to the provider-oriented `harness skeleton workflow` interface while retaining `harness-package-builder` for full authoring.
- Made shell-hook generation read-only and independent of Environment initialization, locks, validation, Package loading, and repair, with bounded shell-side fallback to the original Agent homes.
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
