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
harness env create --target codex
harness install builtin:auto-research
harness activate

# The prompt now starts with (harness:base).
codex

harness deactivate
```

`install` uses the active Environment when `--name` is omitted, then falls back to `base`, an empty project-local default that contains only the packages the user selects. `env create` without a name creates `base`, and `activate` without a name switches to `base`, matching Conda. Installing `auto-research` recursively installs and locks its component packages. Activating `base` makes the complete dependency closure available to the selected Agent in dependency-first order.

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
  = conventional default Environment; empty until the user installs Packages
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
harness env create --target codex       # creates base
harness install builtin:paper-search    # installs into base
harness activate                        # activates base
```

Use explicit names whenever a project needs multiple combinations:

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

With the shell hook enabled, the prompt shows `(harness:base)`, `(harness:research)`, or `(harness:performance)`. The `harness:` namespace remains unambiguous when a Python Conda Environment is also active, for example `(py310) (harness:research)`. The hook searches parent directories for the nearest `.harness`, so the prefix and CLI continue to use the same project from nested directories. The prefix disappears after `harness deactivate` or after leaving the project tree.

Environment state is project-local:

```text
.harness/
├── environments/
│   └── cpp-performance.yaml
├── locks/
│   └── cpp-performance.lock.json
├── memory/
│   ├── project.md
│   └── packages/
└── state.json
```

The YAML recipe records user-selected root packages and Agent targets. The lock records the exact source, Git revision, integrity, cache key, and dependency edges for the full closure. `memory/` contains portable natural-language project adaptation, while `state.json` and `local/` are machine-local and must not be committed.

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

Install the built-in authoring assistant when you want to turn your own multi-Skill method into a portable package:

```bash
harness env create authoring --target codex
harness install -n authoring builtin:meta-skill-builder
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

Methods read the relevant files when present, verify them against the repository, and ask or inspect when essential context is missing. Harness initializes and isolates these paths but does not interpret the prose, execute commands from it, or manage workflow progress. Project Memory must not contain credentials, transient task state, handoffs, outcomes, or unverified guesses. See [the Project Memory specification](docs/project-memory.md).

## Reproduction

Commit Environment recipes and locks:

```bash
git add .harness/environments .harness/locks
git commit -m "Define Agent environments"
```

On another machine:

```bash
git pull
harness sync -n research
harness doctor -n research
harness activate research
```

`sync` restores exact locked package snapshots into the content-addressed cache and rejects source drift. Manifests declare environment-variable names but never credential values.

## Commands

| Command | Purpose |
| --- | --- |
| `harness env create [name]` | Create an empty Environment; defaults to `base` |
| `harness env list` | List Environments and mark the active one |
| `harness env show <name>` | Show roots, resolved packages, and targets |
| `harness env remove <name>` | Remove an inactive Environment |
| `harness install [-n <env>] <source>` | Install a Package and recursive dependencies; defaults to active, then `base` |
| `harness activate [env]` | Atomically activate or switch an Environment; defaults to `base` |
| `harness deactivate` | Deactivate the complete active Environment |
| `harness current` | Show the active Environment and package closure |
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
