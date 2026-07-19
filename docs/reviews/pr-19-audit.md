# PR #19 release-readiness audit

Audit date: 2026-07-20  
Audited head: `5ab1a98` (`feat/global-environments`)  
Comparison base: `main`  
Scope: CLI and shell integration, global Environment and Package storage, Agent views, runtime sharing, Project Memory, dependency validation, concurrency, transactions, recovery, security boundaries, tests, and documentation contracts.

## Verdict

PR #19 is not ready to merge. The audit found 15 confirmed defects:

- 5 P1 defects that can corrupt shared state, select the wrong Environment, expose a mixed dependency closure, or leave `base` unrecoverable;
- 8 P2 correctness and isolation defects;
- 2 P3 validation defects.

The existing `check` and `test` workflows pass, but they do not exercise the failure and concurrency paths below.

## Remediation update

All 15 findings were addressed on `feat/global-environments` after the audited `5ab1a98` snapshot. The remediation adds read-only Package publication, atomic view generations, reachable base repair, strict shell selection, activation lock/rollback coverage, authoritative Claude runtime state, reconstructable MCP ownership, reserved foundational identities, canonical project locks, exact Skill visibility validation, corrected Memory instructions, and stricter Package validation.

Each finding now has a regression test in the corresponding Package, Environment, view, shell, concurrency, or schema suite. The original findings remain below as the rationale and acceptance criteria. Final merge still requires the complete release gate and a clean review of the remediation diff.

## Severity definition

| Level | Meaning |
| --- | --- |
| P1 | Merge blocker: shared-state corruption, data loss, broken recovery, incorrect Environment selection, or a violation of the core isolation model. |
| P2 | Important correctness defect: stale state, incomplete transaction behavior, misleading foundational behavior, or a realistic concurrency failure. |
| P3 | Validation or diagnostics defect that should be fixed before the public package format is frozen. |

## Findings summary

| ID | Severity | Finding |
| --- | --- | --- |
| PR19-01 | P1 | Package Store contents are writable through every Skill view and are therefore not immutable. |
| PR19-02 | P1 | A damaged `base` cannot be repaired with `harness sync -n base`. |
| PR19-03 | P1 | The shell wrapper mistakes arbitrary arguments and help requests for activation commands. |
| PR19-04 | P1 | A global Agent view is replaced path by path, so Agent processes can observe a mixed dependency closure. |
| PR19-05 | P1 | Activation releases the Environment lock before committing the transition and can successfully select a removed or changed Environment. |
| PR19-06 | P2 | Failed activation can still mutate shared runtime state and the target Claude view. |
| PR19-07 | P2 | Claude runtime transfer cannot propagate field deletion and monotonically accumulates stale state. |
| PR19-08 | P2 | Claude repair depends on intact `view.json` ownership metadata and can become unable to repair MCP drift. |
| PR19-09 | P2 | Reserved foundational Packages can be replaced by arbitrary user Packages with the same names. |
| PR19-10 | P2 | Project locks use lexical paths, so symlink aliases bypass activation serialization. |
| PR19-11 | P2 | View validation accepts undeclared extra Skills and does not enforce the locked visibility closure. |
| PR19-12 | P2 | The Project Memory Skill tells Agents that nested-directory discovery works even though parent lookup was intentionally removed. |
| PR19-13 | P2 | A stale or nonexistent inherited `HARNESS_ENV` produces a phantom active Environment during shell initialization. |
| PR19-14 | P3 | MCP resource targets are not required to be a subset of Package platforms. |
| PR19-15 | P3 | Package validation does not validate Skill metadata and uses an incomplete SemVer check for Package versions. |

## Confirmed defects

### PR19-01: Package Store contents are writable through Skill views

Severity: P1

Evidence:

- `src/package.ts:226-231` copies source contents into the cache without making the result read-only.
- `src/view.ts:225-240` creates direct Skill-directory symlinks into those cache entries.
- The design and README call these entries immutable.
- A locally materialized built-in Package had mode `664` on `SKILL.md`, so the current user and group could write it.

