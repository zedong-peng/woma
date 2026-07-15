# Paired Harness evaluations

An eval answers one narrow question: on the same repository revision and task, does activating a profile improve an objective result compared with leaving the project profile off?

## Protocol

1. Commit the task fixture, Harness project, lock, eval definition, and verifier.
2. Run `harness eval plan <name>` and review the Agent, profile, verifier, session count, timeout, and Git HEAD.
3. Run `harness eval run <name> --execute` only when the displayed Agent spend is acceptable.
4. Inspect the local result under `.harness/local/evals/`. Add `--keep-failures` when the failed work product itself is needed for diagnosis. Prompts and Agent output are not copied into the result.
5. Repeat on held-out tasks before promoting a Harness version.

Each repetition creates two detached worktrees at the exact same commit. The baseline arm receives the repository without an active Harness profile. The profile arm activates the selected profile. Both arms launch a non-persistent Agent session and run the same verifier. Arm order changes between repetitions. Worktrees are removed after verification unless failed arms are explicitly retained.

## Definition

```yaml
apiVersion: harness.conda/eval-v1
kind: HarnessEval
metadata:
  name: regression-fix
spec:
  profile: debug
  agent: codex
  prompt: |
    Fix the seeded parser regression without changing the public API.
  verify:
    binding: test
  repetitions: 3
  timeoutSeconds: 1200
  agentArgs: []
```

`verify` accepts exactly one project binding or explicit shell command. The verifier should check the actual artifact or behavior, not whether the Agent mentioned the desired process. Hidden tests and held-out fixtures are stronger than format checks.

## Safety and privacy

- `eval run` is plan-only unless `--execute` is present.
- Execution requires a clean Git worktree so both arms use a named, reproducible commit.
- The runner fixes Codex to `workspace-write` and Claude to `acceptEdits`; eval definitions cannot override isolation, working directory, or permission mode through `agentArgs`.
- A committed eval definition and in-repository verifier are visible to both arms and must not be treated as hidden tests. Use an external held-out verifier when gaming resistance matters.
- Results contain commit, definition and verifier hashes, exit status, duration, pass rate, failure stage, and optional retained-worktree path only. They stay in Git-excluded `.harness/local`; nothing is uploaded.
- `--keep-failures` intentionally preserves complete failed worktrees, which may contain sensitive Agent output. They remain local and must be reviewed and removed by the user.

Remove a retained worktree after diagnosis with `git worktree remove --force <path>`.

## What this does not prove

A visible structural verifier is only a smoke test. One pass does not establish that a Harness improves research quality, generalizes across repositories, or deserves promotion. Product evidence requires multiple real, previously unsolved tasks, paired repetitions, semantic review or hidden tests, and failure analysis. A profile that ties or loses to baseline should not be called golden.
