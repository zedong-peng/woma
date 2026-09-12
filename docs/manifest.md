# Package Format

Woma recognizes the native package content first. It does not synthesize or rewrite an upstream capability manifest.

## Accepted layouts

```text
review/SKILL.md                          # standalone Skill, with companions
review/references/...

toolkit/skills/review/SKILL.md            # direct Skill collection
toolkit/skills/design/SKILL.md

native/.codex-plugin/plugin.json         # Codex native Plugin
native/.mcp.json
native/hooks/hooks.json
native/skills/review/SKILL.md

native/.claude-plugin/plugin.json        # Claude native Plugin

collection/woma.yaml                     # dependencies only
```

The initial adapter requires one explicit harness manifest. Dual manifests and universal root `plugin.json` layouts are rejected until their overlay/precedence rules have a verified adapter. Upstream native manifest fields, Hooks, MCP configuration, and file content are otherwise preserved. Plugins with native dependency declarations are rejected because Woma cannot prevent unlocked resolution through the native loader.

Standalone and direct collection Skills require YAML frontmatter with a nonempty `name` and `description`. Skill names, package names, and environment names use lowercase letters, digits, dots, underscores, and hyphens, starting with a letter or digit, up to 80 characters. `codex` and `claude` are reserved runtime package names.

Package trees are complete snapshots except `.git`, `.woma`, and `.DS_Store`. Symlinks and special files are rejected. Woma does not inspect native homes to discover packages: the source must be an explicitly supplied package directory. Export never reads this source again.

## Optional woma.yaml

```yaml
name: research
version: 1.0.0
harnesses:
  codex: '>=0.154.0'
dependencies:
  - name: review
    version: ^1.0.0
    source: ../review
```

These are the only supported fields. `dependencies` defaults to empty. `harnesses` maps supported harnesses to runtime semver constraints; omitted constraints allow both harnesses for Skills and only the native harness for a Plugin. Name/version default to native metadata or content-derived identity. A supplied name/version must agree with the native Plugin manifest.

Each dependency declares `name`, `source`, and an optional semver `version` constraint (default `*`). Local relative paths resolve beside the declaring package. Repository-relative Git dependencies resolve inside the same exact commit; other Git dependencies may name their own source/ref. Absolute local dependencies from Git packages are rejected.

Dependency cycles, source disagreements, name collisions, mismatched versions, duplicate Skills, conflicting installation paths, and incompatible harnesses fail before publication. Git submodules are rejected; supply complete local content or explicit package dependencies. Installing another package preserves existing resolutions. Explicit updates re-resolve only the selected package subtrees and check them against the whole closure.

The previous `apiVersion/kind/metadata/spec` manifest is unsupported. Move native MCP and Hooks into a harness-native Plugin. Woma has no core MCP, Hook, entrypoint, or cross-harness translation language. Native Plugins may intentionally target one harness.

## Recipe and lock

```yaml
format: woma.environment/v2
name: research
harness: codex
runtime: latest
packages:
  - name: review
    source: file:/absolute/path/to/review
```

A recipe captures direct intent and can resolve newer content when used to create an environment. A lock uses `format: woma.lock/v2`, contains that recipe, records the platform, and enumerates every package in the dependency closure. Each package records exact name/version/kind, source identity, SHA-256 snapshot integrity, dependency edges, harness constraints, and installation descriptors. Runtime sources additionally record the official provider, artifact names/versions/URLs/SHA-512 integrity, and executable path.

Creating from a lock checks identities and content. It fetches only the locked Git commits or official runtime artifacts when needed. Missing local snapshots fail explicitly. It never substitutes current local content, upgrades a ref, or uses a system executable. A lock contains no native user configuration, plugin enable state, credentials, sessions, or Memory.