An edit through `$CODEX_HOME/skills/<skill>/...` or `$CLAUDE_CONFIG_DIR/skills/<skill>/...` edits the shared content-addressed entry itself. Every Environment referencing that cache key is corrupted at once. The next integrity check then prevents normal Environment operations.

Required fix:

1. Publish Package entries through a temporary directory.
2. Validate and hash them.
3. Recursively remove write permission before exposing them.
4. Atomically publish the immutable entry.
5. Ensure repair temporarily restores or replaces permissions safely.

Required regression tests:

- A write through one Environment view must fail and must not alter another Environment.
- A Package script cannot mutate its own cached Skill files.
- Cache repair correctly replaces a read-only corrupt entry.

### PR19-02: `base` repair is blocked by `base` validation

Severity: P1

Evidence:

- `src/environment.ts:299-313` accepts an existing `base` only after validating its lock, Package cache, and complete view.
- `src/environment.ts:569-579` calls `ensureBaseEnvironment()` before `syncEnvironment()` can restore Packages or rebuild the view.

Reproduction:

```bash
rm -rf "$HARNESS_HOME/environments/base/view"
harness sync -n base
```

Observed result:

```text
harness: The base Environment is incomplete or corrupt:
Environment view is missing or stale at .../base/view;
run harness sync --name base
```

The suggested repair command is rejected by the same precondition. A missing or corrupt Package cache produces the same dead end.

Required fix:

- Split `ensureBaseEnvironment()` into initialization and strict-use validation.
- `sync -n base` should require a parseable recipe and lock, then repair the Package closure and rebuild the view without first requiring either to be healthy.
- A missing/unparseable lock should remain an explicit unrecoverable error until a transaction journal or lock reconstruction mechanism exists.

Required regression tests:

- Repair a missing base view.
- Repair one corrupt foundational Package cache entry.
- Diagnose, without destructive changes, a missing base lock.

### PR19-03: The shell wrapper misparses commands and help

Severity: P1

Evidence:

- `src/shell.ts:46-63` scans every argument for the literal tokens `activate` and `deactivate`.
- It updates the parent shell after any successful command, including Commander help output.

Incorrectly stateful examples:

```bash
harness activate research --help
harness help activate
harness inspect activate
harness env create activate
harness install deactivate
```

The first two are read-only help requests. The remaining commands use legal values that happen to equal command names. All can unexpectedly alter `HARNESS_ENV`; a later install may consequently target the wrong Environment.

Required fix:

- Parse only the actual top-level command position after recognized global options.
- Never apply a shell transition for `help`, `-h`, or `--help`.
- Prefer an explicit machine-readable activation result from the CLI over duplicating Commander parsing in shell code.

Required regression tests:

- Bash and zsh tests for all examples above.
- Global options before and after the command.
- `--project=<path>` and `--project <path>`.
- Environment names equal to other command names.

### PR19-04: Global view replacement is not observer-atomic

Severity: P1

Evidence:

- `src/view.ts:456-486` replaces `view.json`, Skill directories, MCP configuration, and Hook configuration through separate renames.
- Agent processes do not acquire Harness Environment locks when starting or reading Skills.

During an install or sync, an Agent can observe any intermediate combination, for example:

- new `view.json` with old Skills;
- new Skills with old MCP and Hooks;
- a temporarily missing `skills` directory between the old-path and new-path rename;
- Codex updated while Claude remains old.

The code has rollback atomicity for ordinary writer errors, but it does not provide atomic visibility to readers. This contradicts the advertised complete global Environment view.

Required fix:

- Build an entire immutable versioned view.
- Publish it with one atomic pointer/directory switch.
- Keep mutable shared runtime paths outside the immutable view or attach them after publication through stable indirection.
- Make `CODEX_HOME` and `CLAUDE_CONFIG_DIR` resolve through a stable Environment pointer.

