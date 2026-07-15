# Harness package manifest

`harness.yaml` describes one reusable domain capability. It contains no credential values and no project-specific build commands.

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
    bindings:
      - name: test
        description: Project correctness command used by this workflow.
      - name: benchmark
        description: Repeatable project benchmark command.
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
      platforms: [codex, claude]
```

Remote MCP headers map HTTP header names to environment variable names:

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
| Hook | entry in `.codex/hooks.json` | entry in `.claude/settings.json` |

`.harness/lock.json` records source, resolved revision, content integrity, and cache key. `.harness/state.json` is machine-local ownership state and must not be committed.

## Requirements

`commands` declares executable names that must exist on the machine. `env` declares environment variable names but never their values. `bindings` declares project-level commands that the reusable workflow needs without hard-coding one repository's build system.

A required binding blocks profile activation before any files change. Configure it in `.harness/project.yaml` or with `harness bind <name> <command...>`. Set `optional: true` only when the workflow has a valid degraded path. `doctor` reports missing inactive-profile bindings as warnings and missing active-profile bindings as failures.
