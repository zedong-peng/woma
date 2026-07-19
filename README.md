# harness-conda

Conda-style package and Environment management for Agent engineering tools.

Harness Conda packages Skills, meta-skills, MCP servers, and hooks into reusable Environments. Package contents and Environment locks are stored globally; repository-specific knowledge stays in Project Memory.

> Status: early development. The package is not published to the npm Registry.

## Highlights

- Global, content-addressed Package storage.
- Named Environments with independent roots, dependency closures, locks, and Agent targets.
- An implicit, non-removable `base` Environment.
- `harness-project-memory` and `meta-skill-builder` in every Environment.
- Recursive Package dependencies for installable meta-skills.
- Global per-Environment Codex and Claude Code views built from Store symlinks.
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

`base` is created automatically on first use:

```bash
harness env list
harness install builtin:auto-research
harness activate
codex
```

Create and use a named Environment:

```bash
harness env create performance --target codex
harness install -n performance builtin:performance-engineering
harness activate performance
codex
```

`harness deactivate` returns the current shell to `base`. Every Environment includes the Project Memory manager and meta-skill authoring assistant.

## Model

```text
~/.harness-conda/
├── packages/                    immutable, content-addressed Package contents
├── runtime/                     shared Agent authentication and session state
├── locks/                       cross-process Environment and project locks
└── environments/<name>/
    ├── environment.yaml         root Packages and Agent targets
    ├── lock.json                exact recursive dependency closure
    └── view/
        ├── codex/               Codex Skills, MCP, Hooks, and shared-state links
        └── claude/              Claude Skills, MCP, Hooks, and shared-state links

<project>/.harness/
├── memory/                      portable project and Package knowledge
└── local/                       machine-local Memory
```

Each Skill in a view is a symbolic link into the immutable Package Store. Installing into an Environment transactionally refreshes the managed paths in that one global view, so every project and new Agent process using the Environment observes the same dependency closure:

```text
project/shell -> Environment view -> Package Store
```

The shell hook exports an Environment view only for targets that Environment supports and restores the original Agent home for unsupported targets. Authentication, logs, and session directories use stable links through the shared runtime root; existing state is adopted from the user's original Agent configuration root. Project Memory remains local to the repository. Restart an already-running Agent after changing its Environment because Agent CLIs normally discover Skills at process startup.

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
