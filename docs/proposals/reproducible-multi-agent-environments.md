# Superseded: Reproducible Multi-Agent Environments

This proposal is superseded by [Minimal Conda-Like Harness Environments](../design.md), implemented as the v2 environment and lock formats.

The selected design manages exactly one harness runtime and its installed packages per prefix. Environments evolve independently; names locate directories, activation selects the current shell, and exact locks recreate managed content on the same platform.

The former multi-target, Agent-neutral capability manifest, shared writable Skill root, configuration projection, default environment bootstrap, automatic import/capture, and offline bundle directions are withdrawn. Native Plugins may intentionally be harness-specific and retain their upstream manifests, MCP, Hooks, and configuration semantics. Core provides no general extension language or cross-harness capability translation.

Runtime versions are managed from official immutable release artifacts. Existing v1 environments are preserved and never automatically migrated. Native user state, configuration, credentials, sessions, Memory, external services/commands, and model behavior are outside the reproduction boundary.

See the current [command contract](../commands.md), [package format](../manifest.md), and [native adapter contracts](../agent-adapters.md) for implementation details and explicit limitations.
