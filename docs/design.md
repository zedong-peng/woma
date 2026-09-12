# Minimal Conda-Like Harness Environments

Woma manages a harness installation environment: its fixed executable release, installed extensions, shell selection, and reproducible managed content. Its two user objects are Environment and Package.

## Conda reference

[Conda environments](https://docs.conda.io/projects/conda/en/latest/user-guide/concepts/environments.html) provide the primary user model: a directory contains an independently evolving installation set, a name locates that prefix, and activation selects it for a shell. Woma follows `create`, `install`, `update`, `remove`, `list`, `env list`, `activate/deactivate`, `run`, and `-n/-p` conventions.

Intentional differences: one harness per environment; no implicit base or auto-activation; no dependency solver that silently changes existing resolutions; native configuration and runtime state remain opaque; exact locks guarantee managed content on one platform, not model behavior. This release supports Bash/Zsh on macOS/Linux with Node.js and Git, not a general operating-system package environment.

## Storage and responsibilities

```text
$WOMA_HOME/
  store/v2/<sha256>/...          immutable package content
  environments/<name>/...       named prefixes
  prefixes.json                 known explicit prefixes
  locks/...                     serialized Woma writers

<prefix>/
  bin/codex                     stable executable launcher (or claude)
  home/                         real native home and writable state
  .woma/
    state.json                  authoritative lock + owned path inventory
    runtime/...                 fixed runtime files
    marketplace/...             Codex-only managed local plugin sources
    transactions/...            temporary publication backups/journal
```

The implementation separates source resolution (`source.ts`), package records and dependency traversal (`package.ts`), official Runtime Providers (`runtime.ts`), native registration adapters (`native.ts`), and environment publication (`transaction.ts`, `environment.ts`). Content hashing/caching and filesystem locks are reused across package kinds.

Sources resolve to immutable content. Each environment receives its own installation copies; writable native state is never shared through the content store. Skills use `home/skills/`. Native plugin paths follow verified harness contracts. No mutable config file is a symlink or a generation-swapped projection.

## Modification protocol

Environment writers acquire a lock keyed by canonical prefix. They validate existing content, resolve requested changes and dependency constraints, verify snapshots, stage managed files, and prepare narrow native configuration edits. Every write checks the expected previous content. The authoritative state file is published last.

On an ordinary failure, Woma restores only the paths it changed. If an external writer changes a path during rollback, Woma preserves that path and its backup and reports incomplete rollback. Interrupted transactions block later mutations and are diagnosed by `doctor`. This is not a crash-safe database, and Woma does not promise concurrency safety with external writers that ignore its lock. Avoid concurrent native installers/config writers during package changes. Start a new harness process afterward.

Woma does not adopt source changes during activation, automatically import native content, copy entire configurations, or merge runtime state. Explicit adoption snapshots and validates the native installation before recording ownership. A different unmanaged installation occupying the destination fails without overwriting it.

## Reproduction boundary

Recipe export is direct intent. Explicit lock export is the exact managed closure and runtime artifacts. Exports read metadata only and provide neither a native-home backup nor an offline bundle. Local snapshots must still be in the content store; Git and runtime sources must remain retrievable at their locked identities if uncached. All digests are verified.

Credentials, sessions, caches, Memory, model/provider settings, native plugin enable state, external commands, remote services, projects, and model behavior are outside the guarantee. Environment removal deletes the entire prefix, including those local states, with an explicit confirmation.

## Compatibility

v2 is a new format. v1 environments are retained, listed as legacy, and refused by v2 operations. There is no automatic migration. The old multi-target neutral-capability model, shared writable Skill roots, automatic base bootstrap, capture, generic MCP/Hook declarations, and configuration projections are removed. Native packages no longer need to be Agent-neutral.
