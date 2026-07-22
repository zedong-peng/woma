# Harness Package authoring reference

Use this contract when creating or updating a Package. Omit empty optional sections instead of inventing resources or requirements. Harness has one Package type; the fields present describe what it provides.

## Directory layouts

A wrapped standalone Skill becomes self-contained:

```text
paper-search/
├── harness.yaml
└── skills/
    └── paper-search/
        ├── SKILL.md
        └── optional bundled resources
```

A Package may combine resource kinds:

```text
repository-tools/
├── harness.yaml
└── skills/
    └── repository-review/
        └── SKILL.md
```

Keep every declared path inside the Package root. Copy external resources rather than using escaping paths. Package validation rejects Skill-root and nested symbolic links.

## General manifest

```yaml
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: repository-tools
  version: 0.1.0
  description: Review repositories with optional GitHub tools and validation hooks.
  tags: [repository, review]
spec:
  platforms: [codex, claude, pi]
  dependencies: []
  entrypoints:
    - name: review
      skill: repository-review
      description: Review a repository and report actionable findings.
  requirements:
    env:
      - name: GITHUB_TOKEN
        description: GitHub access token for private repositories.
        optional: true
    commands: [git, node]
  skills:
    - name: repository-review
      path: ./skills/repository-review
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

Required invariants:

- Use lowercase Package, Skill, entrypoint, MCP, and dependency names containing only letters, digits, `.`, `_`, or `-`.
- Use valid SemVer for `metadata.version` and valid SemVer ranges for dependency versions.
- List each Agent target once. Resource-level platforms must be a subset of Package platforms. Pi currently supports Skills only, so every MCP server and Hook in a Pi-capable Package must explicitly exclude `pi`.
- Ensure every entrypoint references a Skill declared in `spec.skills`.
- Ensure every Skill path is inside the Package and contains a `SKILL.md` whose frontmatter name matches the manifest Skill name and whose description is non-empty.
- Declare executable names under `requirements.commands` and environment variable names under `requirements.env`.
- Map MCP environment and header fields to declared variable names. Never store secret values.
- Use commands relative to the Package only when the runtime can execute them from the required location; otherwise declare a stable executable requirement.
- Omit `entrypoints` when the Package has no user-facing Skill. Omit `skills` when the Package provides only MCP servers, hooks, requirements, or dependencies.

## Skill frontmatter

Every Skill uses only the required frontmatter fields:

```markdown
---
name: repository-review
description: Reviews a repository and reports prioritized findings. Use when the user requests an evidence-based code or design review.
---

# Repository review

State the reusable instructions and output contract.
```

Keep portable Skills independent of one repository's commands and paths. Put detailed reusable material in the Skill's `references/`, deterministic helpers in `scripts/`, and output templates or boilerplate in `assets/`.

## Wrapping existing resources

For a standalone Skill:

1. Read its complete `SKILL.md` and inspect bundled files.
2. Derive the manifest Skill name from valid frontmatter, not only the directory name.
3. Copy the complete Skill directory into `skills/<name>/`, excluding source-control metadata, dependency caches, Harness project state, and OS metadata.
4. Preserve executable bits required by bundled scripts.
5. Reject or resolve symbolic links before packaging; never allow a link to escape the captured content.
6. Leave the original directory unchanged.

For MCP servers and hooks, inspect the source Agent configuration, translate only requested entries, declare environment variable names, and remove literal credential values. Do not copy authentication, sessions, history, or unrelated Agent settings.

## Dependencies and coordinating Skills

Declare Package dependencies as an unordered install graph:

```yaml
spec:
  dependencies:
    - name: paper-search
      version: ^1.0.0
      source: gh:owner/paper-search#v1.0.0
    - name: idea-gen
      version: ^1.0.0
      source: gh:owner/idea-gen#v1.0.0
    - name: exp-design
      version: ^1.0.0
      source: gh:owner/exp-design#v1.0.0
  entrypoints:
    - name: research
      skill: auto-research
      description: Produce an evidence-backed idea and executable experiment plan.
  skills:
    - name: auto-research
      path: ./skills/auto-research
```

Make every dependency `name` match the Package returned by `harness inspect <source>`. Accepted sources are `builtin:name`, local paths, `gh:owner/repository#tag-or-revision`, HTTPS Git, and SSH Git. Relative local sources resolve from the parent Package and are appropriate only for local development. Git and built-in Packages cannot depend on local paths.

A dependency-only Package may omit Skills and entrypoints. Add a coordinating entrypoint Skill only when the Package must teach the Agent a reusable method. That Skill may describe normal capability ordering, evidence-based branching, retries, returns, interruption checkpoints, success and failure conditions, budgets, no-progress limits, and outputs. It must not turn the dependency array into steps or require a Harness workflow engine.

## Updating an existing Package

- Read and validate the current Package before editing.
- Preserve resources and metadata outside the user's requested change.
- Keep existing Package and Skill identities unless the user explicitly requests a breaking rename.
- Reconcile requirements when adding or removing MCP servers and hooks.
- Re-run complete dependency resolution after any dependency change.
- Report breaking identity, target, entrypoint, or requirement changes explicitly.

## Validation

From the Package's parent directory, run:

```bash
harness inspect ./repository-tools
```

This resolves the complete dependency closure and validates manifest structure, Package identities, versions, Skill frontmatter and paths, MCP and hook declarations, source portability, and Package contents. Do not report completion until it succeeds. To test activation separately, install into an inactive disposable Environment only with explicit user authorization.
