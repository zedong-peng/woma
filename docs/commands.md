# Command reference

Before `migrate skills` or `migrate sessions`, Harness checks the current user's processes for running Codex and Claude CLIs. When it finds one, it lists the PID and command and requires the user to type `yes` in an interactive terminal. Non-interactive migration fails while an Agent process is running. This check also applies to dry runs.

## Environment lifecycle

```bash
harness env list
harness create --name <name> [--target codex|claude|pi|qoder|both|all|<comma-separated-list>]
harness rename --name <environment> <new-name>
harness env remove <name>
```

`base` is initialized automatically and cannot be explicitly created or removed. For backward compatibility, `base`, `both`, and an omitted `--target` select Codex and Claude. Use `--target pi`, `--target qoder`, a comma-separated combination such as `codex,pi`, or `--target all` explicitly. New Environments start with no root Packages. Install `builtin:harness-project-memory` or `builtin:harness-package-builder` explicitly when either optional helper is needed.

`env create <name>` remains a compatibility spelling for `create --name <name>`. `rename` refuses `base`, an active source Environment, and every existing destination. It moves the complete Environment directory, including Agent-owned credentials, sessions, databases, and other opaque state, then validates the renamed managed view before succeeding.

On the first successful implicit creation of `base`, Harness uses `lstat`-style metadata checks on only the documented Codex/Claude `skills` and session migration paths. If a real supported file or directory exists, it writes one migration notice to stderr. It does not enumerate children, read contents, follow symlinks, print private names or paths, or import any state. Empty supported directories count as existing state. Supported credentials and provider configuration seed separately through the normal Environment view construction; Skills and sessions remain explicit migrations. The published base recipe is the durable one-time boundary, so no notice marker or discovered-state metadata is stored. Shell-hook and JSON stdout remain machine-readable.

Discovery does not imply adoption. Harness follows Conda's conservative separation between finding validated existing environments and explicitly creating, cloning, or importing them; it does not register an arbitrary Agent home as an Environment, just as Conda does not silently adopt an arbitrary Python or `venv` installation.

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

## Environment export and recreation

```bash
harness export [--name <environment>] --file <file.harness-env>
harness create --name <new-environment> --file <file.harness-env>
```

`export` creates one deterministic, gzip-compressed bundle containing the Environment recipe, exact lock, and byte-complete Package dependency closure. It defaults to the active Environment and then `base`, and remains reproducible when an original Git remote is unavailable or a `file:` Package source no longer exists. `env export` remains a compatibility spelling that requires an explicit name.

`create --file` validates the complete bundle before publishing a new global Environment. The required `--name` follows Conda's create interface and may differ from the exported name. Creation refuses `base` and every existing destination instead of merging or overwriting them. There is no `env import` command.

Bundles contain Package files, Skills, MCP definitions, Hooks, source provenance, and integrity metadata. They do not contain per-Environment Agent homes, authentication, sessions, databases, environment-variable values, Project Memory, machine-local Memory, `AGENTS.md`, or `CLAUDE.md`. Package instructions and Hooks are executable trust input, so inspect bundles received from another person before activation.

## Package installation

```bash
harness install [-n <environment>] [--commit <sha>] [--subdir <path>] <github-url>
```

When `--name` is omitted, installation uses the current shell's `HARNESS_ENV` and falls back to `base` when it is unset.

Supported sources:

```text
builtin:<name>
./local/path
https://github.com/<owner>/<repository>
https://host/repository.git
git@host:owner/repository.git
```

Each materialized source resolves to exactly one Package by the following ordered rules:

1. A root `harness.yaml` is a native Harness Package. Its manifest is authoritative.
2. A root `SKILL.md` is normalized into one implicit single-Skill Package.
3. One or more direct `skills/*/SKILL.md` files are normalized into one implicit multi-Skill Package containing all matching direct children.
4. Every other layout is rejected.

Recognition is intentionally non-recursive. A repository root containing several nested Package directories is a collection, not an installable Package; install one child directory explicitly. Harness does not invoke an Agent, infer MCP servers, Hooks, dependencies, or entrypoints, or write a generated manifest into the source.

