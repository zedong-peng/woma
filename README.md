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
- Atomic activation, switching, and active-Environment installation with rollback on ordinary errors.
- Native Codex and Claude Code project integration. After activation, run `codex` or `claude` directly.

## Install

```bash
git clone https://github.com/zedong-peng/harness-conda.git
cd harness-conda
npm ci
npm run build
npm link
harness --version
```

Optional bash/zsh prompt integration:

```bash
eval "$(harness shell hook)"
```

Add the line to `~/.bashrc` or `~/.zshrc` to enable it in future shells.

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

`harness deactivate` returns the project to `base`. Every Environment includes the Project Memory manager and meta-skill authoring assistant.

## Model

```text
~/.harness-conda/
├── packages/                    immutable Package contents
└── environments/<name>/
    ├── environment.yaml         root Packages and Agent targets
    └── lock.json                exact recursive dependency closure

<project>/.harness/
├── memory/                      portable project and Package knowledge
├── local/                       machine-local Memory
└── state.json                   project Adapter ownership
```

Activation materializes the selected Environment into the current project's native Agent locations:

```text
Codex:  .agents/skills/, .codex/, AGENTS.md
Claude: .claude/skills/, .mcp.json, CLAUDE.md
```

This means direct `codex` and `claude` launches work after activation. The current implementation globally shares Package contents and dependency locks, but still uses project-local materialized Agent views. A true global per-Environment Agent view, equivalent to a Conda prefix, remains future work.

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
