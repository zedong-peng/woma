# Agent Harness Behavior Reference

This document is the behavioral reference for Agent harnesses under Woma: path selection, file ownership, native Agent
writes, external configuration tools, Woma command effects, and the resulting filesystem transitions. It is intended for
Woma development, debugging, and review. The manifest format is documented separately in [manifest.md](manifest.md), and
transaction and isolation guarantees are documented in [design.md](design.md).

Woma follows Conda's prefix model where it maps cleanly: selecting an Environment changes the roots used by tools started
from that shell, and files written through those roots belong to that Environment. Woma adds an Agent-specific distinction
between opaque Agent state, Environment-local external Skills, and locked Woma Package resources.

## Path notation and stability

| Notation | Meaning |
| --- | --- |
| `$WOMA_HOME` | Woma state root; defaults to `~/.woma` |
| `<environment>` | A global Woma Environment name such as `base` or `research` |
| `<agent-home>` | The active root selected by `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, or `QODER_CONFIG_DIR` |
| `<project>` | The exact working directory, or the directory passed with `--project`; Woma does not search parent directories |
| `<package>` | A Woma Package name |
| `<cache-key>` | The content-addressed Package resolution recorded in the Environment lock |

Paths in this document have one of three stability levels:

- **Woma contract:** created, linked, read, or reconciled by Woma. Code and tests may depend on it.
- **Agent contract:** a documented Agent configuration or Skill path consumed by Woma. The Agent owns its format unless
  Woma explicitly manages fields within it.
- **Opaque:** Agent-owned implementation state. Woma preserves it but does not interpret, migrate, lock, or bundle it unless
  a command explicitly documents an exception.

Do not promote an observed Agent cache, database, plugin installation directory, or credential file into a Woma contract.
Add a provider adapter and tests first when Woma needs to own a new path.

## Environment layout

Every Woma Environment is global and has this logical layout:

```text
$WOMA_HOME/environments/<environment>/
├── environment.yaml          # root Packages and target Agents
├── lock.json                 # exact recursive Package closure
├── home/
│   ├── skills/               # real shared Environment Skill directory
│   ├── codex/                # stable CODEX_HOME when Codex is targeted
│   ├── claude/               # stable CLAUDE_CONFIG_DIR when Claude is targeted
│   ├── pi/                   # stable PI_CODING_AGENT_DIR when Pi is targeted
│   └── qoder/                # stable QODER_CONFIG_DIR when Qoder is targeted
└── view -> .view.gen-<id>/   # atomically published managed generation
    ├── view.json             # generation metadata and resource inventory
    ├── skills/<name>         # links to immutable Package contents
    ├── codex/
    ├── claude/
    ├── pi/
    └── qoder/
