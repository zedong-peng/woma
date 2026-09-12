# Minimal v2 Package Format

Accepted sources are a local directory (or standalone SKILL.md path) and Git. A Skill package contains `SKILL.md` with `name` and `description` frontmatter, or direct `skills/*/SKILL.md` entries. Native Plugins use exactly one explicit `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`. Preserve their original contents. Woma does not support dual/universal overlays or native dependency resolution in the initial adapters.

Optional metadata:

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

Only `name`, `version`, `harnesses`, and `dependencies` are accepted. Do not add `apiVersion`, `kind`, `metadata`, `spec`, `skills`, `mcpServers`, `hooks`, `entrypoints`, or `requirements`. Existing native packages need no Woma manifest. Names/versions must agree with native metadata when both are provided.

Names use lowercase letters, digits, dots, underscores, and hyphens, beginning with a letter or digit, up to 80 characters. Runtime names `codex` and `claude` are reserved. Versions are semantic versions. Each dependency provides name/source and an optional semver constraint (default `*`). Local relative dependencies resolve beside the declaring package; Git relative dependencies stay in the same locked repository commit.

Every package file is snapshotted except `.git`, `.woma`, and `.DS_Store`. Symlinks and special files are unsupported. Native configuration, credentials, sessions, caches, Memory, external tools/services, and model behavior are not package content or exportable environment state.

```bash
woma create -n authoring codex@0.154.0
woma install -n authoring ./my-package
woma doctor -n authoring
woma export -n authoring --explicit -f woma.lock
```

For Claude native Plugins use a Claude environment with runtime >=2.1.269. New plugins install disabled and retain native enable/disable controls. Full upstream manifest and behavior are preserved within the verified native contract.
