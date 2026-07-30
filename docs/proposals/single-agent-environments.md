# Reproducible single-Agent environments

Status: proposed

Related discussions: [#65](https://github.com/zedong-peng/woma/issues/65),
[#66](https://github.com/zedong-peng/woma/issues/66), and
[#67](https://github.com/zedong-peng/woma/issues/67).

## Decision

Woma will model an Environment as one versioned Agent runtime plus a resolved closure of Agent-independent capability
Packages:

```text
Environment
|-- one Agent Runtime Package
|-- zero or more capability Packages
|   |-- Skills
|   |-- MCP servers
|   `-- Hooks
`-- one isolated, mutable Agent home
```

The Agent runtime is a distinguished Package. It participates in resolution, storage, locking, export, and recreation, but
it is a singleton because it defines the Environment's executable, native configuration contract, and projection Adapter.
An Environment cannot target several Agents.

"Distinguished Package" describes lifecycle semantics, not the existing capability Package file format. Agent runtimes do
not contain a synthetic `woma.yaml`, do not appear in the capability `packages` map, and do not pretend that an upstream
runtime archive is a Skill source. The Environment recipe and lock each have one required top-level Agent record, while
provider-specific code normalizes the runtime into its own immutable Store contract.

Woma provides the Environment platform. It does not orchestrate benchmarks, define experiment matrices, manage datasets or
prompts, record run results, or prescribe how an Environment is consumed. A researcher can use ordinary scripts to create
or select Woma Environments in the same way that research scripts use Conda Environments.

## Motivation

The current Environment recipe records one or more target Agent names while the corresponding executables are discovered
from the ambient `PATH`. Package locks and Environment bundles therefore reproduce the managed capability closure but do
not reproduce the Agent runtime that interprets it. A machine with a different Codex, Claude Code, Pi, or Qoder CLI version
can materialize the same lock and observe different configuration or capability behavior.

Multiple targets also make one Environment serve two different purposes:

- a reproducible execution environment for one Agent runtime; and
- a cross-Agent sharing area whose resources are projected into several native homes.

The first purpose is the stronger and more familiar Conda-style user model. Sharing one capability recipe across Agents
does not require sharing one mutable Environment. Users can create one Environment per Agent or Agent version from the same
recipe inputs.

## User model

The direct command form selects exactly one Agent requirement:

```bash
woma create --name codex-research --agent codex=0.1.2
woma install --name codex-research gh:owner/research-capabilities#v1.2.0
woma activate codex-research
codex
```

`woma run` remains a general equivalent of `conda run`; it is not a benchmark runner:

```bash
woma run --name codex-research codex exec --help
```

A checked-in Environment recipe recreates the same declared toolchain without embedding experiment workflow:

```yaml
kind: WomaEnvironment
metadata:
  name: codex-research
spec:
  agent:
    name: codex
    version: "=0.1.2"
  packages:
    - name: research-capabilities
      version: "=1.2.0"
      source: gh:owner/research-capabilities
  requirements:
    env:
      - OPENAI_API_KEY
```

The example Agent version is illustrative rather than a statement about an available release. Agent distribution providers,
version discovery, and source syntax must be implemented and tested before the CLI claims that a concrete Agent release is
managed.

## Agent Runtime Packages

An Agent Runtime Package supplies or identifies all managed runtime inputs needed by an Environment:

- Agent identity and exact upstream version;
- immutable source and artifact integrity;
- supported operating system and architecture;
- executable entrypoint exposed through the Environment;
- native Agent home selector, such as `CODEX_HOME`;
- Adapter identity and projection contract revision; and
- semantic capability features supported by that runtime and Adapter combination.

The exact runtime resolution belongs in the Environment lock and the immutable artifact belongs in a Woma-managed store.
Activation prepends the Environment's executable directory to `PATH` and selects its Agent home. Woma must not claim that
an Environment is reproducible while silently executing a same-named binary found earlier on the ambient `PATH`.
Runtime artifacts use a separate namespace such as `$WOMA_HOME/runtimes/<agent>/<cache-key>` rather than the capability
Package Store, whose entries are validated as Woma Package manifests.

Agent distribution sources need provider-specific acquisition code. An npm package, an official release archive, and a
local artifact do not have the same resolution or integrity semantics. Providers normalize those inputs into the Agent
Runtime Package contract; they do not change the Environment model. A local source is snapshotted and verified into the
runtime Store just like a local capability Package; a same-named executable on the ambient `PATH` never satisfies the locked
Agent requirement implicitly.

Projection Adapters initially ship with Woma and are selected by Agent identity. An Agent Package must not inject arbitrary
Adapter code into the Woma process. A future Adapter plugin mechanism requires its own API, trust, and compatibility design.

## Agent-independent capabilities

Package manifests describe capability semantics, not Agent configuration files. They may contain canonical Skills, MCP
servers, Hooks, requirements, and dependencies. They must not contain native destinations such as `config.toml`,
`settings.json`, or an Agent home path.

Agent independence does not imply universal support. A Package states the semantic features its resources require, while an
Agent Runtime Package and Adapter state the features they provide. For example:

```yaml
requires:
  agentFeatures:
    - skills.v1
    - mcp.stdio
    - hooks.after-tool-use
```

The feature vocabulary is versioned Woma domain semantics. Resolution or validation fails before publication when the
selected Agent cannot represent a required feature exactly. Woma does not silently omit a resource or approximate a Hook
whose lifecycle differs from the declared event.

Skills and MCP transports already have useful cross-Agent semantics. Hooks require particular care because similarly named
Agent events may have different timing, matching, retry, input, and failure behavior. Until Woma defines an exact canonical
Hook event, an Adapter-specific Hook is an explicit extension rather than a falsely portable declaration.

Agent names may remain in compatibility metadata where a real upstream constraint cannot be expressed as a semantic
feature. They are constraints, not projection instructions.

The singleton rule applies to an Environment, not to a reusable capability Package. Package `spec.platforms` and per-resource
platform compatibility can remain lists so the same Package can be installed into separate Codex, Claude Code, Pi, or Qoder
Environments. Semantic feature requirements may refine or eventually replace particular platform checks, but the
Environment's scalar Agent must not force Package compatibility metadata to become scalar.

## Projection architecture

Projection has three layers:

```text
Package manifests and exact lock
              |
              v
Canonical capability closure
              |
              v
Agent Adapter: validate and lower
              |
              v
Projection plan
              |
              v
Shared publisher: compare, commit, and roll back
```

### Canonical closure

The closure layer resolves Package ownership, dependencies, resource identities, and conflicts without rendering an Agent
schema. Two Package resources are compared in canonical form. Their equality must not depend on whether a Codex or Claude
renderer happened to run first.

### Agent Adapter

The selected Adapter:

- validates the closure against the locked Agent feature set;
- lowers canonical resources into native Agent values;
- inspects relevant native configuration without claiming opaque state;
- identifies native conflicts with external capability; and
- returns a declarative projection plan.

An Adapter selects a projection strategy per artifact, not once for the whole Agent. One Agent may use directory discovery
for Skills, an independent overlay for MCP servers, and owned fragments in a mixed configuration file for Hooks.

### Shared publisher

The publisher owns filesystem transaction behavior shared by all Adapters:

- staging and pre-publication validation;
- optimistic input comparison for mixed-ownership files;
- atomic replacement or generation switching;
- mode preservation;
- rollback of ordinary failures; and
- ownership metadata publication.

Adapters parse and render native formats, but they do not independently implement locking, retry, rollback, or generation
lifecycle.

Immutable Woma-owned artifacts, including Package Skill links and dedicated overlay files, may continue to use an atomic
generation. Mixed-ownership or Agent-owned files remain real files in the stable Agent home and are reconciled in place.
Generation is therefore one publication primitive, not the ownership model for every projected artifact.

## Ownership and external state

The effective Environment retains three ownership classes:

```text
Effective Environment
|-- Woma-managed Agent runtime and capability closure
|-- Environment-local external capability
`-- opaque Agent state
```

Agent-created Skills, MCP servers, and Hooks may be observable as Environment-local external capability without entering
the recipe, lock, Package Store, or bundle. Credentials, sessions, databases, caches, provider state, and unknown files are
opaque. Woma isolates them in the Environment home but does not interpret or reproduce them.

Projection ownership records must contain more than resource names. For every managed native entry they record at least:

- Agent and capability kind;
- canonical resource identity and Package owner;
- native destination or locator; and
- the canonical native value or its stable digest.

Woma removes or replaces an old native entry only when the observed value still equals the value Woma previously projected.
A modified owned entry or a different external entry with the same identity is an ownership conflict. Equality does not
implicitly adopt external state into a Package.

## Recipe, lock, and bundle

Woma keeps three artifacts separate, following Conda's distinction between an
[Environment file](https://docs.conda.io/projects/conda/en/latest/user-guide/tasks/manage-environments.html#creating-an-environment-from-an-environment-yml-file),
an [exact platform specification](https://docs.conda.io/projects/conda/en/latest/user-guide/tasks/manage-environments.html#explicit-spec-files),
and a portable artifact archive.

### Environment recipe

`environment.woma.yaml` is human-authored and portable. It contains:

- one Agent identity and version constraint;
- direct capability Package requirements and sources;
- public requirement names, never secret values; and
- optional Environment metadata.

It does not enumerate transitive dependencies or copy mutable Agent home state. The same capability inputs can be reused in
recipes selecting another Agent, subject to feature compatibility.

### Environment lock

`environment.woma.lock.json` is machine-generated and target-platform-specific. It records:

- the exact Agent distribution, artifact integrity, platform, executable, and Adapter contract revision;
- the exact recursive capability Package closure and provenance;
- the canonical feature requirements and selected feature providers; and
- enough ownership identity to deterministically rebuild the Woma-managed projection.

For example, the Agent is a sibling of the capability closure rather than one entry inside it:

```json
{
  "lockfileVersion": 2,
  "agent": {
    "name": "codex",
    "version": "0.1.2",
    "provider": "official-release",
    "host": "aarch64-apple-darwin",
    "artifactIntegrity": "sha256:<digest>",
    "cacheKey": "<cache-key>",
    "executable": "bin/codex",
    "adapterRevision": "codex-v1"
  },
  "packages": {}
}
```

The values are illustrative. A provider contract defines the real upstream identity, supported host triples, and integrity
format before implementation accepts them.

Creation from an exact lock fails if the current Woma version cannot honor its Adapter contract. It never falls back to a
newer ambient Agent binary.

The Agent record is required at the lock root and remains separate from the capability `packages` map. Introducing this
record changes the lock meaning and requires a new `lockfileVersion`; it is not an optional field added to version 1.

### Environment bundle

The existing `.woma-env` bundle remains the byte-complete offline form. A complete bundle includes the locked Agent runtime
artifact as well as all capability Package content. If an Agent distribution cannot be redistributed or embedded, Woma
must refuse to describe the resulting archive as a complete offline bundle; an explicitly named fetch-dependent export
format can be designed separately.

Agent runtime artifacts can be much larger than capability Packages. Bundle implementation must stream or otherwise store
opaque runtime artifacts without expanding them through the current whole-document JSON, Base64, and synchronous gzip
path. Bundle file-count, compressed-size, decoded-size, and memory limits must be reviewed against each supported runtime
provider before runtime bundling is enabled.

Recipes, locks, and bundles exclude secret values and mutable Agent home state.
Adding a required Agent artifact also requires a new bundle format identifier. An old capability-only bundle cannot be
accepted as a single-Agent runtime bundle by filling in an Agent from the destination machine.

## Environment lifecycle

Creation is one transaction:

1. Parse the direct Agent and capability requirements.
2. Resolve exactly one Agent Runtime Package and the recursive capability closure.
3. Validate platform compatibility and semantic feature requirements.
4. Materialize and verify immutable artifacts in Woma-managed stores.
5. Ask the selected Adapter for a complete projection plan.
6. Stage and validate Woma-owned projection artifacts.
7. Publish the recipe, lock, stable-home reconciliation, and immutable generation within the Environment transaction.

Install, update, and remove repeat resolution against the same singleton Agent requirement. Removing the Agent without
replacing it is invalid. Updating the Agent can change its feature set or Adapter contract and therefore revalidates the
complete capability closure.

Activation and `woma run` select only the locked Agent's executable and home. Other installed Agent CLIs keep their original
homes.

The implicit Codex-and-Claude `base` Environment is removed. A user may explicitly create an Environment named `base`, but
it follows the same one-Agent invariant and has no special unmanaged runtime. `woma init` remains read-only and never chooses
or downloads an Agent. A command that needs an Environment fails with an actionable selection error when neither `--name`
nor an active Environment identifies one; it does not silently initialize a runtime or fall back to `base`.

## Reproducibility boundary

Woma guarantees the reproducibility of its managed Environment layer: Agent runtime resolution, capability Package closure,
and deterministic native projection for the locked platform and Adapter contract.

Woma does not claim to reproduce:

- credentials or secret values;
- sessions, caches, and Agent-created external capability;
- project files, prompts, datasets, or benchmark scripts;
- model provider behavior or mutable remote model implementations; or
- results produced by a consumer of the Environment.

Users obtain a clean managed layer by creating a new Environment from a recipe, exact lock, or complete bundle. Woma does
not add benchmark-specific clean-run or provenance commands.

## Breaking changes and delivery

This model intentionally replaces the current multi-target Environment contract. Because Woma is still in early
development, implementation should prefer strict new schemas and explicit recreation over long-lived compatibility branches.
Existing mutable Agent state remains outside automatic migration unless a dedicated migration command documents it.

Implementation should be split into independently reviewable changes:

1. Extract canonical capability closure construction and per-Agent Adapter interfaces from view materialization without
   changing public behavior.
2. Introduce the singleton Agent requirement in Environment recipes and remove multi-target `both`, `all`, and target-list
   semantics, including implicit multi-Agent `base` creation and fallback.
3. Add Agent distribution providers, immutable runtime storage, exact runtime locks, and Environment executable selection.
4. Add checked-in recipe and exact-lock creation while extending `.woma-env` bundles to the Agent runtime.
5. Move mixed-ownership Agent configuration to stable-home reconciliation with ownership digests and conflict detection.

A step must not advertise version-pinned Agent reproducibility until step 3 is complete. In particular, renaming `target` to
`agent` while still launching the ambient executable is an internal migration step, not completion of this proposal.

## Acceptance criteria

- Every Environment contains exactly one locked Agent Runtime Package.
- The lock records the Agent at its root and uses a new version; capability Packages retain their separate closure.
- The executable launched after activation or by `woma run` resolves from that Environment, not an unrelated ambient path.
- Package declarations remain free of native Agent paths and configuration field names.
- Unsupported capability semantics fail before Environment publication.
- Each Agent Adapter produces plans per artifact and does not own transaction implementation.
- Recipe recreation resolves declared constraints; exact-lock recreation never silently upgrades the Agent or a capability
  Package.
- A complete bundle recreates the managed Agent runtime and capability closure without its original sources.
- Credentials and mutable Agent state remain isolated but outside recipes, locks, and bundles.
- No benchmark, experiment-matrix, dataset, prompt, or result-management API is added to Woma core.
