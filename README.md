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

## Quick start

```bash
harness env create research --target codex
harness install -n research builtin:auto-research
harness activate research

codex

harness deactivate
```

Installing `auto-research` recursively installs and locks its component packages. Activating `research` makes the complete dependency closure available to the selected Agent in dependency-first order.

Only one Environment is active in a project. Activating another Environment atomically removes packages unique to the old Environment, preserves identical shared packages, activates the new closure, and rolls back if the transition fails.

## Mental model

```text
Package
  = versioned distribution unit containing Skills, MCP, hooks, or scripts

Meta-Skill
  = ordinary Skill with a natural-language method and Package dependencies

Environment
  = root Packages + recursive dependency closure + targets + bindings + lock
```

Harness Conda does not decide what phase a task is in, advance workflow steps, require handoffs, or record outcomes. The user and Agent define and execute the method; Harness Conda installs, isolates, locks, activates, migrates, and shares it.

## Environments

```bash
harness env create cpp-performance --target codex
harness env list
harness env show cpp-performance
harness env remove cpp-performance
```

Environment state is project-local:

```text
.harness/
├── environments/
│   └── cpp-performance.yaml
├── locks/
│   └── cpp-performance.lock.json
└── state.json
```

The YAML recipe records user-selected root packages, Agent targets, and project bindings. The lock records the exact source, Git revision, integrity, cache key, and dependency edges for the full closure. `state.json` is machine-local activation ownership state.

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

## Project bindings

Reusable Skills can require abstract project commands such as `test` or `benchmark`. Bind them per Environment:

```bash
harness bind -n cpp-performance test "npm test"
harness bind -n cpp-performance benchmark "./scripts/benchmark.sh"
```

A missing required binding blocks activation before the current Environment changes. Harness Conda exposes the binding to the active method but does not decide when to execute it.

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
| `harness env create <name>` | Create an empty named Environment |
| `harness env list` | List Environments and mark the active one |
| `harness env show <name>` | Show roots, resolved packages, targets, and bindings |
| `harness env remove <name>` | Remove an inactive Environment |
| `harness install -n <env> <source>` | Install a Package and recursive dependencies |
| `harness bind -n <env> <name> <command...>` | Configure a project command for Skills |
| `harness activate <env>` | Atomically activate or switch an Environment |
| `harness deactivate` | Deactivate the complete active Environment |
| `harness current` | Show the active Environment and package closure |
| `harness sync [-n <env>]` | Restore exact locked packages |
| `harness doctor [-n <env>]` | Verify lock, requirements, bindings, and activation |
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
- Deactivation removes only unchanged resources owned by the Environment.
- Git and built-in packages cannot use local dependency paths to read installation-machine files.
- Captured MCP configuration contains environment-variable names, never literal secret values.

See [the package manifest reference](docs/manifest.md) for the complete package schema.
