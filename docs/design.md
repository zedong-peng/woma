# Architecture and isolation model

## Ownership boundaries

Harness Conda separates reusable Agent capabilities from repository knowledge.

| Data | Scope | Location |
| --- | --- | --- |
| Immutable Package contents | User-global | `$HARNESS_HOME/packages/` |
| Environment recipes and locks | User-global | `$HARNESS_HOME/environments/<name>/` |
| Active Agent projection ownership | Project-local | `<project>/.harness/state.json` |
| Shared and Package-specific Memory | Project-local | `<project>/.harness/memory/` |
| Machine-specific Memory | Project-local, uncommitted | `<project>/.harness/local/` |

An Environment recipe records root Packages and Agent targets. Its lock records the exact recursive dependency closure. Multiple Environments referencing the same Package resolution share one immutable cache entry.

`base` is lazily initialized on first use and cannot be removed. Every Environment must contain the `harness-project-memory` and `meta-skill-builder` roots.

## Activation and direct Agent launch

Activation currently builds a project-native view from the selected global Environment:

```text
global Environment lock
        |
        v
content-addressed Package store
        |
        v
project Codex/Claude projection
        |
        v
direct codex or claude launch
```

The Memory manager is projected like any other Skill. Harness also maintains a marker-delimited pointer in the project `AGENTS.md` or `CLAUDE.md`. At Agent startup, the Memory Skill calls `harness info --json`, reads project and local Memory, maps selected Skills to their Packages, and reads Package-specific Memory before use.

Harness does not proxy Agent commands and does not maintain session-to-Environment metadata. Resuming a session under a different Environment is user-managed.

## Conda parity

The implementation currently provides:

- one global physical Package cache;
- global named Environment recipes and independent dependency locks;
- isolated project visibility after activation;
- project-local Memory independent of Environment storage.

It does not yet provide a true global per-Environment Agent prefix. Skills are materialized into each active project's native Agent directories instead of one reusable Environment view. Consequences include:

- activated Skill directories are physical project projections;
- updating a global Environment from one project can leave another project's existing projection stale until reactivation;
- activation selection is recorded per project rather than being a pure shell/process prefix;
- an Environment cannot yet provide the same already-materialized view to arbitrary projects without activation.

Full Conda-style parity requires target-specific views under each global Environment plus a reliable way for direct Codex and Claude processes to select those views. That work must preserve direct `codex` and `claude` commands without introducing mandatory Harness launch wrappers.

## Transaction boundary

Package resolution and lock validation complete before active files are changed. Active installation snapshots the Environment recipe, lock, project Adapter state, Skills, MCP configuration, hooks, and Memory discovery blocks. Ordinary errors restore the snapshot. Abrupt process termination is outside the current transaction guarantee because there is no persistent transaction journal.