Required regression tests:

- Continuously read all view resources while repeatedly upgrading an Environment; every observation must correspond entirely to the old or new closure.
- Verify there is no interval in which a supported target loses its Skill directory.

### PR19-05: Activation races with install, sync, and remove

Severity: P1

Evidence:

- `src/environment.ts:551-557` reads and validates the target under the Environment lock, then releases it.
- `src/environment.ts:558-562` performs the project transition afterward.
- `src/environment.ts:338-344` can then remove the Environment under a new lock acquisition.

Possible interleaving:

```text
Shell A validates tools and releases the tools lock.
Shell B removes tools.
Shell A initializes Project Memory and reports successful activation.
The shell wrapper exports HARNESS_ENV=tools, but the view no longer exists.
```

An install/sync race can likewise make the success output describe the old closure while the shell selects the new closure.

Required fix:

- Hold the target Environment lock through the complete activation commit, or introduce a generation token that is revalidated immediately before success.
- Define and enforce one lock order for Environment, project, and runtime locks.

Required regression tests:

- Deterministic activate/remove interleaving.
- Deterministic activate/install interleaving.
- Activation must either select the validated generation or fail without changing project/shell state.

### PR19-06: Runtime reconciliation is outside activation rollback

Severity: P2

Evidence:

- `src/environment.ts:558-561` calls `reconcileRuntimeState()` before applying the prepared project transition.
- Project rollback covers `.gitignore`, Memory initialization, and discovery files only.
- `src/view.ts:391-418` can update shared runtime files, replace runtime files with symlinks, and transfer Claude state.

If project application subsequently fails, the CLI returns failure and the shell does not switch, but shared runtime and the target Claude view have already changed.

Required fix:

- Complete all fallible project preconditions before runtime mutation.
- Either make runtime reconciliation independently idempotent and explicitly outside activation semantics, or include its changes in the rollback transaction.
- Document the chosen boundary precisely.

Required regression tests:

- Force `.harness` creation failure after runtime preflight.
- Force discovery-file drift between prepare and apply.
- Verify current runtime, shared runtime, and target Claude state remain unchanged on failed activation.

### PR19-07: Claude runtime transfer cannot represent deletion

Severity: P2

Evidence:

- `src/view.ts:373-388` computes `{ ...target, ...runtime }` after removing only `mcpServers` from the source.

Fields added or changed in the source propagate. Fields deleted in the source remain in the target. Repeated A-to-B-to-A switching therefore accumulates the union of stale fields and can reintroduce deleted state.

Required fix:

- Define the exact set of Claude runtime-owned fields.
- Store one authoritative shared runtime snapshot for those fields.
- Reconstruct the target from authoritative runtime state plus target-owned `mcpServers`, rather than shallow-merging two Environment files.

Required regression tests:

- Propagate field addition, modification, and deletion.
- Preserve target MCP entries while removing source-only MCP entries.
- Repeated switching must converge instead of accumulating fields.

### PR19-08: Claude MCP repair depends on intact view metadata

Severity: P2

Evidence:

- `src/view.ts:518-529` learns previously managed Claude MCP names only from the old `view.json`.
- `buildClaudeView()` begins with the current Environment `.claude.json` and deletes only those recorded names.

If `view.json` is missing or loses `resources.claudeMcpServers`, stale or modified Harness-managed MCP entries in `.claude.json` are treated as user-owned. A changed entry can cause `sync` to reject its own repair as a conflict; a removed Package's entry can survive rebuilding.

Required fix:

- Derive old managed ownership from the locked Package closure or use durable per-entry ownership markers independent of `view.json`.
- A full sync should be able to reconstruct managed Claude state from recipe, lock, Package contents, and the original user baseline.

Required regression tests:

- Delete `view.json`, modify one managed Claude MCP entry, then sync.
- Delete `view.json`, upgrade a Package that removes an MCP entry, then sync.
- Preserve genuine user-owned MCP entries in both cases.

