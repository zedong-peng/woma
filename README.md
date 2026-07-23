# harness-conda

Conda-style Environment and Package management for Codex, Claude Code, and Pi.

> [!NOTE]
> **This project is in early development and is not published to the npm Registry.**

## Features

- **Named Environments** for Codex, Claude Code, Pi, or any combination.
- **Reusable Packages** containing Skills, MCP servers, hooks, and dependencies.
- **Direct Skill installation** from standalone and conventional multi-Skill sources.
- **Explicit migration** of existing Skills and sessions.
- **Portable Environment bundles** for moving complete Package closures between machines.
- **Project Memory** and Package authoring tools in every Environment.

## Requirements

- **Node.js 20 or newer**
- Codex, Claude Code, and/or Pi
- Bash or Zsh for shell activation

## Installation

```bash
git clone https://github.com/zedong-peng/harness-conda.git
cd harness-conda
npm ci
npm run build
npm link
harness --version
```

**Add the shell hook** to `~/.bashrc` or `~/.zshrc`:

```bash
eval "$(harness shell hook)"
```

Open a new shell or reload the startup file.

## Quick Start

The `base` Environment is created automatically:

```bash
harness env list
harness install builtin:auto-research
harness activate base
codex
```

Use `claude` instead of `codex` to start Claude Code. Pi is opt-in because the existing `base` compatibility default targets Codex and Claude; create a Pi Environment explicitly:

```bash
harness env create pi-work --target pi
harness activate pi-work
pi
```

### Migrate Existing State

> [!IMPORTANT]
> **Stop all Codex and Claude processes before every migration, including dry runs.**

If Harness detects a running Agent process for the current user, it lists the process and requires an interactive `yes` confirmation. Non-interactive migration stops with an error.

**Run a dry run first, then repeat without `--dry-run`:**

```bash
harness migrate skills --from both --name base --dry-run
harness migrate skills --from both --name base

harness migrate sessions --from both --name base --dry-run
harness migrate sessions --from both --name base
```

Use `--from codex` or `--from claude` to migrate one Agent only. Use `--name <environment>` to select another destination.

## Manage Environments

Create, inspect, activate, and remove an Environment:

```bash
harness env create performance --target codex
harness install --name performance builtin:performance-engineering
harness list --name performance
harness activate performance
codex

harness deactivate
harness env remove performance
```

**Activate the intended Environment before starting or resuming an Agent session.** Start a new Codex, Claude, or Pi process after switching Environments or installing Packages.

## Install Skills

```bash
harness install ./downloaded-skill
harness install gh:owner/skill-repository#v1.0.0
harness install ./ResearchStudio/ResearchStudio-Idea
```

## Configure Agents

- **Codex:** edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml`.
- **Claude Code:** edit `$CLAUDE_CONFIG_DIR/settings.json`; OAuth login may create `$CLAUDE_CONFIG_DIR/.credentials.json`.
- **Pi:** use `/login`, `/model`, or files under `$PI_CODING_AGENT_DIR`. Harness manages only `$PI_CODING_AGENT_DIR/skills`; Pi owns every other file in that Environment home.

## Export and Import

```bash
# Source machine
harness env export --name performance --output performance.harness-env

# Destination machine
harness env import performance.harness-env
harness activate performance
```

Use `--name <new-environment>` during import to choose a different name.

## Inspect and Repair

```bash
harness info
harness env list
harness list --name base
harness doctor --name base
harness sync --name base
harness inspect builtin:auto-research
```

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
