# harness-conda

Create, reproduce, and switch isolated Agent environments.

Harness Conda manages versioned packages containing Skills, meta-skills, MCP servers, and hooks. A meta-skill is an ordinary Skill whose natural-language method composes other Skills; package dependencies make the complete method installable and reproducible without turning it into a workflow DAG.

## Install from source

Harness Conda is not published to the npm Registry yet. Install the current CLI from this repository:

```bash
git clone https://github.com/zedong-peng/harness-conda.git
cd harness-conda
npm ci
npm run build
npm link
harness --version
```

`npm link` exposes the locally built `harness` and `harness-conda` binaries. To avoid a global link, replace `harness` in the examples below with:

```bash
node /path/to/harness-conda/dist/src/cli.js
```

Enable the Conda-style active Environment prefix for the current shell:

```bash
# zsh
eval "$(harness shell hook zsh)"

# bash
eval "$(harness shell hook bash)"
```

Add the matching `eval` line to `~/.zshrc` or `~/.bashrc` to enable it in future shells. When no shell name is supplied, `harness shell hook` detects bash or zsh from `$SHELL`.

## Quick start

```bash
# base is available immediately; no create command is required.
harness current
harness install builtin:auto-research
harness activate

# The prompt now starts with (harness:base).
codex

harness deactivate                 # returns to base
```

`base` is a global, implicit Environment initialized on first use; users never create or remove it. `install` uses the selected Environment when `--name` is omitted and otherwise falls back to `base`. Every Environment always contains the foundational `harness-project-memory` and `meta-skill-builder` packages. Installing `auto-research` recursively installs and locks its component packages. Activation makes the complete dependency closure available to the selected Agent in dependency-first order.

Only one Environment is active in a project. Activating another Environment atomically removes packages unique to the old Environment, preserves identical shared packages, activates the new closure, and rolls back if the transition fails.

## Mental model

```text
Package
  = versioned distribution unit containing Skills, MCP, hooks, or scripts

Meta-Skill
  = ordinary Skill with a natural-language method and Package dependencies

Environment
  = root Packages + recursive dependency closure + targets + lock

Project Memory
  = natural-language repository knowledge shared globally or isolated by Package

Base Environment
  = implicit global default with the foundational packages
```

Harness Conda does not decide what phase a task is in, advance workflow steps, require handoffs, or record outcomes. The user and Agent define and execute the method; Harness Conda installs, isolates, locks, activates, migrates, and shares it.

## Environments

```bash
harness env create cpp-performance --target codex
harness env list
harness env show cpp-performance
harness env remove cpp-performance
```

The `base` fallback makes the common case shorter while preserving named Environment isolation:

```bash
harness install builtin:paper-search    # installs into base
harness activate                        # activates base
```

`harness current` reports `base` on a fresh installation and lazily initializes it if necessary. `harness env create base` and `harness env remove base` are rejected.

Use explicit names whenever you need multiple reusable combinations:

```bash
harness env create research --target codex
harness env create performance --target codex
harness activate research
harness activate performance            # atomic switch
```

With a named Environment active, omitted `--name` values select that Environment. Packages update it directly:

```bash
# prompt: (harness:research)
harness install builtin:paper-search     # installs and activates in research
```

Active installation resolves and validates the complete next closure before updating the project. Harness snapshots the recipe, lock, activation state, Skills, MCP configuration, and hooks; it applies the package delta in dependency order and restores the snapshot if any ordinary error occurs. Installing into an inactive Environment continues to update only its recipe and lock.

With the shell hook enabled, the prompt shows `(harness:base)`, `(harness:research)`, or `(harness:performance)`. The `harness:` namespace remains unambiguous when a Python Conda Environment is also active, for example `(py310) (harness:research)`. After activation, launch `codex` or `claude` directly; no Harness-specific Agent launcher is required. Harness does not currently bind third-party Agent session IDs to Environment versions, so users are responsible for activating the intended Environment before resuming an old session.

Environment definitions and immutable Package contents are user-global:

```text
~/.harness-conda/
├── packages/
│   └── <package>/<content-key>/
└── environments/
    ├── base/
    │   ├── environment.yaml
    │   └── lock.json
    └── cpp-performance/
        ├── environment.yaml
        └── lock.json
```

Agent Adapter state and project knowledge remain project-local:

```text
<project>/.harness/
├── memory/
│   ├── project.md
│   └── packages/
├── local/
│   └── memory.md
└── state.json
```

The YAML recipe records root packages and Agent targets. The lock records the exact source, Git revision, integrity, cache key, and dependency edges for the full closure. Multiple projects reuse the same Environment and content-addressed Package store. Activation projects the selected closure into the current project's native Codex/Claude locations, while `memory/` remains isolated per project. `state.json` and `local/` are machine-local and must not be committed.

## Packages and meta-skills

Install an atomic capability:

```bash
harness install -n research builtin:paper-search
```

Install a complete method:

```bash
harness install -n research builtin:auto-research
```

Example meta-skill manifest:

```yaml
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: auto-research
  version: 1.0.0
  description: Turn related work into a defensible experiment plan.
spec:
  platforms: [codex, claude]
  dependencies:
    - name: paper-search
      version: ^1.0.0
      source: builtin:paper-search
    - name: idea-gen
      version: ^1.0.0
      source: builtin:idea-gen
    - name: exp-design
      version: ^1.0.0
      source: builtin:exp-design
  entrypoints:
    - name: research
      skill: auto-research
      description: Produce an evidence-backed, falsifiable experiment plan.
  skills:
    - name: auto-research
      path: ./skills/auto-research
```

