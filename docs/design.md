# Architecture and isolation model

## Ownership boundaries

Harness Conda separates reusable Agent capabilities from repository knowledge.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$HARNESS_HOME/packages/` |
| Environment recipes and locks | User-global | `$HARNESS_HOME/environments/<name>/` |
| Codex and Claude Environment views | User-global | `$HARNESS_HOME/environments/<name>/view/` |
| Environment selection and Memory bootstrap state | Project-local | `<project>/.harness/state.json` |
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

Skill directories in the view are symbolic links into immutable Package Store entries. MCP and Hook configuration is generated once per Environment. Non-Harness files and directories in the user's original Agent configuration roots are linked into the view so authentication, logs, and session storage are not copied per Environment. Environment-managed configuration files merge the user's baseline configuration and reject conflicting MCP definitions.

The shell hook saves the original Agent configuration roots and exports the selected Environment's `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. It wraps only `harness activate` and `harness deactivate` so a successful CLI operation can update the parent shell. It never proxies `codex` or `claude`.

The Memory manager is available through the view like any other Skill. Harness maintains a marker-delimited startup instruction in the project `AGENTS.md` or `CLAUDE.md`. At Agent startup, the Memory Skill calls `harness info --json`, reads project and local Memory, maps selected Skills to their Packages, and reads Package-specific Memory before use.

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

Package resolution and lock validation complete before the current view is changed. Harness builds all managed resources in a temporary directory, validates resource conflicts, and moves the previous managed paths aside before installing their replacements. The recipe and lock are committed inside the same ordinary-error rollback boundary; failures restore the previous view and metadata. Runtime-created state outside the managed paths remains in the stable Environment prefix. Abrupt process termination is outside the current transaction guarantee because there is no persistent transaction journal.