### PR19-09: Foundational Package identities are not reserved

Severity: P2

Evidence:

- `src/environment.ts:428-460` treats an installed root with an existing name as an ordinary root replacement.
- The only foundational invariant is the presence of root names `harness-project-memory` and `meta-skill-builder`.

A local or Git Package can declare one of those names and replace the built-in root. It may omit the expected Skill entirely while the Environment still passes the root-name check. Project discovery then instructs the Agent to use a nonexistent or attacker-controlled foundational Skill.

Required fix:

- Reserve foundational Package names and accepted sources, or validate a signed/owned identity and required Skill contract.
- Provide an explicit, separately reviewed upgrade mechanism if foundational implementations must be replaceable.

Required regression tests:

- Reject direct installation of a non-built-in Package named `harness-project-memory`.
- Reject the same identity through a dependency.
- Verify both required Skills exist after every Environment mutation.

### PR19-10: Project lock aliases bypass serialization

Severity: P2

Evidence:

- `src/environment-lock.ts:117-121` hashes `path.resolve(projectRoot)` rather than the filesystem identity or real path.

The same project accessed through a real path and a directory symlink receives two different project locks. Concurrent activations can then edit the same `.gitignore`, `.harness`, `AGENTS.md`, and `CLAUDE.md` without serialization.

Required fix:

- Resolve an existing project root with `realpath()` before deriving the lock key.
- Define a safe fallback for a nonexistent explicit project path.

Required regression tests:

- Activate concurrently through a real path and a symlink alias and prove both operations use one lock.

### PR19-11: View validation accepts undeclared extra Skills

Severity: P2

Evidence:

- `src/view.ts:552-575` verifies that every expected Skill link exists and points to the right cache entry.
- It does not reject additional entries under a target's `skills/` directory or validate `view.json.skills` against the expected ownership map.

An extra user-created or malicious Skill remains visible to the Agent while `doctor` reports the view healthy. This violates the Environment lock's visibility closure and weakens isolation diagnostics.

Required fix:

- Compare the exact set of Skill directory entries and ownership metadata with the resolved closure.
- Reject non-symlink entries and unexpected symlinks.

Required regression tests:

- Add an undeclared Skill directory and symlink; `doctor` must fail.
- Rebuild/sync must remove the drift without touching user configuration outside managed paths.

### PR19-12: Project Memory's nested-directory instruction is false

Severity: P2

Evidence:

- `examples/harness-project-memory/skills/harness-project-memory/SKILL.md:12` says to run `harness info --json` from the project or a nested directory.
- PR #19 intentionally removed parent-directory discovery. `projectRoot()` resolves the exact current working directory unless `--project` is passed.
- `docs/project-memory.md` documents the exact-directory behavior correctly.

From `project/src/`, the Skill receives `project/src/.harness/...` paths and can create fragmented Memory under a nested directory instead of reading `project/.harness/...`.

Required fix:

- Tell the Skill to run from the intended project root, or pass `--project <root>` when operating from a nested directory.
- Do not reintroduce parent search unless the product decision changes.

Required regression tests:

- A Skill invocation from a nested directory must use an explicit project root and return the intended Memory paths.

### PR19-13: Shell initialization accepts a phantom Environment

Severity: P2

Evidence:

- `src/shell.ts:26-43` validates only the syntax of an Environment name.
- It exports `HARNESS_ENV` even when the Environment recipe/view does not exist.
- If target Skill directories are absent, it silently restores original Agent homes while the prompt still displays the nonexistent Environment.

This occurs with a stale inherited `HARNESS_ENV`, an Environment removed from another shell, or a manually assigned valid-looking name. The prompt and `HARNESS_ENV` claim one Environment while both Agents use another configuration.

Required fix:

- Validate the Environment recipe and at least one complete target view before exporting the selection.
- On shell startup, either fall back to `base` with a concise warning or leave the previous valid selection unchanged.
- Activation of a missing Environment must never update the parent shell.

Required regression tests:

