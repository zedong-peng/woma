# Woma

Conda-style Environment and Package management for Codex, Claude Code, Pi, and Qoder CLI.

> [!NOTE]
> **This project is in early development and is not published to the npm Registry.**

> [!IMPORTANT]
> Woma is a breaking rename. Existing installations and project metadata must be recreated with the Woma names; the prior command, paths, environment variables, manifests, bundles, and built-in Package names are intentionally unsupported.

## Features

- **Named Environments** for Codex, Claude Code, Pi, Qoder CLI, or any combination.
- **Reusable Packages** containing Skills, MCP servers, hooks, and dependencies.
- **Direct Skill installation** from standalone and conventional multi-Skill sources.
- **Immediate cross-Agent Skill sharing** inside each Environment alongside explicit migration into reusable Packages.
- **Portable Environment bundles** for moving complete Package closures between machines.
- **Empty-by-default Environments** that contain only explicitly installed capabilities.

## Requirements

- **Node.js 20 or newer**
- Codex, Claude Code, Pi, and/or Qoder CLI
- Bash or Zsh for shell activation

## Installation

```bash
git clone https://github.com/zedong-peng/woma.git
cd woma
npm ci
npm run build
npm link
woma --version
```

After installation, initialize Woma for your current shell:

```bash
woma init
```

Like `conda init`, this installs a managed block in `~/.bashrc`, `~/.bash_profile`, or `~/.zshrc`. The block sources a static hook from `$WOMA_HOME/shell`, so ordinary shell startup does not launch Node. It does not create, validate, synchronize, or repair `base`, and it does not acquire Woma locks. Use `woma init --reverse` to remove the integration.

Open a new shell or reload the startup file.

## Quick Start

The `base` Environment is created automatically:

```bash
woma env list
woma install builtin:auto-research
woma activate base
codex
```

Project Memory is an optional ordinary Package rather than a Woma runtime feature. Install it explicitly when a project needs durable build, test, coding, or operational context:

```bash
woma install builtin:woma-project-memory
```

The Skill reads project-owned `.woma/memory.md` only for relevant work and writes it only on an explicit request. Woma never installs or invokes it automatically and never uses it to modify Agent-native memory, `AGENTS.md`, or `CLAUDE.md`.

Use `claude` instead of `codex` to start Claude Code. Pi and Qoder are opt-in because the existing `base` compatibility default targets Codex and Claude; create their Environments explicitly:

```bash
woma create --name pi-work --target pi
woma activate pi-work
pi

woma create --name qoder-work --target qoder
woma activate qoder-work
qodercli
```

### Migrate Existing State

> [!IMPORTANT]
> **Stop all Codex and Claude processes before every migration, including dry runs.**

If Woma detects a running Agent process for the current user, it lists the process and requires an interactive `yes` confirmation. Non-interactive migration stops with an error.

If the first implicit `base` creation detects known existing Codex or Claude Skill/session locations, Woma prints a one-time notice to stderr. The check reads filesystem metadata only: it does not enumerate names, read contents, or import anything. Original Agent homes remain unchanged, while supported provider configuration and Claude credentials continue to seed separately. Woma never reads or copies the original Codex `auth.json` into a new Environment.

This follows Conda's conservative model: discovering compatible existing state does not adopt it. Just as Conda does not silently turn an arbitrary Python or `venv` installation into a Conda Environment, Woma does not turn an existing Agent home into a Woma Environment.

**Run a dry run first, then repeat without `--dry-run`:**

```bash
woma migrate skills --from both --name base --dry-run
woma migrate skills --from both --name base

woma migrate sessions --from both --name base --dry-run
woma migrate sessions --from both --name base
```

Use `--from codex` or `--from claude` to migrate one Agent only. Use `--name <environment>` to select another destination.

## Manage Environments

Create, inspect, activate, and remove an Environment:

```bash
woma create --name performance --target codex
woma install --name performance builtin:performance-engineering
woma list --name performance
woma remove --name performance performance-engineering --dry-run
woma remove --name performance performance-engineering
woma run --name performance codex

woma rename --name performance performance-v2
woma env remove performance-v2
```

**Activate the intended Environment before starting or resuming an Agent session.** Start a new Codex, Claude, Pi, or Qoder process after switching Environments or installing Packages.

## Manage Packages