For a Package below a Git repository root, pass `--subdir` with a normalized repository-relative path. The selected directory may be a standalone `SKILL.md` or a conventional directory containing every direct `skills/*/SKILL.md`; the latter becomes one Package exposing all of those Skills independently. Without `--subdir`, the same rules apply at the repository root. `--commit` accepts an immutable full commit SHA and defaults to the latest commit on the repository's default branch. The Environment lock keeps the source repository, subdirectory, full commit, and normalized content integrity as distinct provenance. Before a non-dry-run install or uninstall changes an Environment, Harness repairs missing or corrupt locked Package entries from this exact provenance, including the locked Git commit after its branch moves.

For an implicit Package, Harness parses each Skill's `name` and `description` from YAML frontmatter, copies the selected self-contained Skill directories into temporary staging, and generates a deterministic `harness.yaml` supporting Codex, Claude, Pi, and Qoder. A standalone Package uses the Skill name as its Package name. A multi-Skill Package derives its name from the selected local or Git source directory. Its informational version is `0.0.0+local.<content>` for local content or `0.0.0+git.<commit>` for Git. The ordinary manifest, symlink, identity, ownership, cache, and Environment transaction validation then applies.

Installation recursively resolves dependencies, validates Package and Skill identities and SemVer constraints, rejects cycles and source conflicts, and publishes one complete global Agent view generation atomically. Package Store entries are read-only after publication. Every project using that Environment observes the new view without reactivation; already-running Agent processes may need a restart to rediscover Skills.

## Package removal

```bash
harness remove <package> [-n <environment>] [-d|--dry-run]
```

When `--name` is omitted, removal uses the current shell's `HARNESS_ENV` and falls back to `base`. Only a Package recorded as a root in the Environment recipe can be requested. If the name identifies only a dependency, Harness reports every root that still requires it; unknown names fail without changing the Environment. Every explicit root, including the built-in Project Memory and Package Builder helpers, can be removed.

Removal removes the requested root from the recipe, recomputes the exact dependency closure of all remaining roots, and prunes newly unreachable Packages from the lock and complete Codex, Claude, Pi, and Qoder views. Shared dependencies and their resources remain. Managed Skills, MCP servers, and Hooks are reconciled through the same ownership-aware stable-home and atomic view transaction as installation. A normal failure restores the recipe, lock, managed stable-home state, and previous view generation. Immutable Package Store entries are retained for other Environments and future garbage collection.

`-d`/`--dry-run` reports the root, pruned Packages, Skills, MCP servers, and Hooks without publishing a view or changing Environment metadata. Like Conda, Harness names Package removal `remove`, retains `uninstall` as an alias, and uses `-n`/`--name` for Environment selection. Harness accepts one explicit root per operation, while `harness env remove` remains the command for deleting an entire Environment. Harness has no force-removal mode that can leave a broken dependency graph.

## Activation

```bash
harness activate [environment]
harness deactivate
```

`activate` defaults to `base`. With the recommended shell hook installed, it selects each supported Environment's stable Agent home in the parent shell and leaves unsupported Agents on their original configuration homes. Codex uses `CODEX_HOME`, Claude uses `CLAUDE_CONFIG_DIR`, Pi uses `PI_CODING_AGENT_DIR`, and Qoder uses `QODER_CONFIG_DIR`. Activation does not create Project Memory, edit `.gitignore`, or add Agent startup instructions. It removes an unchanged legacy Project Memory block from `AGENTS.md` or `CLAUDE.md` once when present. Activation also upgrades a legacy Environment with separate Agent Skill roots into the shared layout. Same-name legacy entries are deduplicated when their complete trees are equivalent; differing or unverifiable collisions fail before any entry moves. Environment selection belongs only to the shell and is never recorded in the project. Run the Agent normally afterward:

Every target Agent's conventional `skills` path links to `$HARNESS_HOME/environments/<environment>/home/skills`. An ordinary direct child with a valid `SKILL.md` installed through any target immediately becomes an Environment-local Skill visible through every other target path. Harness reports it with origin `external` and all effective targets because it does not infer which Agent or installer wrote the directory. Other Environments remain isolated. Hidden entries are preserved but excluded from Environment-local inventory; in particular, Codex owns `$CODEX_HOME/skills/.system`, including whether it is absent, a directory, or another Codex-managed representation.