```

The stable Agent homes are not generation-swapped. Each targeted Agent's `skills` path links to the one real
`home/skills` directory. Within that shared directory:

- a Woma-managed Skill is a link through `view/skills/<name>` to an immutable Package;
- a non-hidden ordinary Skill is Environment-local with origin `external`;
- hidden entries such as Codex `.system` are opaque and excluded from Woma inventory.

The Package Store and other global state live outside Environment prefixes:

```text
$WOMA_HOME/
├── packages/<package>/<cache-key>/        # immutable Package generations
├── migrations/skills/<name>/<hash>/       # explicit Skill migration snapshots
├── locks/environments/<environment>.lock  # mutation serialization
├── locks/packages/<name>/<cache-key>.lock
├── locks/projects/<canonical-path-hash>.lock
└── shell/                                  # static scripts written by woma init
```

Package removal detaches resources from an Environment but does not delete immutable Package Store entries.

## Agent path map

The shell hook records the original roots and changes only the roots for Agents targeted by the selected Environment.

| Agent | Original default root | Selected Environment root | Skill path visible to the Agent | Woma-managed configuration |
| --- | --- | --- | --- | --- |
| Codex | `~/.codex` | `$WOMA_HOME/environments/<environment>/home/codex` | `$CODEX_HOME/skills` | `$CODEX_HOME/config.toml`, `$CODEX_HOME/hooks.json` |
| Claude Code | `~/.claude` | `$WOMA_HOME/environments/<environment>/home/claude` | `$CLAUDE_CONFIG_DIR/skills` | `$CLAUDE_CONFIG_DIR/settings.json`, Package MCP fields in `$CLAUDE_CONFIG_DIR/.claude.json` |
| Pi | `~/.pi/agent` | `$WOMA_HOME/environments/<environment>/home/pi` | `$PI_CODING_AGENT_DIR/skills` | none beyond the Skill link |
| Qoder CLI | `~/.qoder` | `$WOMA_HOME/environments/<environment>/home/qoder` | `$QODER_CONFIG_DIR/skills` | `$QODER_CONFIG_DIR/settings.json` |

All four selected Skill paths resolve to:

```text
$WOMA_HOME/environments/<environment>/home/skills
```

The managed Codex, Claude, and Qoder configuration files in stable homes link into the current view. Woma owns only the
Package resource projections described below; it preserves unrelated user-owned fields.

### Codex

| Capability or state | Active path | Ownership and behavior |
| --- | --- | --- |
| Ordinary Skills | `$CODEX_HOME/skills/<name>/SKILL.md` | Shared Environment Skill root; external unless installed as a Woma Package |
| Codex system Skills | `$CODEX_HOME/skills/.system` | Opaque Codex state; preserved and excluded from inventory, locks, and bundles |
| MCP servers | `$CODEX_HOME/config.toml` under `mcp_servers` | Woma preserves user configuration and regenerates only marker-delimited Package blocks |
| Hooks | `$CODEX_HOME/hooks.json` | Woma merges Package Hooks and preserves unrelated entries |
| Authentication | `$CODEX_HOME/auth.json` | Opaque Codex-owned state; never seeded from the original home or included in managed views |
| Plugins | Agent-owned | Woma does not install, inspect, migrate, lock, project, or bundle Codex Plugins |
| Sessions and history | Known paths documented by `migrate sessions` | Opaque except during an explicit migration |

Codex can also read trusted project configuration from `<project>/.codex/config.toml` and
`<project>/.codex/hooks.json`. Woma does not normally write those files. `woma capture --from codex` reads project Skills
from `<project>/.agents/skills`, MCP servers from `<project>/.codex/config.toml`, and Hooks from
`<project>/.codex/hooks.json` into a new Package source directory.

A Codex Plugin source commonly contains `.codex-plugin/plugin.json`, `skills/`, optional MCP configuration, and optional
`hooks/hooks.json`. These are Plugin authoring inputs, not Woma Package resources. Installing or enabling a Plugin may
change opaque Agent state. Woma observes a bundled Skill only if the Agent materializes it as a non-hidden direct child of
the active shared Skill root; even then it is reported as `external`, not adopted as a Woma Package.

### Claude Code

| Capability or state | Active path | Ownership and behavior |
| --- | --- | --- |
| Skills | `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` | Shared Environment Skill root; external unless installed as a Woma Package |
| MCP servers | `$CLAUDE_CONFIG_DIR/.claude.json` under `mcpServers` | Woma reconciles only Package-managed server entries |
| Hooks and settings | `$CLAUDE_CONFIG_DIR/settings.json` | Woma merges Package Hooks and preserves unrelated settings |
| Credentials | `$CLAUDE_CONFIG_DIR/.credentials.json` | Agent-owned; may seed a new Environment, then remains Environment-local |
| Sessions and other files | Other paths in `$CLAUDE_CONFIG_DIR` | Opaque except during an explicit session migration |

`woma capture --from claude` reads project Skills from `<project>/.claude/skills`, MCP servers from
`<project>/.mcp.json`, and Hooks from `<project>/.claude/settings.json`.

### Pi

Woma provides Pi with the shared Skill directory and otherwise treats `$PI_CODING_AGENT_DIR` as opaque. Login state,
settings, model catalogs, Pi Packages, and sessions remain Agent-owned. New Environments do not seed the original Pi home.
Woma Package MCP servers and Hooks cannot target Pi; manifest validation rejects that combination.

### Qoder CLI

Qoder Skills use the shared Skill directory. Woma projects Package MCP servers and Hooks into
`$QODER_CONFIG_DIR/settings.json` while preserving unrelated settings. Credentials, login state, sessions, and all other
non-Skill paths are opaque. New Environments do not seed the original Qoder home.

## Ownership states

The same Skill-shaped content can have three different ownership states:

| State | Created by | Recorded in recipe/lock | Stored in Package Store | Shared across targets | Included in bundle |
| --- | --- | --- | --- | --- | --- |
| Agent-owned opaque state | Agent | no | no | only if the Agent chooses | no |
| Environment-local external Skill | Any Agent or user writing through an active Skill path | no | no | yes, within one Environment | no |
| Woma-managed Package Skill | `woma install` or explicit migration | yes | yes | yes, for effective targets | yes |

This is analogous to installing a non-Conda package inside an active Conda prefix: it belongs to that Environment but is
not retroactively added to the package manager's explicit dependency records. Woma deliberately has no `sync` operation
that adopts external Skills.

## Agent-initiated behavior

### Starting an Agent

After `woma activate <environment>`, starting `codex`, `claude`, `pi`, or `qodercli` directly causes that process to use
the selected stable Agent home. The process may create or mutate credentials, sessions, databases, caches, Plugins, and
other runtime files there. Except for the documented managed configuration and Skill paths, these writes are opaque to
Woma and remain isolated to the Environment.

Woma does not proxy Agent executables, watch their homes, or bind session IDs to Environments. Resuming a session therefore
uses the Environment selected in the current shell. Already-running Agents may retain startup-time Skill or MCP discovery;
restart them after changing an Environment closure.

### Installing a Skill through an Agent

When an Agent installs or writes an ordinary Skill under its active `skills` path, the filesystem change lands in
`home/skills/<entry>`. The result is immediately visible through every targeted Agent's Skill path in that Environment.

Woma does not run during this write. A later `woma list`, `woma info --json`, or `woma doctor` enumerates non-hidden direct
children, reads valid `SKILL.md` frontmatter, and reports the Skill with origin `external`. It does not hash the full tree,
copy it, infer which Agent created it, add it to `environment.yaml` or `lock.json`, or publish it to the Package Store.

Name conflicts with Package-managed Skills are rejected during Woma inspection or mutation. Invalid Skill metadata is
reported but not repaired automatically.

### Login, provider settings, and Plugins

Agent login and provider configuration mutate the selected Agent home, not a Woma secret store. Secret values must remain
in Agent configuration or shell environment variables; Woma manifests, locks, and bundles contain names and metadata only.

Plugin installation and enablement are Agent-owned operations. In particular, Woma must not assume that a Plugin directory
is equivalent to a Package, or that Plugin-bundled Skills, MCP servers, and Hooks are represented by the same files as Woma
projections. Supporting Plugins requires an explicit adapter and ownership model rather than scanning opaque Agent state.

### External atomic config writers and managed links

This section documents the current managed-link implementation for debugging. It is not the proposed stable-file design
under discussion in [issue #65](https://github.com/zedong-peng/woma/issues/65).

The following paths in a current Environment home must be symbolic links to the same paths below the stable `view` link:

| Agent | Required managed links |
| --- | --- |
| Codex | `home/codex/config.toml`, `home/codex/hooks.json` |
| Claude Code | `home/claude/.credentials.json`, `home/claude/settings.json` |
| Qoder CLI | `home/qoder/settings.json` |

Codex `home/codex/auth.json` and Claude `home/claude/.claude.json` are not part of this link set. Codex owns the former as
an ordinary file. Woma structurally reconciles Package-managed Claude MCP entries in the latter while leaving it in the
stable home.

An in-place write through a managed link changes the file in the current view generation. A writer that instead creates a
temporary sibling and renames it over the active path replaces the symbolic link itself with an ordinary file. The old
view file remains unchanged. This is deterministic on Unix; CC Switch also removes the destination before renaming on
Windows, with the same resulting ordinary file.

CC Switch uses this temporary-file-and-rename strategy for JSON and TOML writes. Its default configuration directories are
the conventional Agent homes, such as `~/.codex` and `~/.claude`, rather than Woma's shell-selected homes. The managed-link
failure occurs when a CC Switch custom Codex or Claude configuration directory is set to a Woma Environment home. Other
editors and configuration managers with the same atomic-replacement strategy produce the same result.

After a non-credential managed link is replaced with an ordinary file:

- the Agent may continue using that ordinary file, so the immediate provider change can appear successful;
- `woma doctor` and `woma activate` fail with a missing managed Agent home link;
- `woma install` and `woma remove` fail because the managed Agent home path is not a symbolic link;
- Woma does not import the replacement file into the recipe, lock, or current view automatically.

Claude `.credentials.json` has a credential-recovery path during view publication: install or remove can copy the bytes from an
ordinary replacement into the next view and restore the managed link. `doctor` and ordinary current-layout activation
still require the link and report it as invalid before such a publication.

To diagnose the representation without reading configuration contents:

```bash
environment=base
environment_root="${WOMA_HOME:-$HOME/.woma}/environments/$environment"

