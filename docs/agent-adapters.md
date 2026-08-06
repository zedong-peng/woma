# Agent Adapter contract

Woma resolves one locked Package closure into canonical Skills, MCP servers, and Hooks before considering any Agent-native
format. An `AgentAdapter` is the pure boundary that validates that closure for one target and converts it into a declarative
projection plan.

```ts
interface AgentAdapter {
  readonly descriptor: AgentDescriptor;
  artifacts(context: AgentArtifactContext): NativeArtifactContract[];
  validate(input: AgentProjectionInput): ValidationIssue[];
  plan(input: AgentProjectionInput): ProjectionPlan;
  discover(input: AgentProjectionInput): DiscoveryResult;
  diagnose(input: AgentProjectionInput): Diagnostic[];
}
```

The built-in registry currently contains Codex, Claude Code, Pi, Qoder CLI, and OpenCode. Source normalization is a separate
interface: a Source Adapter turns install input into one Woma Package, while an Agent Adapter projects an already resolved
Package closure into an Agent harness.

## Ownership boundary

An Agent Adapter may:

- describe known native artifacts and their ordered baseline sources;
- declare a stable identity, contract revision, CLI metadata, supported capability strategies, and Environment variables;
- parse an immutable artifact snapshot supplied by core;
- validate canonical capabilities and return diagnostics;
- render desired text and resource ownership metadata in a `ProjectionPlan`.

An Agent Adapter must not read or write the filesystem, acquire locks, publish symlinks, rename or remove paths, mutate an
Environment recipe or lock, access credentials, or implement retries and rollback. The shared publisher in `view.ts` owns
those effects. It validates artifact identifiers, relative paths, locations, modes, and the complete MCP plan before any
publication. It then reads every declared artifact, builds one temporary generation, updates stable Agent
homes inside the Environment transaction, atomically switches the view, and rolls back ordinary failures.

```text
locked Package closure
        |
        v
canonicalCapabilities(packages, agent)
        |
        v
AgentAdapter.validate + AgentAdapter.plan       pure
        |
        v
shared view publisher                           filesystem + transaction
        |
        v
Agent-native config and shared Environment Skills
```

The v1 manifest still accepts `spec.platforms` and per-resource `platforms`. The canonical layer is the only compatibility
boundary that interprets those selectors; individual Adapters receive an already filtered capability set. This keeps a
future neutral manifest migration out of every Agent implementation.

## Built-in strategies

| Agent | Skills | MCP | Hooks | Managed artifacts |
| --- | --- | --- | --- | --- |
| Codex | shared symlink | native stable-home TOML (`stdio`, `http`) | native stable-home JSON | `config.toml`, `hooks.json` |
| Claude Code | shared symlink | native stable-home JSON (all v1 transports) | native stable-home JSON | `.credentials.json`, `settings.json`, `.claude.json` MCP fields |
| Pi | shared symlink | unsupported | unsupported | none beyond `skills` |
| Qoder CLI | shared symlink | native stable-home JSON (all v1 transports) | native stable-home JSON | `settings.json` |
| OpenCode | shared symlink | native JSON (`stdio`, `http`, `sse`) | unsupported | `opencode.json` |

Unsupported capabilities fail validation; an Adapter never silently drops them.

## Canonical closure and ownership

Before projection, core can derive the Agent-neutral `capabilities-v1` closure. It contains stable Package, Skill, MCP,
Hook, requirement, and entrypoint identities, sorted canonical arrays, and a `sha256:` closure digest. Platform selectors
are compatibility input to Adapter selection and are not included in the canonical resource values. The exact Package
bytes remain authoritative; the closure is recomputed and its digest is never treated as a second mutable lock.

Each declarative projection may publish ownership records containing the canonical capability identity, Package owner,
native locator, and value digest. View metadata stores these records per target so `doctor` and future reconciliation can
distinguish a Woma value from an external same-name value without exposing the native command, environment, or credential
contents. The shared conformance helper checks that plans, discovery, diagnostics, ownership identities, and secret-safe
outputs are deterministic for a fixed snapshot. A new Adapter can run that helper without adding a publisher branch.

Codex `config.toml` and `hooks.json`, Claude `settings.json` and `.claude.json`, and Qoder `settings.json` are regular
files under the selected Environment home. Credentials such as Claude `.credentials.json` are opaque regular files and
never enter a view generation or bundle. During install and removal the publisher reads the current stable file, removes
only a previous Woma value that still matches its last projected value, and merges the new closure while preserving
unknown and Agent-owned fields. A changed Woma-owned value, or a same-name external value with different content, fails
with an ownership conflict and leaves the file unchanged. The publisher also rechecks the observed file immediately before
each atomic replacement to catch writes made by an Agent or editor during preparation.

## OpenCode overlay

For a selected OpenCode target, Woma exports:

```text
OPENCODE_CONFIG=$WOMA_HOME/environments/<environment>/home/opencode/opencode.json
OPENCODE_CONFIG_DIR=$WOMA_HOME/environments/<environment>/home/opencode
```

`opencode.json` contains only the Woma-managed MCP projection. `skills/` links to the Environment's shared Skill directory.
Woma does not override `HOME`, `XDG_CONFIG_HOME`, or `XDG_DATA_HOME`; OpenCode therefore continues to load its documented
global and project configuration, while the Woma file and directory act as higher-priority capability overlays. Provider
authentication, MCP OAuth tokens, sessions, caches, Plugins, and other OpenCode data remain opaque native state and are not
copied into the view, Package Store, lock, or bundle. Because OpenCode exposes no dedicated data-home selector, that ambient
state may be shared across Woma Environments; this Adapter guarantees isolation only for shared Skills and managed MCP.

The Adapter inventories external MCP names from OpenCode's global config directory and an explicitly selected
`OPENCODE_CONFIG` file. Project-local config depends on the directory where OpenCode is launched and is therefore ambient,
not part of a global Environment snapshot; Woma leaves it unchanged but cannot preflight every possible project-local name.

This follows OpenCode's documented [configuration precedence](https://opencode.ai/docs/config/),
[Agent Skill paths](https://opencode.ai/docs/skills/), and [MCP schema](https://opencode.ai/docs/mcp-servers/).

## Adding an Agent

1. Add the Agent identifier to the Environment target schema and register exactly one Adapter.
2. Declare native artifacts, runtime variables, and explicit capability strategies in its descriptor.
3. Implement pure validation and projection from canonical capabilities and supplied snapshots.
4. Add fixture tests for native rendering, unsupported capability failures, stable-home preservation, rollback, doctor, Shell,
   `woma run`, and CLI detection.
5. Document every managed path and classify all remaining Agent paths as opaque.

Built-in registration is static. Loading third-party Adapter code dynamically is not part of the current trust model.
