# Command reference

Before `migrate skills` or `migrate sessions`, Harness checks the current user's processes for running Codex and Claude CLIs. When it finds one, it lists the PID and command and requires the user to type `yes` in an interactive terminal. Non-interactive migration fails while an Agent process is running. This check also applies to dry runs.

## Environment lifecycle

```bash
harness env list
harness env create <name> [--target codex|claude|both]
harness env show <name>
harness env remove <name>
```

`base` is initialized automatically and cannot be explicitly created or removed. Every Environment contains `harness-project-memory` and `harness-package-builder` as foundational root Packages. Environment initialization never scans or imports ordinary Skills or session state from existing Agent homes.

Environment recipes and locks are stored under `$HARNESS_HOME/environments/`. `HARNESS_HOME` defaults to `~/.harness-conda`.

## Existing Skill migration

```bash
harness migrate skills [--from codex|claude|both] [-n <environment>] [--dry-run]
```

`migrate skills` explicitly snapshots ordinary Skills from the original Codex and Claude `skills/` directories and atomically installs one single-Skill Package per discovered Skill into the requested Environment. Each Package has the same name as its Skill and an independent content-derived version. Without `--name`, the command uses the active Environment and falls back to `base`. `--from` defaults to `both`. `--dry-run` copies, normalizes, and validates temporary Packages and checks target conflicts without publishing snapshots, Packages, or Environment changes.

Hidden Agent-managed entries such as Codex `.system` are excluded. Identical cross-Agent Skills are deduplicated; different same-name contents fail with instructions to select one source. Existing Package or Skill ownership conflicts in the target Environment fail instead of being overwritten. Root symlinks are copied as self-contained content, safely normalizable legacy frontmatter is corrected only in the snapshot, and original Agent files remain unchanged.

Published sources are read-only and content-addressed under `$HARNESS_HOME/migrations/skills/<skill-name>/`. Repeating an unchanged migration is a no-op. When one source Skill changes, only that Skill's Package version and root change in the selected Environment; the other migrated Packages keep their existing identities. Old snapshots remain available to other locked Environments.

## Existing session migration

```bash
harness migrate sessions [--from codex|claude|both] [-n <environment>] [--dry-run]
```

`migrate sessions` explicitly copies known session and history state from the original Agent homes into the selected Environment's stable Agent homes. Without `--name`, it uses the active Environment and falls back to `base`. `--from` defaults to `both`, and every selected Agent must be supported by the destination Environment. `--dry-run` builds and verifies a temporary snapshot and checks target conflicts without changing the Environment.

Codex migration includes `sessions`, `archived_sessions`, `history.jsonl`, `session_index.jsonl`, and `shell_snapshots`. Claude migration includes `projects`, `history.jsonl`, `file-history`, `plans`, `session-env`, `shell-snapshots`, `tasks`, and `todos`. Credentials, provider configuration, Skills, plugins, caches, telemetry, and retired view generations are excluded.

The command rejects source symbolic links and special files so the destination contains only ordinary files and directories with no dependency on the original home. It verifies source fingerprints before and after copying and again immediately before publication. Missing target paths are added, identical files are a no-op, and different ordinary session content at the same path fails before publication rather than being overwritten.

`history.jsonl` and `session_index.jsonl` use a structured merge instead of whole-file conflict detection. Every non-empty line must be a JSON object. Codex history records additionally require a non-empty `session_id` and finite numeric `ts`; Claude history records require a non-empty `sessionId` and finite numeric `timestamp`. The merger preserves complete objects and unknown fields, hashes canonical key-sorted objects to remove exact duplicates, combines records from independent sessions, and sorts history by the platform's timestamp field. A verified temporary ordinary file atomically replaces the target, with rollback on ordinary publication failure. Dry-run output reports added and deduplicated record counts. Explicit migration also replaces legacy target links that point directly to the corresponding path in the selected original session tree with Environment-owned ordinary files or directories; unrelated target links remain conflicts. Original Agent files remain unchanged. Stop the source and destination Agent processes before migrating so their session files remain stable throughout the snapshot and merge.

## Environment migration

```bash
harness env export --name <environment> --output <file.harness-env>
harness env import <file.harness-env> [--name <new-environment>]
```

`env export` creates one deterministic, gzip-compressed bundle containing the Environment recipe, exact lock, and byte-complete Package dependency closure. It therefore remains importable when an original Git remote is unavailable or a `file:` Package source no longer exists.

`env import` validates the complete bundle before publishing a new global Environment. The exported name is used by default; `--name` selects another name. Import refuses `base` and every existing destination instead of merging or overwriting them.

Bundles contain Package files, Skills, MCP definitions, Hooks, source provenance, and integrity metadata. They do not contain per-Environment Agent homes, authentication, sessions, databases, environment-variable values, Project Memory, machine-local Memory, `AGENTS.md`, or `CLAUDE.md`. Package instructions and Hooks are executable trust input, so inspect bundles received from another person before activation.

## Package installation

```bash
harness install [-n <environment>] <source>
```

When `--name` is omitted, installation uses the current shell's `HARNESS_ENV` and falls back to `base` when it is unset.

