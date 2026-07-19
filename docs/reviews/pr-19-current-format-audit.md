# PR #19 current-format final audit

Audit date: 2026-07-20  
Audited head: `c8a59c6` (`feat/global-environments`)  
Comparison base: `main`

Remediation status updated: 2026-07-20 on `feat/global-environments`. The audit scope is frozen at the 14 findings below; this document does not claim that the unreleased project is defect-free outside that scope.

## Scope

This audit starts from a fresh, empty `$HARNESS_HOME`. It deliberately excludes every pre-release compatibility concern:

- no migration of old Package cache entries or integrity values;
- no migration of old Environment locks;
- no conversion of an old directory-form `view/` into a generation symlink;
- no guarantee that development data produced by an earlier unreleased commit remains usable.

The findings below are reproducible or structurally present in the current format itself. They cover Package repair, runtime sharing, view publication, shell behavior, authoring commands, diagnostics, and security boundaries.

## Verdict

The current-format audit found 14 confirmed defects. All 14 have now been remediated with regression coverage:

- 5 P1 merge blockers involving data loss, shared-runtime corruption, or silent overwrite;
- 8 P2 correctness, atomicity, diagnostics, or security defects;
- 1 P3 cleanup defect.

The expanded tests cover failed source recovery, observer-safe cache replacement, binary runtime data, inactive Environment isolation, publication barriers, both binary names, corrupt-layer diagnostics, authoring rollback, option-like Git inputs, exact MCP/Hook closure validation, and publication artifact cleanup.

## Findings summary

| ID | Severity | Status | Remediation |
| --- | --- | --- | --- |
| CF-01 | P1 | Fixed | Replacement Packages are staged, made read-only, and fully validated before the cache pointer changes. |
| CF-02 | P2 | Fixed | Cache keys are stable symlink pointers to immutable generations; old generations remain readable. |
| CF-03 | P1 | Fixed | Runtime adoption uses byte-preserving atomic writes and retains file modes. |
| CF-04 | P1 | Fixed | Only the shell-selected Environment may contribute runtime state during materialization. |
| CF-05 | P1 | Fixed | Retired view generations are retained and reconciled; a second pre-publication adoption closes the tested race window. |
| CF-06 | P1 | Fixed | `init` preflights non-empty destinations, stages the complete scaffold, and rolls back partial publication. |
| CF-07 | P2 | Fixed | Runtime links must target the exact shared runtime path; unrelated targets are rejected without access. |
| CF-08 | P2 | Fixed | Metadata commits under the Environment lock before the view pointer changes and is rolled back on publication failure. |
| CF-09 | P2 | Fixed | The shell hook wraps both `harness` and `harness-conda`. |
| CF-10 | P2 | Fixed | Listing tolerates damaged base state and doctor reports recipe, lock, Package, and view failures as checks. |
| CF-11 | P2 | Fixed | `capture` builds and validates a temporary sibling before atomically publishing to a new destination. |
| CF-12 | P2 | Fixed | Option-like/control-character Git locators and refs are rejected; clone uses option termination. |
| CF-13 | P2 | Fixed | View metadata and complete baseline-plus-Package MCP/Hook state are compared exactly. |
| CF-14 | P3 | Fixed | Temporary publication and rollback links are removed in `finally` paths. |

## Remediation verification

Regression coverage was added alongside the fixes. The merge gate listed at the end of this document must pass on the remediated head before merge. Abrupt process termination, power-loss recovery, and compatibility with earlier unreleased development data remain explicitly excluded.

## Confirmed defects

### CF-01: `sync` destroys the old cache before replacement validation

Severity: P1

Evidence:

- `src/package.ts:437-445` catches any cache validation error and immediately removes `expectedRoot`.
- Only afterward, at `src/package.ts:448-465`, does it fetch/materialize and validate the replacement.

This fails on a fresh current-format Store when, for example:

- the cache has permission drift but valid locked content;
- a Git remote is temporarily unavailable;
- a local `file:` source has changed or disappeared;
- replacement validation finds an identity, revision, or integrity mismatch.

The last locally available locked artifact is deleted even though sync ultimately fails.

Required fix:

