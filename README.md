# harness-conda

Conda-style package and Environment management for Agent engineering tools.

Harness Conda packages Skills, meta-skills, MCP servers, and hooks into reusable Environments. Package contents and Environment locks are stored globally; repository-specific knowledge stays in Project Memory.

> Status: early development. The package is not published to the npm Registry.

## Highlights

- Global, content-addressed Package storage.
- Named Environments with independent roots, dependency closures, locks, and Agent targets.
- An implicit, non-removable `base` Environment.
- Explicit migration of existing Codex and Claude Skills into the selected Environment.
- `harness-project-memory` and `meta-skill-builder` in every Environment.
- Recursive Package dependencies for installable meta-skills.
- Portable, deterministic Environment bundles for offline migration between machines.
- Atomically published per-Environment Codex and Claude Code views built from read-only Store symlinks.
- Atomic Environment view updates and installation rollback on ordinary errors.
- Direct `codex` and `claude` launches after shell activation; no Agent command proxy.

## Install

```bash
git clone https://github.com/zedong-peng/harness-conda.git
cd harness-conda
npm ci
npm run build
npm link
harness --version
```

Recommended: add the shell hook to `~/.bashrc` or `~/.zshrc`:

```bash
eval "$(harness shell hook)"
```

Open a new shell or reload the startup file. The hook selects the active global Agent view and shows it in the prompt, for example `(harness:base)` or `(harness:performance)`.

## Quick Start

`base` is created automatically on first use with only the foundational Packages:

```bash
harness env list
harness install builtin:auto-research
harness activate
codex
```

Existing ordinary Codex and Claude Skills remain untouched until the user explicitly migrates them into the active Environment:

```bash
harness migrate skills --dry-run
harness migrate skills
```

Create and use a named Environment:

```bash
harness env create performance --target codex
harness install -n performance builtin:performance-engineering
harness activate performance
codex
```

`harness deactivate` returns the current shell to `base`. Every Environment includes the Project Memory manager and meta-skill authoring assistant.

Move the complete Environment, including local `file:` Packages, to another machine without copying credentials or project state:

```bash
# Source machine
harness env export --name performance --output performance.harness-env

# Destination machine
harness env import performance.harness-env
harness activate performance
```

Use `--name performance-copy` during import to choose a different Environment name. Import refuses to overwrite an existing Environment.

## Model

```text
~/.harness-conda/
├── packages/                    immutable, content-addressed Package contents
├── migrations/                  content-addressed snapshots of explicitly migrated Skills
├── runtime/                     shared Agent system Skills, authentication, and sessions
├── locks/                       cross-process Environment, Package, runtime, and project locks
└── environments/<name>/
    ├── environment.yaml         root Packages and Agent targets
    ├── lock.json                exact recursive dependency closure
    ├── view -> .view.gen-<id>    atomic pointer to one complete generation
    └── .view.gen-<id>/
        ├── codex/               Codex Skills, MCP, Hooks, and shared-state links
        └── claude/              Claude Skills, MCP, Hooks, and shared-state links

<project>/.harness/
├── memory/                      portable project and Package knowledge
└── local/                       machine-local Memory
```

Each ordinary Skill in a view is a symbolic link into a read-only Package Store entry. Codex-managed `skills/.system` is instead linked through the shared runtime root so Codex can update its own system Skills without changing an Environment lock. Installing into an Environment builds a complete immutable view generation and publishes it with one atomic `view` symlink replacement, so every project and new Agent process observes either the old or new dependency closure, never a path-by-path mixture:

```text
project/shell -> Environment view -> Package Store
```

The shell hook exports an Environment view only for targets that Environment supports and restores the original Agent home for unsupported targets. Authentication, logs, sessions, and Codex system Skills use stable links through the shared runtime root; existing state is adopted from the user's original Agent configuration root. Ordinary existing Skills are never scanned during Environment initialization. `harness migrate skills` explicitly copies them into a content-addressed Package snapshot and atomically installs that Package into the selected Environment without modifying the originals. Project Memory remains local to the repository. Restart an already-running Agent after changing its Environment because Agent CLIs normally discover Skills at process startup.

## Documentation

- [Command reference](docs/commands.md)
- [Architecture and isolation model](docs/design.md)
- [Package manifest](docs/manifest.md)
- [Project Memory](docs/project-memory.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
npm run check
npm test
bash scripts/demo.sh
```

Node.js 20 or newer is required.