- Start a shell with nonexistent `HARNESS_ENV`.
- Remove the selected Environment from another process and re-source the hook.
- Verify prompt, `HARNESS_ENV`, and Agent homes always agree.

### PR19-14: MCP target subsets are not validated

Severity: P3

Evidence:

- `src/schema.ts:17-35` allows every MCP server to declare its own `platforms`.
- `src/package.ts:130-175` validates Skill and entrypoint structure.
- Hook targets are checked against Package platforms later in `validatePackage()`, but MCP targets are not.

A Package declared for `[codex]` can contain an MCP resource declared only for `[claude]`. The Package validates and installs, but the resource can never become visible in a valid Environment for that Package.

Required fix:

- Require every MCP resource platform to be contained in `spec.platforms`, matching Hook validation.
- Reject duplicate platform values.

Required regression tests:

- Reject out-of-Package MCP targets for stdio and remote transports.

### PR19-15: Skill metadata and SemVer validation are incomplete

Severity: P3

Evidence:

- `src/package.ts:133-157` checks that `SKILL.md` exists but does not parse its frontmatter or confirm its declared name matches the manifest Skill name.
- `src/schema.ts:45` uses a custom Package-version regex instead of SemVer validation. It rejects valid build metadata and can accept malformed prerelease forms.

An install can therefore succeed while Codex or Claude rejects or misidentifies the Skill. Package identity can also disagree with the documented SemVer contract.

Required fix:

- Parse required Skill frontmatter during Package validation and match its name to the manifest entry.
- Use the SemVer library's `valid()` function for Package versions.

Required regression tests:

- Missing/invalid Skill frontmatter.
- Manifest/Skill name mismatch.
- Valid SemVer build metadata and invalid prerelease edge cases.

## Design limitations that are not counted as bugs

These are explicit or intentional limitations in the current design. They still need clear documentation, but they are not included in the 15-defect count:

1. Abrupt process termination and power-loss recovery are outside the ordinary-error transaction guarantee because there is no persistent transaction journal.
2. Harness does not bind Agent session IDs to Environments; users must maintain session/Environment consistency.
3. An Environment can be removed while another shell or already-running Agent is using it because there is no cross-shell usage registry.
4. Existing user baseline MCP servers and Hooks are merged into Environment views, so isolation applies to Harness-managed resources rather than the entire original Agent configuration.
5. Already-running Agents may retain startup-time Skill discovery after an Environment update and may require restart.
6. Local `file:` Package sources are development-only and cannot necessarily restore a historical lock after the source directory changes.

## Required fix order

### Phase 1: restore core invariants

1. PR19-01: make the Package Store actually immutable.
2. PR19-02: make base repair reachable.
3. PR19-03 and PR19-13: replace shell argument guessing and reject phantom selections.
4. PR19-04: publish one complete Agent view atomically.
5. PR19-05 and PR19-10: close activation and project-lock races.

### Phase 2: make runtime and recovery deterministic

1. PR19-06: define and enforce activation's runtime transaction boundary.
2. PR19-07: replace Claude shallow-union state transfer.
3. PR19-08: make Claude managed-resource ownership reconstructable.
4. PR19-09: protect foundational Package identity.
5. PR19-11: validate the exact Skill visibility closure.

### Phase 3: freeze public contracts only after validation is complete

1. PR19-12: correct Project Memory root instructions.
2. PR19-14: validate resource platform subsets.
3. PR19-15: validate Skill metadata and real SemVer.

## Minimum release gate

PR #19 should not be considered ready until all P1 and P2 findings are fixed and regression-tested. Before merge, run:

```bash
npm run check
npm test
bash scripts/demo.sh
npm run benchmark
npm pack --dry-run --json
git diff --check
```

The concurrency suite must additionally include deterministic barriers for view publication, activate/remove, activate/install, project symlink aliases, Package Store mutation, and failed activation after runtime preflight. Timing-only tests with sleeps are insufficient for these guarantees.