1. Materialize the replacement into a temporary location without touching `expectedRoot`.
2. Validate identity, version, revision, integrity, manifest, Skill metadata, and read-only permissions.
3. Atomically exchange/publish the validated replacement.
4. Preserve the old entry on every pre-publication error.

Required tests:

- Network/materialization failure preserves the old cache.
- Drifted `file:` source preserves the old cache.
- Identity and integrity mismatch preserve the old cache.

### CF-02: Cache repair is not observer-atomic

Severity: P2

Evidence:

- Every Environment Skill is a direct symlink into `$HARNESS_HOME/packages/<name>/<cacheKey>/...`.
- `syncLockedPackage()` removes that cache root before `populateCache()` publishes a replacement.

During the gap, every Environment sharing the Package has dangling Skill links. Permission-only drift is enough to trigger this outage even when Package content is still correct.

Required fix:

- Stage the replacement first and switch through an atomic indirection or directory exchange.
- Readers must observe the old or repaired entry, never a missing cache path.

Required test:

- Continuously read a Skill through two Environment views while repair runs; no read may observe `ENOENT` or mixed content.

### CF-03: Runtime adoption corrupts binary files

Severity: P1

Evidence:

- `src/view.ts:211-242` adopts every non-managed ordinary runtime file.
- `src/view.ts:230-233` uses `readFile(viewPath, "utf8")` followed by text output.

SQLite databases, indexes, compressed files, protobuf data, or any byte sequence containing invalid UTF-8 can be silently changed by decode/re-encode. The current test fixture named `runtime-created.db` contains plain text and therefore does not detect this.

Required fix:

- Add an atomic Buffer-preserving writer, or use same-filesystem rename/copy without decoding.
- Preserve bytes and file mode exactly.

Required tests:

- Runtime files containing NUL, invalid UTF-8, and random bytes remain byte-identical after activation, install, and sync.

### CF-04: Updating an inactive Environment can overwrite shared runtime

Severity: P1

Evidence:

- `src/view.ts:566-578` unconditionally calls `adoptRuntimeState()` for every target before materializing any Environment.
- Only the special Claude `.claude.json` capture is guarded by `HARNESS_ENV === environment.metadata.name`; generic runtime adoption is not.

Example:

```bash
# Shell currently uses A
harness install -n B some-package
```

If B contains an atomically replaced `auth.json`, `installation_id`, history file, or arbitrary runtime file, B writes that stale state into the global shared runtime immediately used by A.

Required fix:

- Runtime adoption must happen only for the Environment selected in the invoking shell during explicit reconciliation/activation.
- Updating an inactive Environment must build its view from the authoritative shared runtime without reading Environment-local runtime replacements.

Required tests:

- Put different runtime values in A, B, and shared state; install and sync B while A is selected; shared state and A must not change.

### CF-05: Agent writes can be lost between adoption and generation publication

Severity: P1

Evidence:

The materialization sequence is:

1. adopt runtime from the current generation at `src/view.ts:566-578`;
2. build Skills, MCP, Hooks, metadata, and runtime links at `src/view.ts:580-617`;
3. publish the new generation at `src/view.ts:618`;
4. remove the old generation at `src/view.ts:547-550`.

A running Agent does not honor Harness runtime locks. If it atomically replaces a runtime symlink with a file after step 1 but before step 3, that write remains only in the retiring generation and is deleted or orphaned after publication.

Required fix:

- Do not place mutable runtime ownership inside disposable view generations, or retain and reconcile retiring generations before garbage collection.
- Prefer stable runtime paths outside generations with generation views containing only immutable managed configuration.

Required test:

- Use a deterministic publication barrier; replace a runtime file after adoption and before pointer swap; verify the bytes survive and are shared.

### CF-06: `harness init` overwrites an existing Skill

Severity: P1

Evidence:

- `src/scaffold.ts:19` refuses only an existing `harness.yaml`.
- `src/scaffold.ts:47-61` writes `skills/<name>-workflow/SKILL.md` atomically without checking whether it already exists.
- `writeTextAtomic()` replaces the destination on rename.

Running init in a directory with an existing Skill but no manifest silently destroys user content. A failure after writing the manifest can also leave a partial scaffold.

