# harness-conda

Conda-style Environment and Package management for Codex, Claude Code, Pi, and Qoder CLI.

> [!NOTE]
> **This project is in early development and is not published to the npm Registry.**

## Features

- **Named Environments** for Codex, Claude Code, Pi, Qoder CLI, or any combination.
- **Reusable Packages** containing Skills, MCP servers, hooks, and dependencies.
- **Direct Skill installation** from standalone and conventional multi-Skill sources.
- **Immediate Environment-local Skill discovery** alongside explicit migration into reusable Packages.
- **Portable Environment bundles** for moving complete Package closures between machines.
- **Project Memory** and Package authoring tools in every Environment.

## Requirements

- **Node.js 20 or newer**
- Codex, Claude Code, Pi, and/or Qoder CLI
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

Use `claude` instead of `codex` to start Claude Code. Pi and Qoder are opt-in because the existing `base` compatibility default targets Codex and Claude; create their Environments explicitly:

```bash
harness create --name pi-work --target pi
harness activate pi-work
pi

harness create --name qoder-work --target qoder
harness activate qoder-work
qodercli
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
harness create --name performance --target codex
harness install --name performance builtin:performance-engineering
harness list --name performance
harness remove --name performance performance-engineering --dry-run
harness remove --name performance performance-engineering
harness run --name performance codex

harness rename --name performance performance-v2
harness env remove performance-v2
```

**Activate the intended Environment before starting or resuming an Agent session.** Start a new Codex, Claude, Pi, or Qoder process after switching Environments or installing Packages.

## Manage Packages

```bash
harness install ./downloaded-skill
harness install gh:owner/skill-repository#v1.0.0
harness install ./ResearchStudio/ResearchStudio-Idea
harness remove downloaded-skill
```

`remove` removes one root Package, preserves dependencies still needed by other roots, and prunes dependencies that become unreachable. `uninstall` remains an alias. Neither command deletes immutable Package Store entries. Use `--name <environment>` to select an inactive Environment and `--dry-run` to preview the complete resource impact.

## Configure Agents

- **Codex:** edit `$CODEX_HOME/auth.json` and `$CODEX_HOME/config.toml`. Codex owns `$CODEX_HOME/skills/.system`; Harness never adopts it. An ordinary Skill added to `$CODEX_HOME/skills` immediately belongs to that Environment and appears in `harness list` as `external`, without another Harness command.
- **Claude Code:** edit `$CLAUDE_CONFIG_DIR/settings.json`; OAuth login may create `$CLAUDE_CONFIG_DIR/.credentials.json`.
- **Pi:** use `/login`, `/model`, or files under `$PI_CODING_AGENT_DIR`. Harness manages only `$PI_CODING_AGENT_DIR/skills`; Pi owns every other file in that Environment home.
- **Qoder CLI:** log in through `qodercli` in the activated Environment. Harness manages `$QODER_CONFIG_DIR/settings.json` (Package MCP servers and Hooks) and `$QODER_CONFIG_DIR/skills`; Qoder owns every other file in that Environment home. A new Qoder Environment does not copy the original `~/.qoder` state.

Environment selection belongs to the current shell. Separate shells can select and run different Environments at the same time; their Agent homes, credentials, provider configuration, sessions, and Codex system Skills remain isolated. Secret values stay in Agent configuration or shell environment variables and are never written to Package manifests, locks, or Environment bundles.

## Export and Recreate

```bash
# Source machine
harness export --name performance --file performance.harness-env

# Destination machine
harness create --name performance --file performance.harness-env
harness run --name performance codex
```

## Inspect and Repair

```bash
harness info
harness env list
harness list --name base
harness doctor --name base
harness inspect builtin:auto-research
```

`harness env list` shows registered Environment names and marks the one selected by the current shell; it does not perform a health check. Use `harness doctor --name <environment>` to validate an Environment.

`harness list` and `harness info --json` inspect ordinary Environment-local Skills directly from the selected Codex home. They do not copy those external Skills into the Package Store, recipe, lock, or bundle. Install a Skill through `harness install` only when it should become a reusable, locked Harness Package. Hidden entries, including `.system`, remain private Codex state, and Environment-local Skills never cross Environment boundaries.

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
