---
name: woma-package-builder
description: Creates or updates Woma Skill packages, native Codex or Claude Plugins, and dependency collections using the minimal v2 package format.
---

# Woma Package Builder

Read [references/package-format.md](references/package-format.md) before editing a package. Inspect the supplied resources and destination, then preserve native formats and unrelated files.

Use an existing standalone `SKILL.md` directory or direct `skills/` collection without rewriting it into a capability manifest. Package MCP and Hooks in a native `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json` layout for the intended harness. Native Plugins may be harness-specific; never translate MCP or Hook semantics into Woma fields.

Add `woma.yaml` only for name, version, dependencies, or harness runtime constraints. A dependency-only collection needs no coordinating runtime. Dependencies must have a name, local/Git source, and compatible version constraint. Keep source paths inside the package or use explicit dependency sources. Reject cycles, incompatible harnesses, ambiguous identities, and unsupported native dependency resolution.

Preserve complete Skill and Plugin companion files. Do not copy credentials, native settings, sessions, caches, or Memory. Package trees cannot contain symlinks or special files. Use the user's installed Woma CLI and its current `--help`; `init` is shell integration, not a package scaffold command.

When installation is authorized, validate in an explicitly selected matching environment with `woma install -n NAME PATH` and `woma doctor -n NAME`. Do not select or create a default environment. Otherwise check the package's frontmatter, native manifest, optional Woma metadata, dependency identities, and self-contained files locally.

Report the package path, identity, native harness constraints, validation performed, and any external command/service requirements. Keep user approval for publishing or unrelated global changes separate from local package authoring.