Required fix:

- Preflight every destination path before any write.
- Build the scaffold in a sibling temporary directory and publish only when all target paths are safe.
- Refuse unrelated non-empty destinations unless explicit overwrite behavior is requested.

Required tests:

- Existing Skill, manifest, or unrelated target path remains byte-identical after refusal.
- Injected second-file write failure leaves no manifest or partial scaffold.

### CF-07: Runtime symlinks are accepted without ownership validation

Severity: P2

Evidence:

- `src/view.ts:229` treats every symlink as already reconciled and continues.
- It never checks `readlink()` or `realpath()` against `$HARNESS_HOME/runtime/<platform>`.

A replaced or stale runtime symlink can point to an unrelated file. Activation accepts it without adopting, repairing, or reporting drift. The Agent then reads state outside the intended shared-runtime boundary until a later generation rebuild happens to replace it.

Required fix:

- Validate every runtime link target against the exact expected shared path.
- Repair missing/wrong links only after preserving any legitimate replacement data.

Required test:

- Replace `auth.json` with a link to an unrelated file; activation must reject or repair it without reading/writing the unrelated target.

### CF-08: View publication precedes metadata commit

Severity: P2

Evidence:

- `src/view.ts:530` atomically switches `view` to the new generation.
- `hooks.afterSwap` runs afterward at `src/view.ts:531-545`.
- Environment install uses that callback to commit `lock.json` and `environment.yaml`.

Harness CLI readers are protected by the Environment lock, but direct Codex/Claude readers are not. They can observe and execute the complete new view before the new lock/recipe commit succeeds. If metadata commit fails, the view pointer rolls back, but an Agent may already have consumed the uncommitted generation.

Required fix:

- Define one publication record/generation containing both resolved metadata and Agent views, then atomically switch one Environment pointer.
- The stable recipe, lock, and view observed by all consumers must identify the same generation.

Required test:

- Pause metadata failure after pointer publication and continuously inspect from an external reader; it must never observe an uncommitted generation.

### CF-09: `harness-conda activate` cannot update the parent shell

Severity: P2

Evidence:

- `package.json:6-9` installs both `harness` and `harness-conda` binaries.
- `src/shell.ts:47-76` wraps only the `harness` shell function.

The following command reports success but cannot update `HARNESS_ENV`, `CODEX_HOME`, or `CLAUDE_CONFIG_DIR` in the parent shell:

```bash
harness-conda activate performance
```

Required fix:

- Either wrap both public binary names in the shell hook or remove the unsupported activation alias from `bin`.
- Documentation and error output must use the supported name consistently.

Required tests:

- Parent-shell activation/deactivation through every installed public command name.

### CF-10: Base validation blocks diagnostics

Severity: P2

Evidence:

- `listEnvironments()` strictly calls `ensureBaseEnvironment()` before listing names.
- `doctorEnvironment("base")` also calls strict base initialization before producing structured checks.
- `doctorEnvironmentUnlocked()` reads the recipe outside its diagnostic `try` block at `src/environment.ts:656-667`.

A damaged current-format base prevents `env list` from showing healthy named Environments and prevents `doctor -n base` from reporting which layer failed.

Required fix:

- Separate non-mutating diagnosis/listing from strict activation validation.
- Doctor should convert recipe, lock, cache, and view failures into checks instead of throwing before output.

Required tests:

- Corrupt recipe, lock, Package, and view independently; doctor reports the exact failed layer and list still shows named Environments.

### CF-11: Failed capture leaves a partial package

Severity: P2

Evidence:

- `src/capture.ts:182-183` creates the output directory and copies Skills.
- `src/capture.ts:213` writes the manifest.
- Validation happens only afterward at `src/capture.ts:214`.
- There is no rollback of copied Skills or the new manifest.

An invalid captured Skill, symlink, or manifest relationship returns failure while leaving an output that looks partly usable. Retrying then may fail because the destination now contains generated files.

Required fix:

- Capture into a temporary sibling directory, fully validate it, then publish atomically into an empty destination.
- Preserve any pre-existing destination content on failure.

Required tests:

