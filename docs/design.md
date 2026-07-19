# Architecture and isolation model

## Ownership boundaries

Harness Conda separates reusable Agent capabilities from repository knowledge.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$HARNESS_HOME/packages/` |
| Environment recipes and locks | User-global | `$HARNESS_HOME/environments/<name>/` |
| Codex and Claude Environment views | User-global | `$HARNESS_HOME/environments/<name>/view/` |
| Authentication and session runtime | User-global, shared | `$HARNESS_HOME/runtime/<agent>/` |
| Mutation locks | User-global | `$HARNESS_HOME/locks/` |
| Environment selection | Current shell | `HARNESS_ENV` (defaults to `base`) |
| Shared and Package-specific Memory | Project-local | `<project>/.harness/memory/` |
| Machine-specific Memory | Project-local, uncommitted | `<project>/.harness/local/` |

An Environment recipe records root Packages and Agent targets. Its lock records the exact recursive dependency closure. Multiple Environments referencing the same Package resolution share one immutable cache entry.

`base` is lazily initialized on first use and cannot be removed. Every Environment must contain the `harness-project-memory` and `meta-skill-builder` roots.

## Activation and direct Agent launch

Every Environment owns one reusable Agent view:

```text
global Environment recipe and lock
        |
        v
content-addressed Package store
        |
        v
global Codex/Claude Environment view
        |
        v
shell-selected CODEX_HOME / CLAUDE_CONFIG_DIR
        |
        v
direct codex or claude
```

Skill directories in the view are symbolic links into immutable Package Store entries. MCP and Hook configuration is generated once per Environment. Non-Harness authentication and session paths are linked through a stable shared runtime root, seeded from the user's original Agent configuration roots. Known first-use paths are linked before they exist so a login performed after Environment creation is shared immediately. On the next Environment activation, Harness also adopts runtime files atomically replaced by an Agent and propagates deletions such as logout to the shared root. Environment-managed configuration files merge the user's baseline configuration and reject conflicting MCP definitions. Claude's default runtime state is read from `~/.claude.json`, while its configuration directory remains `~/.claude/`.

The shell hook saves the original Agent configuration roots. For every target supported by the selected Environment it exports that Environment's Agent view; for unsupported targets it restores the original Agent configuration root. It wraps only `harness activate` and `harness deactivate` so a successful CLI operation can update the parent shell. It never proxies `codex` or `claude`.

The Memory manager is available through the view like any other Skill. Harness initializes marker-delimited startup instructions in both project `AGENTS.md` and `CLAUDE.md`. These discovery pointers are stable project configuration: Environment activation may add a missing pointer but never removes one based on shell-local target selection. Existing instruction symlinks and file modes are preserved. At Agent startup, the Memory Skill calls `harness info --json`, reads project and local Memory, maps selected Skills to their Packages, and reads Package-specific Memory before use.

Harness does not proxy Agent commands and does not maintain session-to-Environment metadata. Resuming a session under a different Environment is user-managed.

## Conda parity

The implementation provides:

- one global physical Package cache;
- global named Environment recipes and independent dependency locks;
- one global target-specific view per Environment;
- Environment-isolated Skill, MCP, and Hook visibility;
- direct Agent launch through shell-selected configuration roots;
- project-local Memory independent of Environment storage.

Updating an Environment transactionally refreshes the managed paths in its global view. All projects and newly started Agent processes selecting that Environment therefore observe the same package closure without reactivation. Already-running Agent processes may retain startup-time Skill discovery and should be restarted after an Environment change.

Harness does not yet bind Agent session IDs to Environments. A resumed session uses whichever Environment is selected in the current shell; maintaining that consistency remains the user's responsibility.

## Transaction boundary

Environment mutations are serialized with filesystem-backed per-Environment locks. Recipes and locks are re-read inside the lock before resolution. Package resolution and validation complete before the current view is changed. Harness builds managed resources in a temporary directory, validates resource conflicts, and moves previous managed paths aside before installing replacements. The recipe and lock are committed inside the same ordinary-error rollback boundary; failures restore the previous view and metadata. Project activation uses a separate project lock and rolls back `.gitignore`, Memory initialization, and discovery updates on ordinary errors. Abrupt process termination is outside the current transaction guarantee because there is no persistent transaction journal.
