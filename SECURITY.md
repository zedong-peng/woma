# Security

Harness packages can install agent instructions, MCP process definitions, and Claude Code hooks. Treat a package like executable code.

- Review `harness.yaml`, every `SKILL.md`, hook command, and referenced script before activation.
- Pin Git sources to an immutable commit or signed release for production use.
- Manifests declare environment variable names only. Never put credential values in a manifest.
- `capture` rejects literal MCP environment and header values instead of exporting possible secrets.
- Skill directories containing symbolic links are rejected so package content cannot escape its root during installation.
- Project-scoped MCP servers still require the trust and approval flow of the target agent.
- Activation refuses conflicting skills and MCP entries. Deactivation leaves user-modified artifacts in place.

Report vulnerabilities privately to the repository owners. Do not include credentials or private Harness packages in an issue.
