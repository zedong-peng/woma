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

After installation, initialize Harness for your current shell:

```bash
harness init
```

Like `conda init`, this installs a managed block in `~/.bashrc`, `~/.bash_profile`, or `~/.zshrc`. The block sources a static hook from `$HARNESS_HOME/shell`, so ordinary shell startup does not launch Node. It does not create, validate, synchronize, or repair `base`, and it does not acquire Harness locks. Use `harness init --reverse` to remove the integration.

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

If the first implicit `base` creation detects known existing Codex or Claude Skill/session locations, Harness prints a one-time notice to stderr. The check reads filesystem metadata only: it does not enumerate names, read contents, or import anything. Original Agent homes remain unchanged, while supported credentials and provider configuration continue to seed separately.

This follows Conda's conservative model: discovering compatible existing state does not adopt it. Just as Conda does not silently turn an arbitrary Python or `venv` installation into a Conda Environment, Harness does not turn an existing Agent home into a Harness Environment.

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
harness uninstall --name performance performance-engineering --dry-run
harness uninstall --name performance performance-engineering
harness activate performance
codex

harness deactivate
harness env remove performance
```

**Activate the intended Environment before starting or resuming an Agent session.** Start a new Codex, Claude, or Pi process after switching Environments or installing Packages.

## Manage Packages

```bash
harness install ./downloaded-skill
harness install gh:owner/skill-repository#v1.0.0
harness install ./ResearchStudio/ResearchStudio-Idea
harness uninstall downloaded-skill
```

`uninstall` removes one root Package, preserves dependencies still needed by other roots, and prunes dependencies that become unreachable. It never deletes immutable Package Store entries. Use `--name <environment>` to select an inactive Environment and `--dry-run` to preview the complete resource impact.

## Configure Agents

- **Codex:** edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml`. Codex owns `$CODEX_HOME/skills/.system`; Harness reconciles only Package-managed ordinary Skill links in the surrounding stable `skills` directory.
- **Claude Code:** edit `$CLAUDE_CONFIG_DIR/settings.json`; OAuth login may create `$CLAUDE_CONFIG_DIR/.credentials.json`.
- **Pi:** use `/login`, `/model`, or files under `$PI_CODING_AGENT_DIR`. Harness manages only `$PI_CODING_AGENT_DIR/skills`; Pi owns every other file in that Environment home.

Environment selection belongs to the current shell. Separate shells can select and run different Environments at the same time; their Agent homes, credentials, provider configuration, sessions, and Codex system Skills remain isolated. Secret values stay in Agent configuration or shell environment variables and are never written to Package manifests, locks, or Environment bundles.

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

`harness env list` shows registered Environment names and marks the one selected by the current shell; it does not perform a health check. Use `harness doctor --name <environment>` to validate an Environment.

## Author Packages

Generate an editable Package recipe with a coordinating Skill:

```bash
harness skeleton workflow research-review --output-dir ./packages --version 0.1.0
harness inspect ./packages/research-review
```

The provider-oriented `skeleton` interface follows `conda skeleton` while adding the Harness-specific `workflow` recipe type. Use the foundational `harness-package-builder` Skill for richer Package composition and updates.

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
