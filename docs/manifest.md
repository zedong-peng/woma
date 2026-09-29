# Environment and Package Files

## Environment file (`environment.yaml`)

The environment file is the shareable, hand-editable description of a harness, like Conda's `environment.yml`. `woma export -f environment.yaml` writes it, and `woma create -n NAME -f environment.yaml` recreates the environment.

```yaml
agents: [claude, codex]     # at least one; Woma uses the installed agents and does not manage their versions
packages:                   # direct packages; dependencies are resolved automatically
  - pdf@anthropics/skills
  - gh:anthropics/skills/skills/docx#main
  - ./lab-skills            # relative to this file
  - name: review            # the long form pins the expected package name
    source: gh:me/review#v2.0.0
mcp_servers:
  github:
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env: { LOG_LEVEL: info }        # literal, non-secret values
    env_vars: [GITHUB_TOKEN]        # passed from the user's shell; the value is never stored
  docs:
    url: https://mcp.example.com/mcp
    bearer_token_env_var: DOCS_TOKEN
    agents: [codex]                 # optional: only for these agents
```

`format: woma.environment/v3` and `name` are optional; exports include them. A server has either `command` (stdio) or `url` (streamable HTTP). Woma writes each server into the native configuration of each agent:

| Field | Codex (`home/codex/config.toml`) | Claude Code (`home/claude/.claude.json`) |
| --- | --- | --- |
| `command`, `args`, `env` | `mcp_servers.NAME.{command,args,env}` | `mcpServers.NAME` with `type: stdio` |
| `env_vars` | `mcp_servers.NAME.env_vars` | not needed, because stdio servers inherit Claude Code's environment |
| `url` | `mcp_servers.NAME.url` | `mcpServers.NAME` with `type: http` |
| `bearer_token_env_var` | `mcp_servers.NAME.bearer_token_env_var` | header `Authorization: Bearer ${NAME}` |

An environment file records intent. Creating from it resolves floating refs (a branch, or no ref) at that moment, so two creations at different times can differ. For an exact copy, use the lock. Environment files written by Woma 0.7 (`harness:`/`runtime:`) are accepted; their agent version is ignored.

## Lock (`woma.lock`)

`woma export --explicit` writes JSON with `format: woma.lock/v3`, the environment file, and every package in the closure. For each package it records:

- name, version and kind
- source identity: a Git URL, commit and subdirectory, or a local path
- SHA-256 snapshot integrity
- dependency edges, agent constraints, and installation descriptors

Creating from a lock verifies every digest and never upgrades anything. A missing Git snapshot is fetched at its locked commit. A missing local snapshot is an error; share local-only packages with a pack. Locks do not depend on the operating system, and they do not record agent versions: the agents are whatever is installed where the environment is created. Locks written by Woma 0.7 (`woma.lock/v2`) are accepted; their pinned agent release is ignored.

## Pack (`.tgz`)

`woma export --pack FILE` writes a gzip tar containing `woma-pack.json` (the exact lock) and `store/<sha256>/` (every package snapshot). `woma create -f FILE` imports and verifies the snapshots.

## Packages

Woma recognizes native layouts and never rewrites upstream content.

```text
review/SKILL.md                    # one Skill, with companion files
toolkit/skills/*/SKILL.md          # a Skill collection
folder/*/SKILL.md                  # a directory of Skill directories
native/.claude-plugin/plugin.json  # a native Claude Code plugin
native/.codex-plugin/plugin.json   # a native Codex plugin
collection/woma.yaml               # dependencies only
```

Skills need YAML frontmatter with a `name` and a nonempty `description`. Skill, package and environment names use lowercase letters, digits, dots, underscores and hyphens, up to 80 characters. `claude` and `codex` are reserved.

Skills are installed for every agent in the environment that the package supports. A native plugin is installed only for its own agent and requires that agent in the environment. A plugin needs exactly one explicit harness manifest. Universal root `plugin.json`, dual manifests, and native dependency declarations are rejected because the adapters cannot lock them.

Package trees are complete snapshots except `.git`, `.woma` and `.DS_Store`. Symlinks and special files are rejected.

### Optional `woma.yaml`

```yaml
name: research
version: 1.0.0
harnesses:            # agents that may use this package; omit for both
  claude: '*'
  codex: '*'
dependencies:
  - name: review
    version: ^1.0.0
    source: ../review
```

These are the only fields. When `harnesses` is present, the package goes only to the listed agents. Version ranges are accepted but not checked, because Woma does not manage agent versions. Dependencies declare `name`, `source` and an optional semver range. Local relative dependencies resolve beside the declaring package; relative dependencies of Git packages stay in the same locked commit.

Before anything is published, installation fails on any of these: dependency cycles, source disagreements, name collisions, version mismatches, duplicate Skills, conflicting installation paths, or no usable agent. Installing another package keeps existing resolutions. `woma update NAME` re-resolves only that package's subtree.
