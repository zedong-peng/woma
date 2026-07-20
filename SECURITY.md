# Security

Harness packages can install agent instructions, MCP process definitions, and Agent lifecycle hooks. Treat a package like executable code.

- Review `harness.yaml`, every `SKILL.md`, hook command, and referenced script before activation.
- Pin Git sources to an immutable commit or signed release for production use.
- Manifests declare environment variable names only. Never put credential values in a manifest.
- `capture` rejects literal MCP environment and header values instead of exporting possible secrets.
- Skill directories containing symbolic links are rejected so package content cannot escape its root during installation.
- Environment initialization never scans ordinary existing Agent Skills. Explicit `harness migrate skills` validates a complete temporary snapshot before installation, leaves original directories unchanged, excludes hidden Agent-managed Skills, and fails closed on source or target ownership conflicts. Review existing Skills before migration because the resulting Package is exportable.
- Content-addressed Package entries are published without write permission. Their Environment Skill links are read-only views; use Harness repair paths rather than editing Store contents. To remove an entire development `HARNESS_HOME` manually, restore owner write permission first with `chmod -R u+w "$HARNESS_HOME"`.
- Project-scoped MCP servers still require the trust and approval flow of the target agent.
- Activation refuses conflicting skills and MCP entries. Deactivation leaves user-modified artifacts in place.
- Environment activation may add clearly marked Project Memory discovery blocks to `AGENTS.md` and `CLAUDE.md`; it never removes them during target switching. Content outside those blocks, instruction symlinks, and file modes are preserved, and Memory contents remain in their own reviewable files.
- Shared runtime paths under `$HARNESS_HOME/runtime/` may contain Agent credentials and session data created after first activation. Harness creates parent directories with user-only permissions; protect `$HARNESS_HOME` like the original Agent configuration directories and never publish it.
- Codex-managed `skills/.system` is shared through the runtime root and is deliberately outside Environment Package locks and bundles.
- Environment recipes and locks contain package metadata, sources, and integrity values, but never environment-variable values or Agent prompts.
- `.harness-env` bundles contain the complete locked Package closure and must be treated like executable code. Import validates size limits, paths, identities, dependency edges, and integrity before publishing an Environment. Bundles exclude shared runtime, credentials, sessions, Project Memory, and environment-variable values, but private Package source and file contents remain private and must not be uploaded unintentionally.
- Portable Project Memory is reviewable Agent context and must never contain credentials; machine-specific memory belongs under the git-ignored `.harness/local/` directory.
- Environment selection is stored only in the current shell's `HARNESS_ENV` and is never written into a project or uploaded by Harness Conda.

Report vulnerabilities privately to the repository owners. Do not include credentials or private Harness packages in an issue.
