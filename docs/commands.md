# Command reference

## Environment lifecycle

```bash
harness env list
harness env create <name> [--target codex|claude|both]
harness env show <name>
harness env remove <name>
```

`base` is initialized automatically and cannot be explicitly created or removed. Every Environment contains `harness-project-memory` and `meta-skill-builder` as foundational root Packages.

Environment recipes and locks are stored under `$HARNESS_HOME/environments/`. `HARNESS_HOME` defaults to `~/.harness-conda`.

## Package installation

```bash
harness install [-n <environment>] <source>
```

When `--name` is omitted, installation uses `HARNESS_ENV`, then the Environment selected in the current project, and otherwise falls back to `base`.

Supported sources:

```text
builtin:<name>
./local/path
gh:<owner>/<repository>#<revision>
https://host/repository.git#<revision>
git@host:owner/repository.git#<revision>
```

Installation recursively resolves dependencies, validates identities and SemVer constraints, rejects cycles and source conflicts, and atomically updates the Environment recipe, lock, and global Agent view. Every project using that Environment observes the new view without reactivation; already-running Agent processes may need a restart to rediscover Skills.

## Activation

```bash
harness activate [environment]
harness deactivate
```

`activate` defaults to `base`. With the recommended shell hook installed, it selects the Environment's global Codex and Claude views in the parent shell. It also initializes Project Memory and records the repository's selected Environment. Run the Agent normally afterward:

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

`env list` marks the Environment selected in the current project. `env show` displays one Environment's roots, targets, and locked closure.

`info --json` is the stable machine-readable context interface used by `harness-project-memory`. It returns the configured project directory, selected Environment, Memory paths, Packages, Skills, and entrypoints. It replaces the redundant user-facing `current` command.

`sync` restores missing content-addressed Package entries from exact lock sources and rebuilds the global view. `doctor` validates dependency locks, the global view, platform support, executable and environment requirements, selected targets, and Memory discovery instructions.

## Package authoring

```bash
harness init [directory] [--name <name>]
harness inspect <source>
harness capture <directory> --from codex|claude [--name <name>]
```

`init` scaffolds a Package or meta-skill. `capture` exports supported resources from an existing Agent project configuration without copying literal credential values.

## Shell integration

```bash
harness shell hook [bash|zsh]
```

Add the following line to `~/.bashrc` or `~/.zshrc`:

```bash
eval "$(harness shell hook)"
```

The hook saves the original Agent configuration roots, exports `CODEX_HOME` and `CLAUDE_CONFIG_DIR` for the selected global view, wraps only the `harness` shell command so activation can update the parent shell, and shows `(harness:<environment>)` in the prompt. It does not proxy `codex` or `claude`.