- Invalid Skill metadata and unsupported symlink leave no generated output.
- Existing unrelated destination content remains unchanged.

### CF-12: Git source arguments are not option-safe

Severity: P2

Evidence:

- `src/package.ts:80` accepts any locator ending in `.git`, including a string beginning with `-`.
- `src/package.ts:107-112` passes the locator directly in Git argv without a `--` separator or leading-option rejection.
- Refs are likewise passed directly to `git fetch` as a positional argument.

An option-looking locator/ref can be interpreted by Git as configuration rather than repository data. `spawn()` prevents shell expansion, but it does not prevent command-line option injection into Git itself.

Required fix:

- Reject locators and refs beginning with `-`, control characters, or empty/ambiguous forms.
- Use Git's option terminator where supported and validate ref syntax explicitly.

Required tests:

- Reject option-like locator and ref values before spawning Git.

### CF-13: Doctor accepts undeclared MCP and Hook drift

Severity: P2

Evidence:

- `validateEnvironmentView()` now validates the exact Skill set.
- MCP and Hook validation checks only that every expected managed entry is present.
- It does not compare the complete generated configuration against the original user baseline plus locked Package resources.

An extra MCP server or Hook inserted directly into an Environment view remains executable while `doctor` can report the view healthy. User-baseline entries are legitimate, but the expected baseline is available from the original Agent homes and can be compared deterministically.

Required fix:

- Reconstruct the complete expected adapter configuration from baseline plus locked resources and compare exact managed/user ownership.
- Validate `view.json.resources` against the resolved closure.

Required tests:

- Add extra Codex/Claude MCP entries and Hooks after materialization; doctor must report drift while preserving genuine baseline entries.

### CF-14: Failed publication can leave temporary link artifacts

Severity: P3

Evidence:

- `src/view.ts:528-530` creates `.view.link-*` before rename.
- Rollback creates `.view.rollback-*` at `src/view.ts:535-538`.
- Failure paths remove the generation but do not always remove those temporary symlinks if rename itself fails.

This does not corrupt the active pointer, but repeated filesystem failures can leave clutter under Environment roots and confuse manual diagnosis.

Required fix:

- Track and remove temporary publication links in `finally` blocks.
- Doctor may warn about orphan generations/links while leaving crash recovery data intact.

Required tests:

- Inject initial rename and rollback rename failures; no `.view.link-*` or `.view.rollback-*` artifact remains.

## Explicitly excluded limitations

The following are not counted as defects in this audit:

1. Compatibility with any `$HARNESS_HOME` created by an earlier unreleased commit.
2. Abrupt process termination and power-loss recovery without a transaction journal.
3. Session-to-Environment binding, which remains user-managed.
4. Another shell removing an Environment currently used elsewhere, because no cross-shell usage registry is planned.
5. Already-running Agents retaining startup-time Skill discovery until restart.
6. User baseline MCP servers and Hooks appearing in every Environment view by design.

## Required fix order

### Phase 1: data preservation

1. CF-01 and CF-02: stage and atomically publish Package repairs.
2. CF-03: make runtime adoption byte-preserving.
3. CF-04: prohibit inactive Environment runtime adoption.
4. CF-05: remove mutable runtime ownership from disposable generations.
5. CF-06: make scaffold creation non-overwriting and transactional.

### Phase 2: consistency and diagnostics

1. CF-07: validate runtime symlink ownership.
2. CF-08: unify metadata and view generation publication.
3. CF-09: align public binary names with shell activation.
4. CF-10: make list and doctor tolerant of damaged base state.
5. CF-11: make capture transactional.
6. CF-13: validate exact MCP and Hook adapter state.

### Phase 3: hardening

1. CF-12: reject option-like Git sources and refs.
2. CF-14: clean publication artifacts on all failures.

## Merge gate

All P1 and P2 findings require implementation and regression coverage before PR #19 merges. The final release gate remains:

```bash
npm run check
npm test
bash scripts/demo.sh
npm run benchmark
npm pack --dry-run --json
git diff --check
```

Concurrency tests must use deterministic barriers around Package replacement, runtime adoption, Agent writes, and Environment publication. Timing-only tests are insufficient for the data-preservation guarantees above.
