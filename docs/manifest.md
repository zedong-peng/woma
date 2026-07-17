# Harness package manifest

`harness.yaml` describes one reusable domain capability. A package may expose an atomic Skill or a natural-language meta-skill that depends on other packages. It contains no credential values and no project-specific build commands.

```yaml
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: repository-research
  version: 0.1.0
  description: Search and analyze repositories with a repeatable evidence method.
  tags: [research]
spec:
  platforms: [codex, claude]
  dependencies:
    - name: paper-search
      version: ^1.0.0
      source: builtin:paper-search
    - name: idea-gen
      version: ^1.0.0
      source: builtin:idea-gen
  entrypoints:
    - name: research
      skill: repository-research
      description: Run the complete evidence-to-experiment research method.
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
      platforms: [codex, claude]
```

## Dependencies and meta-skills

`dependencies` declares other Harness packages required by this package. Installation recursively resolves dependencies before their parent, validates package identity and SemVer constraints, rejects cycles and conflicting resolutions, and writes the complete dependency closure to the project lock atomically.

Until a registry provides package-name resolution, every dependency includes a `source`. It accepts the same sources as `harness install`: built-ins, local paths, GitHub shorthand, HTTPS Git, and SSH Git. A relative local source is resolved from the directory containing the parent package:

```yaml
dependencies:
  - name: paper-search
    version: ^1.0.0
    source: ../paper-search
```

Local sources are useful during development but are not portable across machines. For security, packages installed from Git or the built-in catalog cannot declare local dependency sources; their dependencies must also use Git or built-in sources. Published packages should use immutable Git tags or revisions until registry-backed resolution is available.

`entrypoints` identifies the package's user-facing starting Skills. It does not define workflow steps or create a DAG. A meta-skill keeps its coordination method, branching rules, interruption behavior, and expected output in its ordinary `SKILL.md`; Harness Conda only manages the packages needed to make that method available.

For example, an `auto-research` package can expose one `auto-research` Skill while depending on independently versioned `paper-search`, `idea-gen`, and `exp-design` packages. Installing the meta-skill installs and locks all four packages:

```bash
harness install ./auto-research
```

The same component packages can still be installed individually and composed into another meta-skill by an Agent.

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

`.harness/locks/<environment>.lock.json` records source, resolved revision, content integrity, cache key, and dependency names for every package in an Environment's resolved closure. `.harness/state.json` is machine-local ownership state and must not be committed.

## Requirements

`commands` declares executable names that must exist on the machine. `env` declares environment variable names but never their values.

Repository-specific build, test, benchmark, and operational knowledge does not belong in a portable package manifest. Methods consume natural-language [Project Memory](project-memory.md), verify it against the current repository, and persist stable discoveries in shared or package-scoped memory. Harness manages the storage boundary but does not interpret or execute that context.
