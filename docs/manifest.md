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
  platforms: [codex, claude, pi, qoder]
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

Implicit Packages contain Skills only and support Codex, Claude, Pi, and Qoder. Harness does not infer dependencies, entrypoints, MCP servers, Hooks, requirements, or workflow semantics from Skill prose. The root manifest always takes precedence when present, including over raw Skill layouts. Nested discovery is forbidden, so a repository containing multiple Package directories must be installed one Package directory at a time.

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

| Package resource | Codex Environment view | Claude Code Environment view | Pi Environment view | Qoder Environment view |
| --- | --- | --- | --- | --- |
| Skill | `home/codex/skills/<name>` | `home/claude/skills/<name>` | `home/pi/skills/<name>` | `home/qoder/skills/<name>` |
| MCP server | managed block in `view/codex/config.toml` | entry in `home/claude/.claude.json` | unsupported | entry in `view/qoder/settings.json` |
| Hook | entry in `view/codex/hooks.json` | entry in `view/claude/settings.json` | unsupported | entry in `view/qoder/settings.json` |

All four Agent Skill paths resolve to the Environment's real `home/skills` directory. Harness-managed entries there link through the atomic `view/skills/<name>` projection; ordinary entries written through any target path are immediately visible through the other target paths. Pi currently consumes Harness Skills through its Agent Skills support. A Package that includes Pi in `spec.platforms` must restrict every MCP server and Hook to supported platforms such as `platforms: [codex, claude]`; validation rejects resources that target Pi. Qoder supports Skills, MCP servers, and Hooks through its Claude-compatible `settings.json`; Harness does not capture, migrate, or seed Qoder credentials or sessions. Omitting `spec.platforms` retains the compatibility default `[codex, claude]`.

Codex owns the hidden `home/skills/.system` entry as mutable per-Environment state. It is not a Package Skill and is excluded from Environment-local Skill inventory, Package Store entries, ownership metadata, locks, and bundles. A non-hidden ordinary Skill added beside `.system` through any target immediately belongs to that Environment with origin `external`; it becomes an immutable Package only when installed explicitly through `harness install`.

`~/.harness-conda/environments/<environment>/lock.json` records source, full Git commit, Git subdirectory, content integrity, cache key, and dependency names for every package in a global Environment's resolved closure. Git-only provenance fields are omitted for local and built-in Packages. Legacy locks containing `resolved` and `requestedRef` remain readable, but new locks do not write those fields. The active Environment belongs to the current shell and is selected by `HARNESS_ENV`; no Environment state is stored in a project.

## Requirements

`commands` declares executable names that must exist on the machine. `env` declares environment variable names but never their values.

Repository-specific build, test, benchmark, and operational knowledge does not belong in a portable package manifest. A project may keep that context in optional [Project Memory](project-memory.md), but Harness never injects it before a Skill is selected. Third-party Packages remain portable and do not need Harness-specific discovery instructions. Harness exposes stable path conventions without interpreting or executing that context.