```bash
woma install ./downloaded-skill
woma install gh:owner/skill-repository#v1.0.0
woma install ./ResearchStudio/ResearchStudio-Idea
woma remove downloaded-skill
```

`remove` removes one root Package, preserves dependencies still needed by other roots, and prunes dependencies that become unreachable. `uninstall` remains an alias. Neither command deletes immutable Package Store entries. Use `--name <environment>` to select an inactive Environment and `--dry-run` to preview the complete resource impact.

## Configure Agents

Every target Agent's `skills` path resolves to one stable Environment-level directory. An ordinary Skill installed through Codex, Claude Code, Pi, or Qoder CLI is therefore immediately visible to every other target in the same Environment without `woma sync`. It remains isolated from other Environments and appears in `woma list` as `external`.

- **Codex:** log in separately after creating an Environment, and edit `$CODEX_HOME/config.toml` for its provider configuration. Codex owns the ordinary `$CODEX_HOME/auth.json`; Woma does not seed it from the original home or include it in managed views. Codex also owns the hidden `$CODEX_HOME/skills/.system` entry, which Woma preserves as opaque Environment state and never adopts as an ordinary Skill.
- **Claude Code:** edit `$CLAUDE_CONFIG_DIR/settings.json`; OAuth login may create `$CLAUDE_CONFIG_DIR/.credentials.json`.
- **Pi:** use `/login`, `/model`, or files under `$PI_CODING_AGENT_DIR`. Woma links `$PI_CODING_AGENT_DIR/skills` to the shared Environment Skill directory; Pi owns every other file in that Environment home.
- **Qoder CLI:** log in through `qodercli` in the activated Environment. Woma manages `$QODER_CONFIG_DIR/settings.json` (Package MCP servers and Hooks) and links `$QODER_CONFIG_DIR/skills` to the shared Environment Skill directory; Qoder owns every other file in that Environment home. A new Qoder Environment does not copy the original `~/.qoder` state.

Environment selection belongs to the current shell. Separate shells can select and run different Environments at the same time; their Agent homes, credentials, provider configuration, sessions, and Codex system Skills remain isolated. Secret values stay in Agent configuration or shell environment variables and are never written to Package manifests, locks, or Environment bundles.

Woma core manages capabilities and isolated Agent Environments, not Agent Memory or project context. It does not inject discovery instructions or read, write, package, or delete Memory data. The optional Project Memory Skill operates on its documented project-owned file only when selected; Agents and users otherwise choose how context is loaded and persisted.

## Export and Recreate

```bash
# Source machine
woma export --name performance --file performance.woma-env

# Destination machine
woma create --name performance --file performance.woma-env
woma run --name performance codex
```

## Inspect and Repair

```bash
woma info
woma env list
woma list --name base
woma doctor --name base
woma inspect builtin:auto-research
```

`woma env list` shows registered Environment names and marks the one selected by the current shell; it does not perform a health check. Use `woma doctor --name <environment>` to validate an Environment.

`woma info` reports the native `codex`, `claude`, `pi`, and `qodercli` executables available on the current `PATH`. `woma doctor` checks only the selected Environment's targets and warns when a target CLI is unavailable without treating the portable Environment itself as corrupt.

`woma list` and `woma info --json` inspect ordinary Environment-local Skills directly from the shared Skill directory and report every target that can use them. They do not copy those external Skills into the Package Store, recipe, lock, or bundle. Install a Skill through `woma install` only when it should become a reusable, locked Woma Package. Hidden entries, including `.system`, remain opaque Agent-owned state, and Environment-local Skills never cross Environment boundaries.

## Author Packages

Generate an editable Package recipe with a coordinating Skill:

```bash
woma skeleton workflow research-review --output-dir ./packages --version 0.1.0
woma inspect ./packages/research-review
```

The provider-oriented `skeleton` interface follows `conda skeleton` while adding the Woma-specific `workflow` recipe type. For richer Package composition and updates, install the optional Package Builder in the intended Environment:

```bash
woma install builtin:woma-package-builder
```

## Documentation

- [Command reference](docs/commands.md)
- [Architecture and isolation model](docs/design.md)
- [Agent Harness behavior reference](docs/agent-harness-behavior.md)
- [Package manifest](docs/manifest.md)
- [Optional Project Memory](docs/project-memory.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
npm run check
npm test
bash scripts/demo.sh
```
