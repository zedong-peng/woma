# Reproducible multi-Agent environments

> [!NOTE]
> The formal [Agent Adapter contract](../agent-adapters.md), canonical projection boundary, shared publisher, and built-in
> OpenCode Adapter are implemented. Runtime locking, neutral manifest migration, per-Agent native capability directories,
> `installMethod`, and capture remain proposal work. The current v1 manifest therefore still accepts legacy platform
> selectors, interpreted only by the canonical compatibility layer.

Status: proposed

Related discussions: [#65](https://github.com/zedong-peng/woma/issues/65),
[#66](https://github.com/zedong-peng/woma/issues/66), and
[#67](https://github.com/zedong-peng/woma/issues/67).

## Decision

Woma will model an Environment as one shared, Agent-independent capability Package closure, one or more versioned Agent
Runtime Packages, and one isolated mutable home per Agent:

```text
Environment
|-- one or more Agent Runtime Packages
|-- one capability Package closure
|   |-- Skills
|   |-- MCP servers
|   `-- Hooks
|-- one projection per Agent
`-- one isolated, mutable home per Agent
```

The Environment is the user's capability context. Activating it may select Codex, Claude Code, or several other Agent
runtimes at once, so the user can start any selected Agent from the same shell. The selected Agents share Package intent
and immutable Package bytes; they never share a writable native home, Skill directory, configuration file, credential,
session, cache, database, or Plugin directory.

An Environment containing one Agent remains valid. Woma does not introduce a second Profile or Environment-group layer to
coordinate several single-Agent Environments. Such a layer would need its own cross-Environment resolution, transaction,
rollback, and drift semantics and would recreate the multi-Agent Environment indirectly.

Agent runtimes are distinguished Packages. They participate in resolution, storage, locking, export, and recreation, but
they do not use the capability Package manifest format or appear in the capability `packages` map. Each Runtime Provider
normalizes an upstream distribution into a separate immutable Store contract.

Woma provides the Environment platform. It does not orchestrate benchmarks, define experiment matrices, manage datasets or
prompts, record run results, or prescribe how an Environment is consumed. A researcher can use ordinary scripts to create
or select Woma Environments in the same way that research scripts use Conda Environments.

## Motivation

The current Environment recipe records target Agent names while the corresponding executables are discovered from the
ambient `PATH`. Package locks and Environment bundles therefore reproduce the capability closure but not the Agent runtimes
that interpret it. A machine with different Codex, Claude Code, Pi, Qoder CLI, or OpenCode versions can materialize the same lock and
observe different behavior.

The current multi-target implementation also links every selected Agent to one writable Environment Skill directory. That
makes Agent-native installation immediately visible across Agents, but it lets unrelated Agent processes mutate the same
filesystem tree without a Woma transaction or ownership boundary.

Woma keeps the useful multi-Agent user model while correcting both problems:

- every selected runtime is resolved and locked;
- every Agent has its own writable native state;
- capability Packages are the only cross-Agent source of truth; and
- an Agent-native capability installation is captured as a Package at the next explicit Environment activation.

This is consistent with the useful part of the Conda model. A Conda Environment is a selected prefix and resolved Package
set rather than a hard-coded singleton interpreter. Woma intentionally differs where Agent runtimes have independent native
homes and incompatible configuration contracts.

## User model

The direct command form may select one or more Agent requirements:

```bash
woma create --name research --agent codex=0.1.2 --agent claude=1.0.0
woma install --name research gh:owner/research-capabilities#v1.2.0
woma activate research
codex
claude
```

The versions are illustrative rather than statements about available releases. Woma must implement and test the relevant
Runtime Providers before accepting concrete version constraints.

`woma run` remains a general equivalent of `conda run`; it is not a benchmark runner:

```bash
woma run --name research codex exec --help
woma run --name research claude --help
```

A checked-in Environment recipe recreates the same declared managed layer without embedding experiment workflow:

```yaml
kind: WomaEnvironment
metadata:
  name: research
spec:
  agents:
    - name: codex
      version: "=0.1.2"
    - name: claude
      version: "=1.0.0"
  packages:
    - name: research-capabilities
      version: "=1.2.0"
      source: gh:owner/research-capabilities
      installMethod: woma-install
    - name: local-review
      version: "=0.0.0-agent.<content-digest>"
      source: snapshot:sha256:<content-digest>
      installMethod: agent-install
      installerAgent: codex
  requirements:
    env:
      - OPENAI_API_KEY
```

Agent names are unique within an Environment. Adding, updating, or removing one runtime revalidates the complete capability
closure against every remaining selected Adapter. An Environment must always contain at least one Agent runtime.

The captured root and its generated version are illustrative. Exact snapshot source syntax belongs to the capture Source
Adapter contract.

## Agent Runtime Packages

An Agent Runtime Package supplies or identifies the managed runtime inputs for one Agent:

- Agent identity and exact upstream version;
- immutable source and artifact integrity;
- supported operating system and architecture;
- executable entrypoint exposed through the Environment;
- native Agent home selector, such as `CODEX_HOME`;
- Adapter identity and projection contract revision; and
- semantic capability features supported by that runtime and Adapter combination.

Exact runtime resolutions belong in the Environment lock and immutable artifacts belong in a Woma-managed Runtime Store.
Activation prepends one Environment executable directory containing direct links to the selected locked entrypoints. Agent
executable names are distinct, so Codex and Claude Code can coexist in that directory. These entrypoints are not wrappers:
Woma does not proxy, watch, or remain resident around Agent processes.

An ambient executable on `PATH` never satisfies a locked Agent requirement implicitly. A local runtime source is
snapshotted and verified into the Runtime Store just like any other runtime artifact.

### Provider trust

Artifact integrity alone proves only that later bytes match the first observed bytes. A Runtime Provider must additionally
define:

- the trusted upstream namespace and immutable version-resolution rules;
- authenticated metadata, a trusted checksum, or signature verification where upstream supplies one;
- redirects, download limits, archive type, safe extraction, and executable selection;
- host-platform and architecture validation;
- immutable, non-user-writable Store publication;
- repair-time integrity revalidation; and
- how an Agent self-update mechanism is disabled, redirected, or reported as drift.

Woma must not label a detected local executable `official` merely because its command name is recognized.

Projection Adapters initially ship with Woma and are selected by Agent identity. A Runtime Package must not inject arbitrary
Adapter code into the Woma process. A future Adapter plugin mechanism requires a separate API, trust, and compatibility
design.

## Agent-independent capability Packages

Capability Package manifests describe canonical semantics, not Agents or native configuration files. They may contain
Skills, MCP servers, Hooks, requirements, and Package dependencies. They must not contain Agent names, platform lists,
native destinations such as `config.toml` or `settings.json`, or Agent home paths.

Each selected Adapter validates the complete capability closure. Publication fails before changing the Environment when
any selected Agent cannot represent a canonical resource exactly. Woma does not silently omit a resource, use a Package
compatibility hint, or approximate a Hook whose lifecycle differs from the canonical event.

Skills and MCP transports already have useful cross-Agent semantics. Hooks require particular care because similarly named
events may differ in timing, matching, retry, input, and failure behavior. An Agent-specific Hook does not enter the neutral
Package schema as an escape hatch; it remains unprojectable until Woma can give it an Agent-independent meaning.

Agent-native Plugins are not automatically equivalent to capability Packages. An Adapter may extract canonical Skills,
MCP servers, or Hooks from a Plugin through an explicit, tested import contract. The remaining Plugin is target-specific
Agent state unless Woma introduces a separately specified Agent Extension Package contract. Woma never claims that an
incompatible Plugin was projected to another Agent.

## Per-Agent state and projections

The logical Environment layout is:

```text
$WOMA_HOME/environments/<environment>/
|-- environment.woma.yaml
|-- environment.woma.lock.json
|-- home/
|   |-- codex/
|   `-- claude/
`-- projection/
    |-- codex/
    `-- claude/
```

Each Agent home is a stable, real directory. Its native Skill directory is also per-Agent rather than a link to one shared
writable root. Package-managed Skill entries may link to the same immutable Store bytes, but the containing native
directories and every non-managed entry remain separate.

Credentials, sessions, databases, caches, provider state, native Plugins, and unknown files are opaque. Woma selects and
preserves their per-Environment locations but does not parse, lock, bundle, or copy them between Agents.

Projection has four layers:

```text
Exact Package closure
        |
        v
Canonical closure + schema revision + digest
        |
        v
One validation and lowering plan per Agent Adapter
        |
        v
Shared publisher: compare, commit, and roll back
```

The exact Package closure is the authoritative input. The lock records the canonical schema revision and digest, not a
second independently authoritative copy of the expanded canonical closure. Recreation and bundle import recompute the
canonical closure from exact Package bytes and reject a digest mismatch.

An Adapter chooses a strategy per artifact. One Agent may use directory discovery for Skills, an independent overlay for
MCP servers, and owned fields in a mixed configuration file for Hooks.

The shared publisher owns staging, optimistic input comparison, atomic replacement or generation switching, mode
preservation, rollback, and ownership metadata. Adapters parse and render native formats but do not independently implement
transaction or locking behavior.

Immutable Woma-owned artifacts and dedicated overlays may use generation publication. Mixed-ownership or Agent-owned files
remain real files in the stable Agent home and are reconciled in place. Woma removes or replaces a previously projected
native entry only when its observed canonical value or digest still matches the ownership record. Otherwise it reports a
conflict and preserves the file.

## Package install methods

An Agent may install or update a Skill, MCP server, Hook, or supported Plugin while it is running. Woma treats a recognized
native installation as a delayed `woma install`, not as an indefinitely unmanaged `external` capability.

An Environment's direct Package root records one installation property with two values:

```yaml
installMethod: woma-install  # installed by an explicit Woma command
installMethod: agent-install # captured from an Agent-native installation
```

`installMethod` belongs to the Environment root record, not the Package manifest or immutable Package bytes. The same
Package may use a different installation method in another Environment, and transitive dependencies do not pretend to have
been installed directly by either entrypoint. `installerAgent` is required only for `agent-install`; Package `source` and
content provenance remain separate fields. `installerAgent` is forbidden for `woma-install`.

Once capture succeeds, an `agent-install` root is an ordinary immutable Woma Package root in the Environment recipe, lock,
Package Store, projection, inventory, and bundle. Both install methods use the same source normalization, canonical
validation, collision detection, publication, and rollback path.

Woma does not watch native homes or proxy Agent executables. Capture therefore occurs at the beginning of the next explicit:

```bash
woma activate <environment>
```

Until that boundary, a native installation is visible only to the Agent home in which it was written. Re-running
`woma activate` for the already selected Environment is a valid reconciliation operation. Static shell startup code does
not perform capture; it remains bounded and read-only.

### Capture transaction

Before exporting the selected Environment, activation performs the following operation under the Environment lock:

1. Load the last exact lock, projection ownership records, and per-Agent native capability surfaces.
2. Separate unchanged projections, projection drift, new native installations, updates to an `agent-install` lineage, and
   opaque state.
3. Read a candidate through the originating Agent Adapter and normalize it through a Woma source Adapter.
4. Reject literal secrets, unstable input, invalid metadata, unsupported semantics, and ownership ambiguity.
5. Snapshot accepted content into immutable Package Store entries.
6. Resolve the new Package closure and validate it against every selected Agent Adapter.
7. Stage all Agent projections and stable-file reconciliations.
8. Atomically publish the recipe, lock, ownership records, and projections, or leave the previous managed state intact.

If an Agent process for that home is still running, Woma does not claim a stable capture. It leaves the candidate pending,
preserves its native files, reports that reconciliation was deferred, and activates the last committed managed closure.
Digest comparison immediately before publication detects changes during capture; it cannot prevent an external process from
writing again after publication, so later activation or `doctor` must report resulting drift.

### Package identity and provenance

The root and lock records capture at least:

- `installMethod: agent-install` and the `installerAgent`;
- the stable native resource identity;
- capture time, content integrity, and immutable Store key;
- the Package and canonical resource identities; and
- whether the source is recipe-retrievable or snapshot-only.

When trustworthy native metadata provides an exact Package name and SemVer, Woma preserves it. Otherwise Woma derives a
validated name from the canonical resource identity and uses a generated pre-release such as
`0.0.0-agent.<content-digest>`. A generated version does not satisfy ordinary semantic dependency ranges.

Snapshot-only roots can be recreated while their immutable Store entry is available and are byte-complete in an
Environment bundle. A portable recipe alone cannot recreate them on another machine; Woma must report that boundary rather
than invent an upstream source.

### Update, removal, and conflicts

An ownership record identifies the `installerAgent` that originated an `agent-install` lineage:

- a stable update from that origin Agent creates a new immutable revision and replaces the Environment root transactionally;
- removal from that origin Agent is the delayed equivalent of `woma remove` for that root;
- mutation or removal from another Agent is projection drift, not global update or uninstall;
- mutation of a `woma-install` projection is a conflict, not an implicit change of installation method or source;
- independently installed identical canonical content is deduplicated; and
- the same identity with different content is a conflict and never uses last-writer-wins behavior.

Literal credential values never enter generated manifests, locks, logs, or bundles. A capturable MCP server must express
secrets through declared environment requirements or another non-literal secret reference. Unsupported native resources
remain in their origin home with a visible `capture-blocked` diagnostic; Woma does not silently package opaque bytes or
pretend they were shared.

## Recipe, lock, and bundle

Woma keeps three artifacts separate, following Conda's distinction between a human-authored Environment file, an exact
platform specification, and a portable archive.

### Environment recipe

`environment.woma.yaml` contains:

- one or more Agent identities and version constraints;
- direct capability Package requirements and sources;
- direct Package roots, their `installMethod`, and their source boundary;
- public requirement names, never secret values; and
- optional Environment metadata.

It does not enumerate transitive dependencies or copy mutable Agent home state.

### Environment lock

`environment.woma.lock.json` is machine-generated and host-platform-specific. It records every exact Runtime Package, the
exact recursive capability Package closure and provenance, the canonical schema revision and digest, and enough projection
ownership identity to rebuild and reconcile managed state.

For example, Agent runtimes are a sibling map of the capability closure:

```json
{
  "lockfileVersion": 2,
  "agents": {
    "codex": {
      "version": "0.1.2",
      "provider": "official-release",
      "host": "aarch64-apple-darwin",
      "artifactIntegrity": "sha256:<digest>",
      "cacheKey": "<cache-key>",
      "executable": "bin/codex",
      "adapterRevision": "codex-v1"
    },
    "claude": {
      "version": "1.0.0",
      "provider": "official-release",
      "host": "aarch64-apple-darwin",
      "artifactIntegrity": "sha256:<digest>",
      "cacheKey": "<cache-key>",
      "executable": "bin/claude",
      "adapterRevision": "claude-v1"
    }
  },
  "canonical": {
    "schemaRevision": "capabilities-v1",
    "digest": "sha256:<digest>"
  },
  "packages": {}
}
```

The values are illustrative. Introducing required runtime records changes the lock meaning and requires a new
`lockfileVersion`; old target names cannot be promoted into trusted runtime locks by inspecting ambient executables.

Creation from an exact lock fails if the current Woma version cannot honor every Adapter contract. It never falls back to a
newer ambient Agent binary or silently drops one selected Agent.

### Environment bundle

A complete `.woma-env` bundle includes every locked Agent runtime artifact and every capability Package byte, including
`agent-install` snapshots. If a runtime cannot legally or technically be embedded, Woma must refuse to call the archive a
complete offline bundle; a separately named fetch-dependent format can be designed later.

Runtime artifacts can be much larger than capability Packages. Bundle implementation must stream opaque artifacts and
enforce file-count, compressed-size, decoded-size, and memory limits instead of expanding them through the current
whole-document JSON, Base64, and synchronous gzip path.

Recipes, locks, and bundles exclude credentials, secret values, sessions, caches, databases, and other mutable Agent home
state.

## Environment lifecycle and onboarding

Creation and every Package mutation are one Environment transaction:

1. Parse direct Agent and Package requirements.
2. Resolve every Agent Runtime Package and the recursive capability closure.
3. Validate the canonical closure against every selected Agent Adapter.
4. Materialize and verify immutable artifacts in their managed Stores.
5. Ask every Adapter for a projection plan.
6. Stage all Woma-owned projections and stable-home reconciliations.
7. Publish the recipe, lock, ownership metadata, and projections together.

Activation performs pending `agent-install` capture before selecting all locked runtime entrypoints and Agent homes in the
current shell. `woma run` selects the same snapshot for one child process. Neither command proxies an Agent after launch.

`woma init` remains shell integration only. Installation scripts and non-interactive shell startup do not choose runtimes,
create Environments, or inspect and copy private Agent state.

Interactive first-use onboarding may detect supported Agent CLIs and offer, with explicit confirmation:

```text
base       a clean Environment containing the selected detected Agents
imported   a one-time import from selected existing Agent homes
```

Detection never proves that an executable is official. `base` means initially clean, not permanently immutable; its exact
managed state is recoverable from its lock or bundle. Recognized capabilities imported from original homes enter through
the same Package capture path. Original homes remain unchanged. Credentials, sessions, and other opaque state follow their
separately documented migration or login behavior and are never inferred to be capability Packages.

Environment names do not need an Agent prefix because `woma list` and `woma info` display the selected Agent set. Users may
still create names such as `codex-research` for intentionally single-Agent Environments.

## Reproducibility boundary

Woma guarantees the managed Environment layer:

- exact Agent runtime artifacts for the locked host platform;
- exact capability Package bytes, including captured snapshots;
- canonical closure validation; and
- deterministic native projection for the locked Adapter contracts.

This is not yet a guarantee for the complete command toolchain. MCP commands, Hooks, and `requirements.commands` may still
resolve ambient `node`, `npx`, `git`, shells, libraries, or services unless a future dependency contract locks them. Woma
must describe the narrower guarantee accurately.

Woma also does not reproduce credentials, secret values, sessions, caches, project files, prompts, datasets, remote model
behavior, or results produced by a consumer of the Environment.

## Breaking changes and delivery

This model preserves the useful current multi-target command shape while replacing its unmanaged runtime and shared
writable Skill-root contracts. Because Woma is still in early development, implementation should prefer strict new schemas
and explicit recreation over compatibility branches that manufacture trusted runtime records from target names.

Implementation should be split into independently reviewable changes:

1. Extract canonical capability closure construction and per-Agent Adapter interfaces from view publication, with one shared
   publisher. This boundary and the first new Adapter (OpenCode) are implemented; canonical digesting and removal of Agent and
   platform fields from capability Package manifests remain a separate schema migration.
2. Introduce the multi-runtime recipe and lock, Runtime Provider trust contract, immutable Runtime Store, and Environment
   executable directory.
3. Replace the shared writable Skill root with per-Agent native directories and immutable Package projections.
4. Move mixed-ownership Agent configuration to stable-home reconciliation with ownership digests and conflict detection.
5. Add activation-time Agent capability discovery and the `agent-install` Package capture transaction.
6. Add checked-in recipes and exact-lock creation, extend bundles to runtime and captured Package artifacts, and implement
   explicitly confirmed clean/imported onboarding.

A step must not advertise version-pinned runtime reproducibility until step 2 is complete. A step must not advertise
Agent-native installation as an `agent-install` Package root until step 5 publishes it through the normal Package
transaction.

## Acceptance criteria

- Every Environment contains one or more exactly locked Agent Runtime Packages.
- Activation exposes every selected locked executable and selects a separate stable home for every Agent without proxying
  the process.
- No writable native Agent directory is shared across selected Agents.
- Capability Package declarations contain no Agent names, platform lists, native paths, or native configuration fields.
- Every selected Adapter validates the same canonical Package closure before publication.
- The exact Package closure is authoritative; the canonical closure is recomputed and verified by schema revision and digest.
- Every direct Package root records exactly one `installMethod`: `woma-install` or `agent-install`.
- A recognized Agent-native installation is captured on the next explicit activation through the same Package transaction
  as `woma install`, with `installMethod: agent-install` and an `installerAgent`.
- Unsupported, secret-bearing, ambiguous, changing, or concurrently active native state is preserved and reported rather
  than silently adopted.
- `agent-install` updates and removals follow installer ownership; other mutations produce drift or conflict.
- Each Adapter produces declarative plans per artifact and the shared publisher owns transaction behavior.
- Runtime Providers verify trusted provenance as well as artifact integrity.
- Recipe recreation resolves declared constraints; exact-lock recreation never silently upgrades a runtime or Package.
- A complete bundle contains every redistributable locked runtime and Package snapshot required for offline recreation.
- Documentation limits the reproducibility claim where ambient command dependencies remain unlocked.
- Credentials and mutable opaque Agent state remain isolated and outside recipes, locks, and bundles.
- No benchmark, experiment-matrix, dataset, prompt, or result-management API is added to Woma core.
