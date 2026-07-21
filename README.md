# harness-conda

Conda-style package and Environment management for Agent engineering tools.

Harness Conda packages Skills, MCP servers, hooks, and dependency-based methods into reusable Environments. Package contents and Environment locks are stored globally; repository-specific knowledge stays in Project Memory.

> Status: early development. The package is not published to the npm Registry.

## Highlights

- Global, content-addressed Package storage.
- Named Environments with independent roots, dependency closures, locks, and Agent targets.
- An implicit, non-removable `base` Environment.
- Explicit migration of existing Codex and Claude Skills into the selected Environment.
- `harness-project-memory` and `harness-package-builder` in every Environment.
- Recursive Package dependencies for reusable capability sets and end-to-end methods.
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

`harness deactivate` returns the current shell to `base`. Every Environment includes the Project Memory manager and the general Harness Package authoring assistant.

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
├── locks/                       cross-process Environment, Package, and project locks
└── environments/<name>/
    ├── environment.yaml         root Packages and Agent targets
    ├── lock.json                exact recursive dependency closure
    ├── home/
    │   ├── codex/               stable, opaque Codex state and managed view links
    │   ├── claude/              stable, opaque Claude state and managed view links
    │   └── codex-system-skills/ stable Codex-managed system Skills
    ├── view -> .view.gen-<id>    atomic pointer to one complete generation
    └── .view.gen-<id>/
        ├── codex/               Harness-managed Codex Skills, MCP, and Hooks
        └── claude/              Harness-managed Claude Skills and Hooks

<project>/.harness/
├── memory/                      portable project and Package knowledge
└── local/                       machine-local Memory
```

Each ordinary Skill in a view is a symbolic link into a read-only Package Store entry. Installing into an Environment builds a complete immutable managed-resource generation and publishes it with one atomic `view` symlink replacement. Stable Agent homes link only Harness-owned entries through that pointer, so every project and new Agent process observes either the old or new dependency closure, never a path-by-path mixture:

```text
project/shell -> stable Environment Agent home -> Environment view -> Package Store
```

The shell hook exports the selected Environment's stable Agent home for supported targets and restores the original Agent home for unsupported targets. Authentication and provider configuration are Environment-specific: edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml` for Codex, and `$CLAUDE_CONFIG_DIR/settings.json` for Claude endpoint/API-key settings. Claude OAuth login uses `$CLAUDE_CONFIG_DIR/.credentials.json` when that file is created. Configuration files under the original `~/.codex` or `~/.claude` homes are first-use seeds. Environment initialization never imports or links existing session state. Run `harness migrate sessions --from codex|claude|both` to explicitly copy sessions and structurally merge JSONL history into the selected Environment as ordinary Agent-owned files; independent session IDs are combined, exact records are deduplicated, and the original home remains unchanged. The target Agent then maintains its own independent copy. Existing ordinary Skills likewise remain untouched until `harness migrate skills` explicitly snapshots them. Other Agent-created files stay opaque and isolated in the stable Environment home, and retired view generations are never scanned for legacy state. Project Memory remains local to the repository. Restart an already-running Agent after changing its Environment because Agent CLIs normally discover Skills at process startup.

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
