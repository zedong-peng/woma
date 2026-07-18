# Security

Harness packages can install agent instructions, MCP process definitions, and Agent lifecycle hooks. Treat a package like executable code.

- Review `harness.yaml`, every `SKILL.md`, hook command, and referenced script before activation.
- Pin Git sources to an immutable commit or signed release for production use.
- Manifests declare environment variable names only. Never put credential values in a manifest.
- `capture` rejects literal MCP environment and header values instead of exporting possible secrets.
- Skill directories containing symbolic links are rejected so package content cannot escape its root during installation.
- Project-scoped MCP servers still require the trust and approval flow of the target agent.
- Activation refuses conflicting skills and MCP entries. Deactivation leaves user-modified artifacts in place.
- Environment activation writes only a clearly marked Project Memory discovery pointer to `AGENTS.md` and/or `CLAUDE.md`; content outside that block is preserved and Memory contents remain in their own reviewable files.
- Environment recipes and locks contain package metadata, sources, and integrity values, but never environment-variable values or Agent prompts.
- Portable Project Memory is reviewable Agent context and must never contain credentials; machine-specific memory belongs under the git-ignored `.harness/local/` directory.
- Machine-local activation ownership is stored in Git-excluded `.harness/state.json` and is never uploaded by Harness Conda.

Report vulnerabilities privately to the repository owners. Do not include credentials or private Harness packages in an issue.