Authentication and provider configuration also belong to the selected Environment. For Codex, edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml`. For Claude endpoint and API-key settings, edit `$CLAUDE_CONFIG_DIR/settings.json`; Claude OAuth login may additionally create `$CLAUDE_CONFIG_DIR/.credentials.json`. Managed configuration files under the original `~/.codex` and `~/.claude` homes seed a new Environment only and do not update existing Environments. For Pi, use `/login`, `/model`, or files under `$PI_CODING_AGENT_DIR`; Pi owns settings, credentials, models, Pi Packages, and sessions in the stable Environment home. A new Pi Environment does not copy the original `~/.pi/agent` state. For Qoder, log in through `qodercli` in the activated Environment. Harness manages `$QODER_CONFIG_DIR/settings.json` for Package MCP servers and Hooks; Qoder owns every other non-Skill file in that Environment home, and a new Qoder Environment does not copy the original `~/.qoder` state.

Each shell selects its own Environment through `HARNESS_ENV`, so multiple shells can run Agents from different stable homes concurrently. Credentials, provider configuration, opaque runtime state, and Codex system Skills remain isolated by Environment. Harness does not add a separate secret store: secret values remain in the selected Agent home or the shell environment and are excluded from Package manifests, locks, and Environment bundles.

The project defaults to the exact current working directory. Harness does not search parent directories for `.harness` or `.git`, so Git and non-Git projects follow the same rule. Run commands from the intended project root or pass the global `--project <directory>` option explicitly when working from a subdirectory.

```bash
codex
claude
pi
qodercli
```

`deactivate` leaves Harness Environment management in the current shell: it clears `HARNESS_ENV` and restores the `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `QODER_CONFIG_DIR` values captured before the shell hook selected an Environment. Use `harness activate base` when you want to switch explicitly to Harness's `base` Environment. Harness does not currently associate Codex, Claude, Pi, or Qoder session IDs with Environments; activate the intended Environment before resuming an existing session.

## Run

```bash
harness run [-n <environment>] [--cwd <directory>] <executable> [args...]
```

`run` starts one child process with the selected Environment's `HARNESS_ENV` and supported Agent home variables without changing the parent shell. Unsupported Agent targets use their original configuration homes. Standard input, output, and error are inherited directly, and the child exit status becomes the Harness exit status.

## Inspection and repair

```bash
harness env list
harness list [-n <environment>]
harness info [--json]
harness doctor [-n <environment>]
harness inspect <source-or-package> [-n <environment>]
```

`env list` enumerates registered Environment directories and marks the Environment selected in the current shell. It does not validate recipes, locks, Package Store entries, views, or runtime requirements, so a listed Environment is not necessarily healthy; use `doctor --name <environment>` for health. `list` displays the selected Environment's roots, targets, locked Package closure, every Package-managed Skill, MCP server, and hook, and valid Environment-local Skills from the shared root. Package Skill rows show the resource name, providing Package, and effective target platforms. Environment-local Skill rows use `external` instead of a Package identity and show every Environment target. MCP server rows additionally show the transport, and hook rows show the event and matcher (`*` when omitted). Effective targets preserve Environment target order and intersect those targets with the resource's explicit platforms, or with the Package platforms when the resource has no override. A declared resource with no effective target is still shown with `none`, and an empty resource section also shows `none`.

Pass `--name` to inspect another Environment; otherwise the command uses the active Environment and falls back to `base`. If a locked Package cache is unavailable, the Package remains in the summary and appears once under `unavailable packages`. `doctor` reports the damage; reinstall one of the Environment's root Package sources to repair its exact locked closure before applying the requested installation.

`info` also reports whether each supported native Agent CLI is available on the current `PATH` and shows the resolved executable path when found. It checks `codex`, `claude`, `pi`, and `qodercli` without launching them or reading Agent configuration. `info --json` is the stable machine-readable context interface used by `harness-project-memory` only when that optional Skill is explicitly selected. Its `agentClis` mapping contains each Agent's command, availability, and resolved path in addition to the configured project directory, selected Environment, Memory paths, Packages, Skills, entrypoints, `environmentSkills`, and `environmentSkillIssues`; it does not create or read Memory contents. Each external Environment Skill has `platform: "environment"` and a `platforms` array containing every target that sees the shared root. It replaces the redundant user-facing `current` command.

