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

## Environment migration

```bash
harness env export --name <environment> --output <file.harness-env>
harness env import <file.harness-env> [--name <new-environment>]
```

`env export` creates one deterministic, gzip-compressed bundle containing the Environment recipe, exact lock, and byte-complete Package dependency closure. It therefore remains importable when an original Git remote is unavailable or a `file:` Package source no longer exists.

`env import` validates the complete bundle before publishing a new global Environment. The exported name is used by default; `--name` selects another name. Import refuses `base` and every existing destination instead of merging or overwriting them.

Bundles contain Package files, Skills, MCP definitions, Hooks, source provenance, and integrity metadata. They do not contain shared Agent runtime, authentication, sessions, environment-variable values, Project Memory, machine-local Memory, `AGENTS.md`, or `CLAUDE.md`. Package instructions and Hooks are executable trust input, so inspect bundles received from another person before activation.

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

Installation recursively resolves dependencies, validates Package and Skill identities and SemVer constraints, rejects cycles and source conflicts, and publishes one complete global Agent view generation atomically. Package Store entries are read-only after publication. Every project using that Environment observes the new view without reactivation; already-running Agent processes may need a restart to rediscover Skills.

## Activation

```bash
harness activate [environment]
harness deactivate
```

`activate` defaults to `base`. With the recommended shell hook installed, it selects each supported Agent view in the parent shell and leaves unsupported Agents on their original configuration homes. It atomically initializes Project Memory and stable discovery pointers for both Agents in the current project. Environment selection belongs only to the shell and is never recorded in the project. Run the Agent normally afterward:

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

`env list` marks the Environment selected in the current shell. `env show` displays one Environment's roots, targets, and locked closure.

`info --json` is the stable machine-readable context interface used by `harness-project-memory`. It returns the configured project directory, selected Environment, Memory paths, Packages, Skills, and entrypoints. It replaces the redundant user-facing `current` command.

`sync` restores missing or corrupt content-addressed Package entries from exact lock sources and rebuilds the global view. It can repair `base` when its recipe and lock remain parseable even if its Package cache or view is damaged. `doctor` validates dependency locks, the exact Skill visibility closure, the global view, platform support, executable and environment requirements, selected targets, and Memory discovery instructions.

## Package authoring

```bash
harness init [directory] [--name <name>]
harness inspect <source>
harness capture <directory> --from codex|claude [--name <name>]
```

`init` scaffolds a Package or meta-skill into a new or empty destination and refuses non-empty destinations. `capture` exports supported resources from an existing Agent project configuration without copying literal credential values; its output directory must not already exist. Both commands stage and validate their output before publication and leave no partial package after a normal failure.

## Shell integration

```bash
harness shell hook [bash|zsh]
```

Add the following line to `~/.bashrc` or `~/.zshrc`:

```bash
eval "$(harness shell hook)"
```

The hook saves the original Agent configuration roots, validates the selected Environment before exporting its view, restores the original root for unsupported targets, and shows `(harness:<environment>)` in the prompt. A stale inherited selection falls back to `base` with a warning. Only a successful top-level `activate` or `deactivate` updates the parent shell; help and unrelated commands are inert. The hook does not proxy `codex` or `claude`.