Supported sources:

```text
builtin:<name>
./local/path
gh:<owner>/<repository>#<revision>
https://host/repository.git#<revision>
git@host:owner/repository.git#<revision>
```

Each materialized source resolves to exactly one Package by the following ordered rules:

1. A root `harness.yaml` is a native Harness Package. Its manifest is authoritative.
2. A root `SKILL.md` is normalized into one implicit single-Skill Package.
3. One or more direct `skills/*/SKILL.md` files are normalized into one implicit multi-Skill Package containing all matching direct children.
4. Every other layout is rejected.

Recognition is intentionally non-recursive. A repository root containing several nested Package directories is a collection, not an installable Package; install one child directory explicitly. Harness does not invoke an Agent, infer MCP servers, Hooks, dependencies, or entrypoints, or write a generated manifest into the source.

For an implicit Package, Harness parses each Skill's `name` and `description` from YAML frontmatter, copies the selected self-contained Skill directories into temporary staging, and generates a deterministic `harness.yaml` there. A standalone Package uses the Skill name as its Package name. A multi-Skill Package derives its name from the local source directory or Git repository. Its informational version is `0.0.0+local.<content>` for local content or `0.0.0+git.<commit>` for Git. The ordinary manifest, symlink, identity, ownership, cache, and Environment transaction validation then applies.

Installation recursively resolves dependencies, validates Package and Skill identities and SemVer constraints, rejects cycles and source conflicts, and publishes one complete global Agent view generation atomically. Package Store entries are read-only after publication. Every project using that Environment observes the new view without reactivation; already-running Agent processes may need a restart to rediscover Skills.

## Activation

```bash
harness activate [environment]
harness deactivate
```

`activate` defaults to `base`. With the recommended shell hook installed, it selects each supported Environment's stable Agent home in the parent shell and leaves unsupported Agents on their original configuration homes. It atomically initializes Project Memory and stable discovery pointers for both Agents in the current project. Environment selection belongs only to the shell and is never recorded in the project. Run the Agent normally afterward:

Authentication and provider configuration belong to the selected Environment. For Codex, edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml`. For Claude endpoint and API-key settings, edit `$CLAUDE_CONFIG_DIR/settings.json`; Claude OAuth login may additionally create `$CLAUDE_CONFIG_DIR/.credentials.json`. Managed configuration files under the original `~/.codex` and `~/.claude` homes seed a new Environment only and do not update existing Environments.

The project defaults to the exact current working directory. Harness does not search parent directories for `.harness` or `.git`, so Git and non-Git projects follow the same rule. Run commands from the intended project root or pass the global `--project <directory>` option explicitly when working from a subdirectory.

```bash
codex
claude
```

`deactivate` returns to `base`. Harness does not currently associate Codex or Claude session IDs with Environments; activate the intended Environment before resuming an existing session.

## Inspection and repair

```bash
harness env list
harness env show <name>
harness info [--json]
harness sync [-n <environment>]
harness doctor [-n <environment>]
harness inspect <source-or-package> [-n <environment>]
```

`env list` marks the Environment selected in the current shell. `env show` displays one Environment's roots, targets, locked Package closure, and every visible Skill with its providing Package and target platforms. If a locked Package cache is unavailable, the Package remains in the summary and its Skill details are marked unavailable; use `doctor` or `sync` to repair it.

`info --json` is the stable machine-readable context interface used by `harness-project-memory`. It returns the configured project directory, selected Environment, Memory paths, Packages, Skills, and entrypoints. It replaces the redundant user-facing `current` command.

`inspect` applies the same source recognition and normalization rules as installation. `sync` restores missing or corrupt content-addressed Package entries from exact lock sources, repeats the same normalization for implicit Packages, and rebuilds the global view. It can repair `base` when its recipe and lock remain parseable even if its Package cache or view is damaged. `doctor` validates dependency locks, the exact Skill visibility closure, the global view, platform support, executable and environment requirements, selected targets, and Memory discovery instructions.

## Package authoring

```bash
harness init [directory] [--name <name>]
harness inspect <source>
harness capture <directory> --from codex|claude [--name <name>]
```

`init` scaffolds a Package into a new or empty destination and refuses non-empty destinations. `capture` exports supported resources from an existing Agent project configuration without copying literal credential values; its output directory must not already exist. Both commands stage and validate their output before publication and leave no partial Package after a normal failure. The foundational `harness-package-builder` Skill can wrap existing Skills and Agent resources, update a Package, aggregate dependencies, or author an optional coordinating entrypoint Skill before validating the result with `inspect`.

## Shell integration

```bash
harness shell hook [bash|zsh]
```

Add the following line to `~/.bashrc` or `~/.zshrc`:

```bash
eval "$(harness shell hook)"
```

The hook saves the original Agent configuration roots, validates the selected Environment before exporting its view, restores the original root for unsupported targets, and shows `(harness:<environment>)` in the prompt. A stale inherited selection falls back to `base` with a warning. Only a successful top-level `activate` or `deactivate` updates the parent shell; help and unrelated commands are inert. The hook does not proxy `codex` or `claude`.
