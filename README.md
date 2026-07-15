# harness-conda

Install a domain Agent environment once, reproduce it across Codex and Claude Code.

`harness-conda` packages Skills, MCP servers, Claude Code hooks, command dependencies, and environment-variable requirements in one versioned `harness.yaml`. Packages can live in any Git repository; the CLI resolves them into a content-addressed cache, writes a lock file, and safely merges their configuration into a target project.

## Quick start

```bash
npm install
npm run build
npm link

mkdir /tmp/harness-demo
harness --project /tmp/harness-demo use ./examples/performance-engineering --target both
harness --project /tmp/harness-demo doctor performance-engineering
```

This creates the same Skill in `.agents/skills/` for Codex and `.claude/skills/` for Claude Code. It also merges target-specific MCP and hook configuration without replacing existing files.

Install directly from GitHub:

```bash
harness install gh:owner/performance-harness#v1.0.0
harness activate performance-harness --target codex
```

## Commands

| Command | Outcome |
| --- | --- |
| `harness init <dir>` | Scaffold a package with a portable Skill |
| `harness capture <dir> --from codex` | Export an existing project as a secret-safe package |
| `harness install <source>` | Validate, cache, hash, and lock a local or Git package |
| `harness activate [name]` | Merge a locked package into Codex, Claude, or both |
| `harness use <source>` | Install and activate in one command |
| `harness doctor [name]` | Check dependencies, env, integrity, activation, and drift |
| `harness deactivate <name>` | Remove unchanged artifacts owned by the package |
| `harness list` | Show installed and active packages |
| `harness inspect <source-or-name>` | Review package contents before activation |

All project commands accept `--project <directory>`. Activation and deactivation accept `--dry-run`.

## Manifest

```yaml
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: repository-research
  version: 0.1.0
  description: Search and analyze repositories with a repeatable evidence workflow.
  tags: [research]
spec:
  platforms: [codex, claude]
  requirements:
    env:
      - name: GITHUB_TOKEN
        description: GitHub API access for private repositories.
        optional: false
    commands: [git, node]
  skills:
    - name: repository-research
      path: ./skills/repository-research
  mcpServers:
    - name: github
      transport: stdio
      command: npx
      args: [-y, "@modelcontextprotocol/server-github"]
      env: [GITHUB_TOKEN]
  hooks:
    - event: PostToolUse
      matcher: Edit|Write
      command: git diff --check
      timeout: 10
```

Remote MCP headers map header names to environment variable names. Secret values never belong in the manifest:

```yaml
mcpServers:
  - name: internal-docs
    transport: http
    url: https://mcp.example.com/mcp
    headers:
      Authorization: INTERNAL_MCP_AUTHORIZATION
```

## Target mapping

| Package resource | Codex project | Claude Code project |
| --- | --- | --- |
| Skill | `.agents/skills/<name>` | `.claude/skills/<name>` |
| MCP server | managed block in `.codex/config.toml` | entry in `.mcp.json` |
| Hook | not installed | entry in `.claude/settings.json` |

The CLI adopts identical existing entries but does not claim ownership of them. A conflicting entry stops activation. Managed Skill directories are removed only while their content hash still matches the activated package; modified content is retained.

The adapters follow the official [Codex Skills](https://developers.openai.com/codex/skills/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code Skills](https://code.claude.com/docs/en/skills), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [Claude Code Hooks](https://code.claude.com/docs/en/hooks) configuration contracts.

## Package sources and lock

Sources may be local directories, `gh:owner/repo#ref`, HTTPS Git URLs, or SSH Git URLs. `.harness/lock.json` records source, resolved commit, content integrity, and cache key. The cache defaults to `~/.harness-conda` and can be relocated with `HARNESS_HOME`.

For repeatable team use, commit `.harness/lock.json` and pin a tag or commit. `.harness/state.json` is machine-local ownership state and is ignored by Git.

## Development

```bash
npm run check
npm test
bash scripts/demo.sh
```

See [the Chinese product brief](docs/product-brief.zh-CN.md) for positioning, cold start, moat, and commercialization assumptions. Read [SECURITY.md](SECURITY.md) before activating third-party packages.
