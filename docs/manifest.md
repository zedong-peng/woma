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
  platforms: [codex, claude, pi]
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
      platforms: [codex, claude]
  hooks:
    - event: PostToolUse
      matcher: Edit|Write
      command: git diff --check
      timeout: 10
      platforms: [codex, claude]
```

## Implicit Skill Packages

Package authors use `harness.yaml`, but existing Skills do not need to add one before installation. When no root manifest exists, the Source Adapter accepts either one root `SKILL.md` or one conventional collection of direct `skills/*/SKILL.md` children. It generates the manifest only in temporary staging and then applies the same Package schema and validation shown in this document.

Implicit Packages contain Skills only and support Codex, Claude, and Pi. Harness does not infer dependencies, entrypoints, MCP servers, Hooks, requirements, or workflow semantics from Skill prose. The root manifest always takes precedence when present, including over raw Skill layouts. Nested discovery is forbidden, so a repository containing multiple Package directories must be installed one Package directory at a time.

The adapter derives a standalone Package name and description from Skill YAML frontmatter. For a multi-Skill source, it derives the Package name from the source directory or Git repository and includes every direct conventional Skill in deterministic directory-name order. Duplicate Skill names and malformed metadata are rejected. Local content or the resolved Git commit supplies an informational SemVer build version; the lock remains authoritative for source, exact resolution, normalized integrity, and cache identity.

## Dependencies and coordinating Skills

`dependencies` declares other Harness packages required by this package. Installation recursively resolves dependencies before their parent, validates package identity and SemVer constraints, rejects cycles and conflicting resolutions, and writes the complete dependency closure to the global Environment lock atomically.

Until a registry provides package-name resolution, every dependency includes a `source`. It accepts the same sources as `harness install`: built-ins, local paths, GitHub shorthand, HTTPS Git, and SSH Git. A relative local source is resolved from the directory containing the parent package:

```yaml
dependencies:
  - name: paper-search
    version: ^1.0.0
    source: ../paper-search
```

Local sources are useful during development but are not portable across machines. For security, packages installed from Git or the built-in catalog cannot declare local dependency sources; their dependencies must also use Git or built-in sources. Published packages should use immutable Git tags or commits until registry-backed resolution is available.

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

| Package resource | Codex Environment view | Claude Code Environment view | Pi Environment view |
| --- | --- | --- | --- |
| Skill | `home/codex/skills/<name>` link through `view/codex/skills/<name>` | `view/claude/skills/<name>` symlink | `view/pi/skills/<name>` symlink |
| MCP server | managed block in `view/codex/config.toml` | entry in `home/claude/.claude.json` | unsupported |
| Hook | entry in `view/codex/hooks.json` | entry in `view/claude/settings.json` | unsupported |

Pi currently consumes Harness Skills through its Agent Skills support. A Package that includes Pi in `spec.platforms` must restrict every MCP server and Hook to supported platforms such as `platforms: [codex, claude]`; validation rejects resources that target Pi. Omitting `spec.platforms` retains the compatibility default `[codex, claude]`.

Codex owns `home/codex/skills/.system` as mutable per-Environment runtime state. It is not a Package Skill and is excluded from Package Store entries, ownership metadata, locks, synchronization, and bundles. An ordinary Skill installed by Codex beside `.system` becomes an implicit, content-addressed single-Skill Package only when `harness sync` explicitly adopts it into that Environment.

`~/.harness-conda/environments/<environment>/lock.json` records source, full Git commit, Git subdirectory, content integrity, cache key, and dependency names for every package in a global Environment's resolved closure. Git-only provenance fields are omitted for local and built-in Packages. Legacy locks containing `resolved` and `requestedRef` remain readable, but new locks do not write those fields. The active Environment belongs to the current shell and is selected by `HARNESS_ENV`; no Environment state is stored in a project.

## Requirements

`commands` declares executable names that must exist on the machine. `env` declares environment variable names but never their values.

Repository-specific build, test, benchmark, and operational knowledge does not belong in a portable package manifest. Harness Agent Adapters expose natural-language [Project Memory](project-memory.md) before a Skill is selected, so third-party package contents do not need Harness-specific discovery instructions. Harness manages the storage boundary but does not interpret or execute that context.