The `auto-research/SKILL.md` file describes how and when to use the component Skills, including branching, retry, interruption recovery, stopping conditions, and expected outputs. Harness Conda reads only the package graph; the Agent interprets the method.

The four packages above are real built-ins shipped with the source distribution, so the Quick Start runs without a package Registry. Until a Registry exists, other dependencies include an explicit local, built-in, GitHub, HTTPS Git, or SSH Git source. Published packages should use immutable Git tags or revisions.

### Create a meta-skill with the Agent

The built-in authoring assistant is foundational and therefore available in every Environment. Activate the Environment in which you want to author a portable package:

```bash
harness env create authoring --target codex
harness activate authoring

codex
```

Describe the component Skill sources, intended outcome, normal ordering, feedback loops, branches, interruption recovery, stopping conditions, and output contract in natural language. The assistant generates an ordinary `harness.yaml` plus one coordinating `SKILL.md`, declares the component packages as dependencies, and validates the complete result with `harness inspect`.

The assistant authors the method; Harness Conda remains neutral about its execution. It does not turn the method into a DAG or add workflow phases to the core.

## Project Memory

Portable Skills should not hard-code one repository's build, test, benchmark, or operational conventions. Users describe those details naturally to the Agent, which records stable, verified knowledge in isolated Project Memory:

```text
.harness/memory/project.md                         shared repository knowledge
.harness/memory/packages/performance-engineering.md  package-specific adaptation
.harness/local/memory.md                           machine-specific, git-ignored context
```

`harness-project-memory` is a normal built-in package, versioned and locked like `meta-skill-builder` or any third-party package. It is projected to `.agents/skills/` or `.claude/skills/` with the other active Skills. When it is active, Harness installs a small managed pointer in `AGENTS.md` or `CLAUDE.md` that tells the Agent to read its `SKILL.md` at session start. The Skill runs `harness current --json` to discover the current package-to-Skill and package-to-Memory mapping dynamically. Third-party Skills require no Harness-specific changes.

When the user states a durable project fact, the Agent records it automatically in shared, package-scoped, or local Memory even if the user does not explicitly say “remember this.” Temporary, speculative, current-task-only, or secret information is not persisted. Harness does not interpret the prose, execute commands from it, or manage workflow progress. See [the Project Memory specification](docs/project-memory.md).

## Reproduction

Environment recipes and locks live under `~/.harness-conda/environments/`, independently of any project. `sync` restores exact locked Package snapshots into the global content-addressed cache and rejects source drift. Project Memory can be versioned with its repository when appropriate; machine-local Memory remains excluded. Environment bundle import/export is planned but is not yet exposed by the CLI.

Project-local Environment recipes from earlier versions are not silently moved or deleted. If Harness finds `<project>/.harness/environments/<name>.yaml` without a corresponding global Environment, it stops with a migration message. Recreate the named global Environment and reinstall its roots after reviewing the legacy recipe; existing Project Memory is preserved.

## Commands

| Command | Purpose |
| --- | --- |
| `harness env create <name>` | Create a global Environment with the foundational packages |
| `harness env list` | List Environments and mark the active one |
| `harness env show <name>` | Show roots, resolved packages, and targets |
| `harness env remove <name>` | Remove an inactive Environment; `base` cannot be removed |
| `harness install [-n <env>] <source>` | Install a Package and recursive dependencies; defaults to active, then `base` |
| `harness activate [env]` | Atomically activate or switch an Environment; defaults to `base` |
| `harness deactivate` | Leave the selected Environment and return to `base` |
| `harness current [--json]` | Show the active Environment; JSON includes package, Skill, and Memory mappings |
| `harness shell hook [bash\|zsh]` | Print shell integration for the active-Environment prompt |
| `harness sync [-n <env>]` | Restore exact locked packages |
| `harness doctor [-n <env>]` | Verify lock, requirements, and activation |
| `harness init [directory]` | Scaffold a Package or meta-skill |
| `harness inspect <source>` | Inspect a Package manifest without installing it |
| `harness capture <directory>` | Capture Agent resources as a Package |

## Removed workflow commands

Version 0.6 removes `onboard`, `project`, `profile`, `switch`, `leave`, `enter`, `handoff`, `outcome`, `stats`, `use`, and `eval` from the core CLI. These commands encoded a research-specific phase model that does not belong in a neutral environment manager.

Migration mapping:

```text
profile add / install --profile  -> install -n <environment>
switch <profile>                 -> activate <environment>
leave                            -> deactivate
project init / onboard           -> env create
enter <profile>                  -> activate <environment>, then launch the Agent
```

Handoffs, outcome tracking, workflow evaluation, and other execution policies can be distributed as optional Skills or separate tools.

If a project still has an active v0.5 profile or low-level package activation, run the new `harness deactivate` once before creating or activating Environments. This cleanup path is retained for migration even though the old commands are no longer exposed.

## Safety

- Package cache entries are content-addressed and integrity-checked.
- Environment lock updates validate the entire dependency graph before writing.
- Activation refuses conflicting Skills and MCP entries.
- Environment switching checks managed-file drift before changing active state.
- Active installation updates the lock, materialized resources, and activation state together and restores the previous snapshot on error.
- Deactivation removes only unchanged resources owned by the Environment.
- Git and built-in packages cannot use local dependency paths to read installation-machine files.
- Captured MCP configuration contains environment-variable names, never literal secret values.

See [the package manifest reference](docs/manifest.md) for the complete package schema.
