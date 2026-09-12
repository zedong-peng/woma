# Woma

Woma manages a harness installation environment: pin its executable version, install native extensions, switch environments, and recreate managed content.

An **Environment** is a directory containing one harness, its installed **Packages**, and an independent native home. Environment names locate directories. Codex and Claude Code are supported; Node.js (20.19+, 22.13+, or 24+), Git, and Bash or Zsh are prerequisites. Runtime availability depends on the official release and platform (macOS/Linux, x64/arm64).

## Daily use

```bash
npm install -g woma
woma init
# Open a new shell after initialization.
woma create -n research codex
woma activate research
woma install ./review-skill ./native-plugin
codex
woma update codex
woma export -f environment.yaml
woma export --explicit -f woma.lock
woma create -n reproduced -f woma.lock
woma run -n reproduced codex
woma deactivate
```

Use `claude` instead of `codex` for a Claude Code environment. `codex@0.154.0` or `claude@2.1.269` selects an exact runtime release. Omitting the version resolves the official latest release once, then locks it. Only an explicit install/update changes that choice. System harness installations are never used as fallback.

Use `-n/--name` or `-p/--prefix` on environment commands. Without a target, commands use `WOMA_PREFIX` from the active shell or fail. There is no implicit `base`. `init` installs shell integration only; shell startup does not select an environment.

```bash
woma create -p ./envs/review claude@2.1.269
woma activate -p ./envs/review
woma list
woma doctor
woma env list
woma remove review-skill
woma deactivate
woma env remove -p ./envs/review
```

## Packages

- **Runtime:** official npm release artifacts, platform identity, upstream SHA-512 integrity, and a SHA-256 content snapshot. Woma extracts release files directly without npm install scripts or global installation changes.
- **Skill:** a standalone `SKILL.md` directory (or its `SKILL.md` path), or a directory with direct `skills/*/SKILL.md` entries. References, scripts, and other companion files are preserved.
- **Native Plugin:** `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`, with its original manifest, MCP definitions, Hooks, and other content. Woma does not translate these capabilities.
- **Collection:** an optional `woma.yaml` declaring dependencies, with no capability language of its own.

Existing native packages do not need a Woma manifest. An optional `woma.yaml` can supply `name`, `version`, `dependencies`, and `harnesses`. Sources are local directories and Git:

```bash
woma install ./review-skill
woma install gh:owner/repository --subdir plugins/review --commit FULL_COMMIT_SHA
woma install 'https://example.org/team/review.git#main'
```

Local sources become immutable snapshots. Git refs become exact commits; the original requested ref remains in the recipe for explicit updates. New installations preserve existing dependency resolutions. `woma update review` refreshes that package and its dependency subtree, checking the whole environment for conflicts.

## Native ownership

Each environment has a real, stable `home/`. Model, provider, permissions, credentials, sessions, caches, and Memory belong to the harness or user. Woma installs no default capabilities and imports no login or other native state. Packages installed directly by native tools stay unmanaged until explicitly adopted with `woma install <native-path>`.

Woma owns specific installation paths and necessary registration keys. It preserves unrelated settings and supports editors that atomically replace configuration files. New plugins are installed disabled; enable them in the native tool when ready. Enablement is local configuration and is preserved on update, not exported.

The initial verified plugin adapters support Codex >=0.154.0 and Claude Code >=2.1.269. Older runtimes can host plain Skills when available, but cannot receive native Plugins through an unverified adapter. Native plugin dependencies that the adapter cannot lock without native resolution are rejected. See [native adapters](docs/agent-adapters.md).

Package files are independent environment copies, backed by a shared immutable content store. Editing managed files produces drift diagnostics; updates and removals preserve the changed files and fail. Restart the harness after modifying an environment.

## Reproduction

`environment.yaml` records direct installation intent. `woma.lock` records exact runtime artifacts, platform, package contents, sources, and the complete dependency graph. Recreating a lock on the same platform verifies its digests and does not upgrade anything. Missing Git/runtime content can be fetched at the locked identity. A missing local snapshot is an error, even if the original source still exists.

Exports read Woma metadata only. They never scan or archive native homes. Credentials, configuration, sessions, external commands, remote services, project settings, and model behavior are outside the reproduction guarantee. This version provides no offline bundle.

**Deleting an environment deletes all its local native state.** The deletion prompt names that state explicitly; a recipe or lock cannot restore it.

## Format change

v2 replaces the previous multi-target capability projection design. Existing v1 environments are left in place and reported as legacy. They are never imported, repaired, or migrated automatically. Create a new v2 environment and explicitly install the packages you need. Native packages no longer have to be Agent-neutral.

## Development

```bash
npm ci
npm run check
npm test
WOMA_LIVE_TESTS=1 npm run test:live
```

Unit tests cover runtime isolation, shell selection, native ownership, Git locking, conflicts, drift, and rollback. Live tests download official releases into temporary directories and exercise native plugin discovery without model calls or user credentials.

See [commands](docs/commands.md), [package format](docs/manifest.md), [design](docs/design.md), [ownership](docs/agent-harness-behavior.md), and [security boundaries](SECURITY.md).
