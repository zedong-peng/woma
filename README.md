# Woma

**Conda for AI coding agents.** Woma gives every agent setup a name, keeps setups isolated from each other, and lets anyone recreate one from a single file.

[中文说明](README.zh-CN.md)

An AI coding agent is a model plus a *harness*: the Skills it has, its plugins, and the MCP servers it can call. The harness decides what the agent can do, but today it lives in scattered folders like `~/.claude` and `~/.codex`. You can't give it a name, you can't keep two of them side by side, and you can't hand it to a colleague. Woma treats a harness the way Conda treats a Python environment.

Woma uses the Claude Code and Codex you already installed; it does not download or pin them.

```bash
npm install -g @x19-507/woma
woma init                      # shell integration for activate/deactivate; open a new shell afterwards

woma create -n research claude codex pdf@anthropics/skills
woma activate research
claude                         # or codex: same Skills, same MCP servers
```

## What you can do with it

### 1. Share the harness you assembled, like `requirements.txt`

You collected Skills from GitHub, the [skills.sh](https://skills.sh) directory, plugin marketplaces and your own folders, and you want others to have exactly the same setup.

```bash
woma export -n research -f environment.yaml        # readable, editable, commit it to your repo
```

```yaml
agents: [claude, codex]
packages:
  - pdf@anthropics/skills
  - skill-creator@anthropics/claude-plugins-official
  - gh:me/lab-skills/paper-search#v1.2
mcp_servers:
  github:
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env_vars: [GITHUB_TOKEN]       # only the variable name is recorded, never its value
```

A colleague runs `woma create -n research -f environment.yaml`. For a byte-for-byte copy (exact Git commits and content hashes), export the lock with `woma export --explicit -f woma.lock`. If some Skills exist only on your disk, `woma export --pack research.tgz` bundles them into one file.

### 2. Keep separate harnesses for separate work

Writing a paper and shipping code call for different Skills and tools. Each environment has its own Skills, plugins, MCP servers, sign-in and history.

```bash
woma create -n paper claude pdf@anthropics/skills docx@anthropics/skills
woma create -n dev   claude codex ./my-team-skills
woma activate paper    # switch like conda activate
woma run -n dev codex  # or run one command without switching
```

Changing one environment never touches another. Every environment runs the `claude` and `codex` on your PATH; upgrade them the way you installed them (for example `claude update` or `npm install -g @openai/codex`).

### 3. Give Claude Code and Codex the same Skills

One environment can hold both agents. Install a Skill or an MCP server once and both agents get it.

```bash
woma create -n research claude codex
woma install -n research yeet@openai/skills ./skills-from-everywhere
woma mcp add -n research fetch -- uvx mcp-server-fetch
```

Native plugins stay with the agent they were built for: a Claude Code plugin goes only to Claude Code, a Codex plugin only to Codex.

### 4. Know exactly which harness produced a result

When you compare agents or run experiments, the harness is part of the experimental setup. `woma.lock` records the commit and content hash of every Skill and plugin, and the MCP configuration, so a result can be tied to one exact harness and rerun later. `woma list` shows which Claude Code and Codex versions the environment is running with.

## Installing Skills: packages with versions

Woma handles Skills the way Conda handles packages. Each one has a source and a version, and it is locked to an exact commit and content hash.

| Conda | Woma |
| --- | --- |
| `conda install numpy` | `woma install pdf@anthropics/skills` (a Skill or plugin by name) |
| `conda install numpy=1.26` | `woma install pdf@anthropics/skills#v1.0` (branch, tag or commit) |
| a package from a channel | `woma install gh:owner/repo/path/to/skill#main` |
| | `woma install https://github.com/owner/repo/tree/main/skills/x` (paste a browser URL) |
| a local package | `woma install ./my-skill` or `./folder-of-skills` |
| `conda search` | `woma search pdf` (searches [skills.sh](https://skills.sh)) |
| `conda update numpy` | `woma update pdf` |
| `conda list` | `woma list` |
| `environment.yml` | `woma export -f environment.yaml` |
| `conda list --explicit` | `woma export --explicit -f woma.lock` |
| `conda-pack` | `woma export --pack env.tgz` |

`NAME@owner/repo` finds `NAME` in, in order: the repository's Claude Code plugin marketplace (`.claude-plugin/marketplace.json`, e.g. [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)), its Codex plugin marketplace (`.agents/plugins/marketplace.json`), then any `SKILL.md` whose name matches (e.g. [anthropics/skills](https://github.com/anthropics/skills), [openai/skills](https://github.com/openai/skills)).

If you install a local folder that is a clean checkout of a commit you have already pushed, Woma notices. Exports then point to that GitHub commit instead of a path on your machine.

## Sign-in and secrets

Each environment keeps its own sign-in, and Woma never copies or links credential files. To sign in once and use it in every environment, export a token in your shell profile:

- **Claude Code:** `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
- **Codex:** run `codex login` once per environment, or `printenv OPENAI_API_KEY | codex login --with-api-key`.

`woma doctor` shows how each agent will authenticate. MCP secrets work the same way: `env_vars` and `bearer_token_env_var` name variables that are read from your shell when the server starts, and their values are never stored.

## How it works

```text
~/.woma/
  store/v2/<sha256>/          immutable, content-addressed Skills and plugins
  environments/research/
    home/claude/              CLAUDE_CONFIG_DIR: Skills, plugins, MCP, plus your own sign-in and sessions
    home/codex/               CODEX_HOME
    .woma/state.json          the lock and the list of files Woma owns
```

- **Your agents, your versions.** Woma uses the `claude` and `codex` on your PATH and never downloads, pins or wraps them. Activating an environment only sets `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so the agents you already have read that environment's Skills, plugins, MCP servers and sign-in.
- **Native formats.** Skills are copied into each agent's native `skills/` directory. Plugins and MCP servers are registered with small, targeted edits to `config.toml`, `settings.json` and `.claude.json`. Your comments and other settings are preserved.
- **Safe changes.** Every change is staged, checked against concurrent edits, and rolled back if it fails. `woma doctor` reports edited managed files and MCP entries changed outside Woma.
- **Nothing implicit.** No default environment, no auto-activation, no importing of your existing `~/.claude` or `~/.codex`.

## Requirements

- Claude Code and/or Codex, installed the usual way and on your PATH
- Node.js 20.19+, 22.13+ or 24+
- Git
- Bash or Zsh on macOS or Linux

Plugins need Claude Code 2.1.269+ or Codex 0.154.0+.

## Roadmap

- **Harbor evaluations.** Hand an environment to [Harbor](https://github.com/harbor-framework/harbor) so the same benchmark can be run against different harnesses.
- More agents (OpenCode, Gemini CLI).
- Automatic import of an existing `~/.claude` or `~/.codex` into a new environment.

## Learn more

[Commands](docs/commands.md) · [Environment and package files](docs/manifest.md) · [Design](docs/design.md) · [Native adapters](docs/agent-adapters.md) · [What Woma owns](docs/agent-harness-behavior.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Development

```bash
npm ci
npm test                         # unit tests, offline
WOMA_LIVE_TESTS=1 npm run test:live   # downloads official Claude Code and Codex releases
scripts/demo.sh                  # end-to-end tour in a temporary WOMA_HOME
```

## License

[MIT](LICENSE)