ls -ld "$environment_root/home/codex/config.toml"
readlink "$environment_root/home/codex/config.toml"
woma doctor --name "$environment"
```

A healthy Codex entry is a symbolic link whose target resolves to
`$environment_root/view/codex/config.toml`. Repeat the check with the paths in the table above for another target. A regular
file at one of those paths confirms representation drift even when its contents are valid Agent configuration.

There is currently no public Woma command that automatically adopts a replacement config file and repairs a non-credential
managed link. Stop or redirect the external writer first. Preserve the ordinary file, recreate the expected link, validate
the Environment, and then review the preserved file for non-Woma settings that need to be reapplied. For example, for
Codex:

```bash
mv "$environment_root/home/codex/config.toml" \
  "$environment_root/home/codex/config.toml.external-backup"
ln -s "$environment_root/view/codex/config.toml" \
  "$environment_root/home/codex/config.toml"
woma doctor --name "$environment"
```

Do not copy the complete backup over the managed target: it may remove or replace Package-managed MCP blocks. Compare the
backup with the restored configuration and reapply only the intended user/provider settings. Keep the backup until the
Agent and `woma doctor` both succeed.

## Woma command effects

The table lists durable effects after a successful command. Temporary staging paths and retired view generations are
implementation details and are omitted. Commands that implicitly select `base`, including `env list`, `list`, `info`,
`doctor`, `install`, `activate`, and `run`, may lazily create or repair `base` before performing the listed operation.

| Operation | Reads | Creates or changes | Explicitly does not change |
| --- | --- | --- | --- |
| `woma init` | selected shell profile | `$WOMA_HOME/shell/*` and one marker-delimited profile block | Environments, Packages, projects, Agent homes |
| shell startup | static Woma hook and existing Environment metadata | shell variables only | Woma state and project files |
| `woma create --name <environment>` | target defaults and supported seed configuration | Environment directory, `environment.yaml`, empty `lock.json`, stable homes, initial view | original Agent state; no implicit Packages |
| `woma activate <environment>` | current-format recipe, lock, Package closure, and view | shell variables only | Environment files, Agent configuration, project content, and Agent Memory |
| `woma deactivate` | saved original Agent roots | shell variables only | Environment contents |
| `woma run -n <environment> ...` | Environment snapshot | child-process environment only; Agent may then mutate its selected home | parent shell variables |
| `woma install <source>` | normalized source and dependency graph | Package Store entries, root recipe, lock closure, shared managed Skill links, MCP/Hook projections, atomic view | source directory, credentials, sessions, external Skills |
| `woma remove <package>` | current recipe and lock | root recipe, pruned lock closure, shared managed Skill links, MCP/Hook projections, atomic view | Package Store, credentials, sessions, external Skills |
| `woma migrate skills` | original Codex/Claude Skill directories | migration snapshots, Package Store, recipe, lock, managed view | original Skills, hidden Skills, Agent Plugins |
| `woma migrate sessions` | documented original Codex/Claude session paths | ordinary files in the selected stable Agent home; structured JSONL merges where documented | credentials, provider settings, Skills, Plugins, caches |
| `woma capture <output> --from ...` | supported project Skill/MCP/Hook files | a new editable Package source at `<output>` | active Environment, original project configuration, literal secret values |
| `woma inspect <source>` | normalized source | an immutable Package Store cache entry; `inspect -n <environment> <package>` instead reads the locked cache | source, recipe, Environment lock, view |
| `woma list`, `woma info --json` | Environment metadata, Package closure, external Skill frontmatter | nothing | Agent opaque state beyond documented checks |
| `woma doctor` | recipe, lock, Package Store, managed views, requirements, external Skill frontmatter | nothing | damaged state; it reports rather than repairs |
| `woma export` | recipe, lock, complete immutable Package closure | requested `.woma-env` file | Agent homes, external Skills, credentials, sessions, projects |
| `woma create --file <bundle>` | bundle contents | Package Store entries and a new Environment recipe, lock, homes, and view | existing Environment names and Agent opaque state |
| `woma rename` | complete source Environment | moves the complete Environment directory and updates its name metadata | Package Store; active `base` and active source are refused |
| `woma env remove` | target Environment identity | removes the complete inactive Environment directory | Package Store and other Environments; `base` is refused |

Install, remove, import, migration publication, and view repair run under Environment and Package locks. For ordinary
failures, Woma restores the previous recipe, lock, managed stable-home state, and view pointer. External Skills and opaque
Agent writes are outside those transactions except for explicit migration commands.

`--dry-run` is a command-specific contract, not a general CLI flag. `woma init --dry-run`, `woma remove --dry-run`, and
`woma migrate skills --dry-run` do not publish their planned changes; a Skill migration dry run also does not initialize an
absent `base`. `woma migrate sessions --dry-run` does not publish session files, but the CLI resolves and, when necessary,
initializes its destination Environment first. Consult [commands.md](commands.md) before adding another dry-run path.

`woma env remove` deletes the complete inactive Environment prefix, including opaque credentials, sessions, databases,
Plugins, and external Skills stored there. Those files are not recoverable from the Environment lock or a `.woma-env`
bundle. The Package Store remains intact.

## Resource projection by target

Given one Package manifest, Woma derives target-specific files as follows:

| Package resource | Codex | Claude Code | Pi | Qoder CLI |
| --- | --- | --- | --- | --- |
| Skill | shared `home/skills/<name>` via managed view link | same | same | same |
| MCP server | managed block in `view/codex/config.toml` | managed entry in stable `home/claude/.claude.json` | unsupported | managed entry in `view/qoder/settings.json` |
| Hook | managed entry in `view/codex/hooks.json` | managed entry in `view/claude/settings.json` | unsupported | managed entry in `view/qoder/settings.json` |

The stable Codex `config.toml` and `hooks.json`, Claude `settings.json`, and Qoder `settings.json` link to these target view
files. Claude MCP state is updated transactionally in its stable `.claude.json` because that Agent state is not represented
by the generation-swapped settings view.

Woma filters resources by the Environment targets, Package platforms, and optional resource platforms. Unsupported target
combinations fail validation instead of being silently ignored.

## Worked filesystem transitions

### Agent installs an ordinary Skill

Before:

```text
home/skills/
└── .system/                  # possible hidden Agent state
```

The active Agent writes `$AGENT_SKILLS/review/SKILL.md`. After:

```text
home/skills/
├── .system/
└── review/
    └── SKILL.md              # Environment-local external Skill
```

`environment.yaml`, `lock.json`, `packages/`, and `view/` are unchanged. Every targeted Agent sees `review`, while another
Environment does not.

### Woma installs a Package

Installing Package `review-tools` with Skill `review`, MCP server `tracker`, and a Hook changes the managed closure:

```text
$WOMA_HOME/
├── packages/review-tools/<cache-key>/...
└── environments/<environment>/
    ├── environment.yaml                   # adds review-tools as a root
    ├── lock.json                          # adds exact closure records
    ├── home/skills/review -> ../../view/skills/review
    └── view -> .view.gen-<new-id>/
        ├── view.json
        ├── skills/review -> <Package Store content>
        ├── codex/config.toml              # tracker block, when targeted
        ├── codex/hooks.json               # Hook entry, when targeted
        ├── claude/settings.json           # Hook entry, when targeted
        └── qoder/settings.json            # MCP and Hook entries, when targeted
```

If an external `home/skills/review` already owns that name, installation fails rather than overwriting it.

### Woma removes a Package

Removing `review-tools` deletes its root from `environment.yaml`, removes unreachable records from `lock.json`, publishes a
new view without its resources, and removes its managed Skill link from `home/skills`. The immutable
`packages/review-tools/<cache-key>` entry remains. Same-name external content is not restored or synthesized.

### Switching Environments

`woma activate research` changes the current shell to:

```text
WOMA_ENV=research
CODEX_HOME=$WOMA_HOME/environments/research/home/codex       # when targeted
CLAUDE_CONFIG_DIR=$WOMA_HOME/environments/research/home/claude
PI_CODING_AGENT_DIR=$WOMA_HOME/environments/research/home/pi
QODER_CONFIG_DIR=$WOMA_HOME/environments/research/home/qoder
```

Unsupported targets retain their saved original roots. Activation does not copy files between Environments. This is why an
Agent login, external Skill, Plugin, session, or database created in one selected Environment does not appear in another.

## Development checklist

When adding support for a new Agent resource or changing a path:

1. Classify the path as Woma-managed, shared external Skill state, or opaque Agent state.
2. Define the original Agent source, selected Environment destination, and project-scoped source separately.
3. Specify create, merge, conflict, removal, rollback, export, import, migration, and `doctor` behavior.
4. Preserve unrelated Agent-owned fields and reject ambiguous ownership collisions.
5. Keep credentials and literal secrets out of manifests, locks, bundles, logs, and captured Packages.
6. Test inactive and active Environments, multi-target sharing, restart expectations, and failed publication rollback.
7. Update this document, [commands.md](commands.md), [manifest.md](manifest.md), and [design.md](design.md) only where their
   respective public contracts change.
