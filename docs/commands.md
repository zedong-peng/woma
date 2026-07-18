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

When `--name` is omitted, installation uses the Environment active in the current project and otherwise falls back to `base`.

Supported sources:

```text
builtin:<name>
./local/path
gh:<owner>/<repository>#<revision>
https://host/repository.git#<revision>
git@host:owner/repository.git#<revision>
```

Installation recursively resolves dependencies, validates identities and SemVer constraints, rejects cycles and source conflicts, and atomically updates the Environment recipe and lock. Installing into the active Environment also updates the project Agent projection in the same ordinary-error rollback boundary.

## Activation

```bash
harness activate [environment]
harness deactivate
```

`activate` defaults to `base`. It projects the complete Environment closure into the current project's Codex and/or Claude Code directories. Run the Agent normally afterward:

```bash
codex
claude
```

`deactivate` switches the project projection back to `base`. Harness does not currently associate Codex or Claude session IDs with Environments; activate the intended Environment before resuming an existing session.

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

`info --json` is the stable machine-readable context interface used by `harness-project-memory`. It returns the project root, selected Environment, Memory paths, Packages, Skills, and entrypoints. It replaces the redundant user-facing `current` command.

`sync` restores missing content-addressed Package entries from exact lock sources. `doctor` validates dependency locks, platform support, executable and environment requirements, active Adapter ownership, Memory discovery instructions, and managed-file drift.

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

Evaluate the output from the shell startup file to show `(harness:<environment>)` in the prompt. The hook does not proxy `codex` or `claude`.
