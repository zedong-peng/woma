# Security

Harness packages can install agent instructions, MCP process definitions, and Agent lifecycle hooks. Treat a package like executable code.

- Review `harness.yaml`, every `SKILL.md`, hook command, and referenced script before activation.
- Pin Git sources to an immutable commit or signed release for production use.
- Manifests declare environment variable names only. Never put credential values in a manifest.
- `capture` rejects literal MCP environment and header values instead of exporting possible secrets.
- Skill directories containing symbolic links are rejected so package content cannot escape its root during installation.
- Project-scoped MCP servers still require the trust and approval flow of the target agent.
- Activation refuses conflicting skills and MCP entries. Deactivation leaves user-modified artifacts in place.
- Profile switching writes a clearly marked managed block to `AGENTS.md` and/or `CLAUDE.md`; content outside that block is preserved.
- `harness enter` launches the selected local `codex` or `claude` executable with inherited terminal access and environment.
- Handoffs remain local project files and are never uploaded by the CLI. Review them before committing because they may contain private research context.
- Automatic workflow events store phase names, durations, exit codes, and failure categories only. They do not store prompts, Agent arguments, command output, or error text.
- `harness outcome --note` is explicit private input. It is stored under Git-excluded `.harness/local` and is never uploaded.

Report vulnerabilities privately to the repository owners. Do not include credentials or private Harness packages in an issue.
