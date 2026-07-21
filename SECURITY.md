# Security

Harness packages can install agent instructions, MCP process definitions, and Agent lifecycle hooks. Treat a package like executable code.

- Review `harness.yaml`, every `SKILL.md`, hook command, and referenced script before activation.
- Pin Git sources to an immutable commit or signed release for production use.
- Manifests declare environment variable names only. Never put credential values in a manifest.
- `capture` rejects literal MCP environment and header values instead of exporting possible secrets.
- `harness-package-builder` must copy only user-selected resources and environment variable names when wrapping existing Agent content. It must not copy credential values, authentication state, sessions, history, or unrelated Agent configuration into a Package.
- Skill directories containing symbolic links are rejected so package content cannot escape its root during installation.
- Environment initialization never scans ordinary existing Agent Skills or session state. Explicit `harness migrate skills` validates a complete temporary snapshot before installation, leaves original directories unchanged, excludes hidden Agent-managed Skills, and fails closed on source or target ownership conflicts. Review existing Skills before migration because the resulting Package is exportable.
- Before every Skill or session migration, including dry runs, Harness checks the current user's process table for Codex and Claude CLIs. Detected Agent processes require an explicit interactive `yes`; non-interactive migration fails closed.
- Explicit `harness migrate sessions` copies only documented session and history paths into the selected stable Agent home. It rejects source symbolic links and special files, verifies that the source did not change while the temporary snapshot was built or before publication, and fails before publication on different same-path target content. A legacy target link is accepted only when it points directly to the corresponding path in the selected source tree, then replaced with ordinary Environment-owned state. JSONL history is parsed as objects, deduplicated by canonical full-record identity, and atomically replaced after merging. The resulting ordinary files are private Environment state, are not exportable Package content, and no longer depend on the original home.
- Content-addressed Package entries are published without write permission. Their Environment Skill links are read-only views; use Harness repair paths rather than editing Store contents. To remove an entire development `HARNESS_HOME` manually, restore owner write permission first with `chmod -R u+w "$HARNESS_HOME"`.
- Project-scoped MCP servers still require the trust and approval flow of the target agent.
- Activation refuses conflicting skills and MCP entries. Deactivation leaves user-modified artifacts in place.
- Environment activation may add clearly marked Project Memory discovery blocks to `AGENTS.md` and `CLAUDE.md`; it never removes them during target switching. Content outside those blocks, instruction symlinks, and file modes are preserved, and Memory contents remain in their own reviewable files.
- Stable per-Environment Agent homes and views may contain credentials, provider configuration, sessions, databases, and other private state. Original Agent configuration seeds credentials and provider settings only when an Environment is initialized; subsequent edits and explicitly migrated sessions are Environment-specific. Harness creates homes and views with user-only permissions; protect `$HARNESS_HOME` like the original Agent configuration directories and never publish it.
- Outside the documented explicit session migration paths, Harness never copies or transfers unknown Agent state between homes or view generations. In particular, SQLite main, WAL, and SHM files remain opaque in one stable Environment home and are excluded from Package locks and bundles.
- Codex-managed `skills/.system` is stable per Environment and deliberately outside Package locks and bundles.
- Environment recipes and locks contain package metadata, sources, and integrity values, but never environment-variable values or Agent prompts.
- `.harness-env` bundles contain the complete locked Package closure and must be treated like executable code. Import validates size limits, paths, identities, dependency edges, and integrity before publishing an Environment. Bundles exclude Agent homes, credentials, sessions, databases, Project Memory, and environment-variable values, but private Package source and file contents remain private and must not be uploaded unintentionally.
- Portable Project Memory is reviewable Agent context and must never contain credentials; machine-specific memory belongs under the git-ignored `.harness/local/` directory.
- Environment selection is stored only in the current shell's `HARNESS_ENV` and is never written into a project or uploaded by Harness Conda.

Report vulnerabilities privately to the repository owners. Do not include credentials or private Harness packages in an issue.
