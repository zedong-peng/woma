# Woma Package Format

A package is an ordinary directory in any of these native layouts. Woma never rewrites it.

| Layout | Installs as |
| --- | --- |
| `SKILL.md` with `name` and `description` frontmatter, plus companion files | one Skill, for every agent in the environment |
| `skills/*/SKILL.md` | a Skill collection |
| a directory whose child directories each contain `SKILL.md` | a Skill collection |
| `.claude-plugin/plugin.json` | a native Claude Code plugin (Claude only) |
| `.codex-plugin/plugin.json` | a native Codex plugin (Codex only) |
| `woma.yaml` with only `dependencies` | a collection of other packages |

Sources are local paths, `gh:OWNER/REPO[/PATH][#REF]`, GitHub browser URLs, `NAME@OWNER/REPO[#REF]` (a Skill or marketplace plugin by name), and Git URLs. Git refs lock to exact commits.

Optional `woma.yaml`:

```yaml
name: research
version: 1.0.0
harnesses:          # agents that may use the package; omit to allow both
  claude: '*'
  codex: '*'
dependencies:
  - name: review
    version: ^1.0.0
    source: ../review
```

Only `name`, `version`, `harnesses`, and `dependencies` are accepted. MCP servers and Hooks belong in a native plugin, or in the environment (`woma mcp add`). Names/versions must agree with native plugin metadata when both are present.

Names use lowercase letters, digits, dots, underscores, and hyphens, up to 80 characters. `claude` and `codex` are reserved. Local relative dependencies resolve beside the declaring package; Git relative dependencies stay in the same locked commit.

Every file is snapshotted except `.git`, `.woma`, and `.DS_Store`. Symlinks and special files are rejected. Credentials, native settings, sessions, caches and Memory are never package content.

```bash
woma create -n authoring claude codex
woma install -n authoring ./my-package
woma doctor -n authoring
woma export -n authoring -f environment.yaml
```

Native plugins need Claude Code >=2.1.269 or Codex >=0.154.0. They are enabled on install; later native enable/disable choices are preserved.
