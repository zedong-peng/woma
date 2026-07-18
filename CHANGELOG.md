# Changelog

## 0.6.0

- Replaced workflow profiles with named, project-local Agent Environments.
- Added per-Environment recipes, locks, root packages, and targets.
- Added recursive package dependencies and lightweight meta-skill entrypoints with SemVer conflict detection.
- Added a built-in meta-skill creation assistant for turning natural-language multi-Skill methods into validated packages.
- Install and lock complete meta-skill dependency closures into a selected Environment.
- Atomically activate, switch, and deactivate full dependency closures with drift checks and rollback.
- Added Environment-aware `current`, `sync`, and `doctor` behavior.
- Added active-first install targeting, conventional `base` creation/activation defaults, and bash/zsh prompt hooks.
- Added process-atomic package installation and upgrades for active Environments with project snapshot rollback.
- Replaced command bindings with isolated natural-language Project Memory: shared repository knowledge, package-scoped adaptation, and git-ignored machine-local context.
- Added generated active context and target-specific `AGENTS.md`/`CLAUDE.md` discovery pointers so Agents load and maintain Project Memory independently of third-party Skill contents.
- Removed the `bind` command, manifest `requirements.bindings`, and Environment `spec.bindings`.
- Removed research-specific workflow commands from the core CLI: `onboard`, `project`, `profile`, `switch`, `leave`, `enter`, `handoff`, `outcome`, `stats`, `use`, and `eval`.
- Reframed built-in packages as optional methods rather than mandatory workflow phases.

## 0.5.0

- Promoted the performance engineering workflow from a package example to a built-in onboarding profile.
- Added package-level project binding requirements so domain workflows can depend on repository commands without hard-coding them.
- Require `test` and `benchmark` bindings before performance activation, with no profile mutation on rejection.
- Detect benchmark commands during onboarding and give an explicit `harness bind benchmark <command>` next step when none is found.
- Verify direct research-to-performance switching keeps the reproducibility base while removing research-only capabilities.
- Restore the exact performance package lock on a new machine and report inactive missing bindings as doctor warnings.
- Remove Harness-created config files when their final managed entry disappears, while preserving files that predated activation.

## 0.4.0

- Added committed paired-eval definitions with `eval init` and inspectable `eval plan`.
- Added opt-in `eval run --execute` with identical detached Git worktrees for baseline and profile arms.
- Launch fresh Codex or Claude sessions, alternate arm order, and run the same objective verifier for both arms.
- Persist only local result metadata, pass rates, and agent/verifier/timeout failure stages without prompts or Agent output.
- Added explicit `--keep-failures` retention for inspecting failed work products without making sensitive output the default.
- Reject dirty worktrees, active state at HEAD, prompt placeholders, and Agent arguments that weaken isolation.
- Added a self-hosted research audit smoke eval and documented why it is not evidence of general quality improvement.

## 0.3.1

- Reject Skill root symlinks and real-path escapes before package caching.
- Populate cache entries atomically and verify existing entries before reuse.
- Preserve shared Skills, MCP servers, and hooks until their final active owner exits.
- Prevent active-package upgrades from replacing the lock identity and report identity drift in `doctor`.
- Run static checks and unit tests on pushes and pull requests with least-privilege GitHub Actions workflows.

## 0.3.0

- Added one-command `onboard` with repository stack, package manager, command binding, and Agent detection.
- Bundled research, experiment, and reproducibility workflows for a zero-download first run.
- Added portable `builtin:` lock sources and exact cache restoration.
- Added local-only transition, handoff, session, and outcome evidence with `stats`.
- Added automatic Git exclusion for machine-local state and private outcome notes.
- Added required handoff quality gates before experiment activation.
- Added project Codex hook installation, deactivation, and capture support.
- Repositioned the product above native Codex and Claude plugin marketplaces instead of competing with them.

## 0.2.0

- Added project-level `base` and exclusive task profiles.
- Added atomic `switch`, fresh-session `enter`, `current`, and `leave` workflows.
- Added project command bindings and managed active-profile routing in `AGENTS.md` / `CLAUDE.md`.
- Added structured phase handoffs and automatic handoff discovery.
- Added exact lock restoration with `sync` for new machines.
- Expanded `doctor` to validate composition, routing, handoffs, and profile drift.
- Added research, experiment, and reproducibility dogfood packages.

## 0.1.0

- Added the portable Harness package schema and local/Git source resolver.
- Added Codex and Claude Code activation adapters for Skills, MCP servers, and hooks.
- Added content-addressed caching, lock files, capture, integrity checks, and safe deactivation.
