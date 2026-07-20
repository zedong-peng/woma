# Harness package manifest

`harness.yaml` describes one reusable Package. A Package may provide any combination of Skills, MCP servers, hooks, requirements, dependencies, and user-facing Skill entrypoints. It contains no credential values and no project-specific build commands.

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

## Dependencies and coordinating Skills

`dependencies` declares other Harness packages required by this package. Installation recursively resolves dependencies before their parent, validates package identity and SemVer constraints, rejects cycles and conflicting resolutions, and writes the complete dependency closure to the global Environment lock atomically.

Until a registry provides package-name resolution, every dependency includes a `source`. It accepts the same sources as `harness install`: built-ins, local paths, GitHub shorthand, HTTPS Git, and SSH Git. A relative local source is resolved from the directory containing the parent package:

```yaml
dependencies:
  - name: paper-search
    version: ^1.0.0
    source: ../paper-search
```

Local sources are useful during development but are not portable across machines. For security, packages installed from Git or the built-in catalog cannot declare local dependency sources; their dependencies must also use Git or built-in sources. Published packages should use immutable Git tags or revisions until registry-backed resolution is available.

`entrypoints` identifies a Package's user-facing starting Skills. It does not define workflow steps or create a DAG. When a Package teaches an end-to-end method, an ordinary coordinating Skill keeps its ordering, branching rules, interruption behavior, and expected output in `SKILL.md`; Harness Conda only manages the Packages needed to make that method available.

For example, an `auto-research` Package can expose one coordinating `auto-research` Skill while depending on independently versioned `paper-search`, `idea-gen`, and `exp-design` Packages. Installing `auto-research` installs and locks all four Packages:

```bash
harness install ./auto-research
```

The same component Packages can still be installed individually or composed into another ordinary Package by the `harness-package-builder` Agent Skill. A dependency-only aggregation Package may omit Skills and entrypoints entirely. These are structural variations of one Package model, not separate Package types.

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

| Package resource | Codex Environment view | Claude Code Environment view |
| --- | --- | --- |
| Skill | `view/codex/skills/<name>` symlink | `view/claude/skills/<name>` symlink |
| MCP server | managed block in `view/codex/config.toml` | entry in `home/claude/.claude.json` |
| Hook | entry in `view/codex/hooks.json` | entry in `view/claude/settings.json` |

`~/.harness-conda/environments/<environment>/lock.json` records source, resolved revision, content integrity, cache key, and dependency names for every package in a global Environment's resolved closure. The active Environment belongs to the current shell and is selected by `HARNESS_ENV`; no Environment state is stored in a project.

## Requirements

`commands` declares executable names that must exist on the machine. `env` declares environment variable names but never their values.

Repository-specific build, test, benchmark, and operational knowledge does not belong in a portable package manifest. Harness Agent Adapters expose natural-language [Project Memory](project-memory.md) before a Skill is selected, so third-party package contents do not need Harness-specific discovery instructions. Harness manages the storage boundary but does not interpret or execute that context.