`inspect` applies the same source recognition and normalization rules as installation. `doctor` validates dependency locks, the exact Package-managed Skill visibility closure, the global view, platform support, executable and environment requirements, selected targets, and any legacy Project Memory discovery blocks that need cleanup. For each Environment target it reports the native Agent CLI path or warns when that CLI is not available; a missing Agent CLI does not make an otherwise portable Environment corrupt. It also reports valid Environment-local Skills, warns about invalid `SKILL.md` metadata, and fails on names that conflict with Harness-managed Skills. Hidden children such as `.system` are excluded from this inventory.

There is no `harness sync` command. Like [pip packages installed inside an active Conda environment](https://docs.conda.io/projects/conda/en/latest/user-guide/tasks/manage-pkgs.html#installing-non-conda-packages), an Environment-local Skill is visible to every target without a second package-manager command. A newly started Agent reads it immediately; an already-running Agent may still require its normal rediscovery or restart behavior. Harness intentionally does not add external Skills to the recipe or lock: use `harness install` when the content should become an immutable, reusable Package. Environment bundles therefore contain the locked Harness Package closure and exclude Environment-local Skills.

## Package authoring

```bash
harness skeleton workflow <name> [-o|--output-dir <directory>] [--version <version>]
harness inspect <source>
harness capture <directory> --from codex|claude [--name <name>]
```

Conda's separately installed `conda-build` adds provider-oriented commands such as `conda skeleton pypi <package> --output-dir <directory>`. Harness uses the same command shape while adapting providers to Agent capabilities. `skeleton workflow` creates `<output-directory>/<name>/harness.yaml` and a coordinating `<name>-workflow` Skill. Names are normalized to Harness Package identifiers, `--version` must be an exact SemVer, the output directory defaults to the current directory, and an existing non-empty destination is never overwritten. Additional source-aware providers can be added without changing the top-level interface.

`capture` exports supported resources from an existing Agent project configuration without copying literal credential values; its output directory must not already exist. The optional `harness-package-builder` Skill remains the full Package authoring capability. It can wrap existing Skills and Agent resources, update a Package, aggregate dependencies, or author an optional coordinating entrypoint Skill before validating the result with `inspect`. `skeleton` is intentionally limited to deterministic recipe generation rather than becoming a second Package builder.

## Shell integration

```bash
harness init [bash|zsh] [--dry-run] [--reverse]
```

Initialize the current login shell after installing or updating Harness:

```bash
harness init
```

Like `conda init`, `harness init` adds a marker-delimited managed block to the selected shell profile. Bash uses `~/.bash_profile` on macOS and `~/.bashrc` elsewhere; Zsh uses `$ZDOTDIR/.zshrc` when `ZDOTDIR` is set and `~/.zshrc` otherwise. The command writes a static, versioned hook to `$HARNESS_HOME/shell`, and the profile only sources that file. Initialization also removes legacy `eval "$(harness shell hook)"` lines left by versions that still had the public `shell` command. Repeated initialization is a no-op, `--dry-run` prints the planned file actions, and `--reverse` removes the managed block and static hook while preserving user-owned profile content, modes, and symbolic links.

`init` is the only public shell-integration command. Hook generation and sourcing do not create, validate, synchronize, or repair an Environment; load Packages; initialize Memory; mutate the current project; or acquire Harness locks. An explicit command such as `info`, `env list`, `install`, `activate`, or `doctor` initializes `base` lazily when needed.

The sourced hook saves the original Codex, Claude, Pi, and Qoder configuration roots and performs bounded path checks before exporting an existing Environment's view. A stale inherited selection falls back to an existing usable `base` with a warning. If `base` is also unavailable, it restores all original Agent homes and leaves no Harness Environment selected. It restores the original root for each unsupported target and shows `(harness:<environment>)` only when selection succeeds. Only a successful top-level `activate` or `deactivate` updates the parent shell; help and unrelated commands are inert. The hook does not proxy `codex`, `claude`, `pi`, or `qodercli`.
