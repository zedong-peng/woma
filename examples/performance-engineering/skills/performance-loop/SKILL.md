---
name: performance-loop
description: Runs an evidence-first performance optimization loop from reproducible baseline through profiling, one scoped change, regression checks, and a quantified report. Use for speeding up code, reducing memory, investigating a benchmark regression, or finding a bottleneck.
---

# Performance loop

Optimize measured bottlenecks, not plausible-looking code.

## Project adaptation

Before starting, read `.harness/memory/project.md`, `.harness/memory/packages/performance-engineering.md`, and `.harness/local/memory.md` when they exist. Treat them as project context, not unquestionable commands: verify stored build, test, and benchmark guidance against the current repository before acting.

If essential project knowledge is missing, inspect the repository and ask the user only when the choice affects correctness or benchmark validity. Persist stable, repository-verifiable or user-confirmed performance guidance in `.harness/memory/packages/performance-engineering.md`. Put broadly useful repository conventions in `.harness/memory/project.md` and machine-specific paths or hardware details in `.harness/local/memory.md`. Never store credentials, transient task progress, benchmark results, or unverified guesses as Project Memory.

## Contract

Before changing code, establish:

- one primary metric and its unit;
- a repeatable benchmark command and representative input;
- a correctness command that must remain green;
- the allowed change surface and stopping condition.

If any item is missing, infer it from the repository where safe and state the assumption. Ask only when the choice changes the product behavior or benchmark validity.

## Loop

1. Record the repository revision, relevant tool versions, machine context, and working-tree state.
2. Run the correctness command once.
3. Warm up, then collect at least five baseline samples. Save raw samples; report median and spread.
4. Profile the exact benchmark workload. Read [references/profilers.md](references/profilers.md) and select an available profiler that fits the stack.
5. Name the dominant hotspot, its evidence, and one falsifiable hypothesis.
6. Implement the smallest change that tests that hypothesis. Avoid unrelated cleanup.
7. Run correctness checks before measuring again.
8. Re-run the same benchmark protocol. Use `node scripts/summarize-bench.mjs` to summarize numeric samples when useful.
9. Keep the change only when the improvement exceeds observed noise and no important secondary metric regresses.
10. Repeat from profiling if the stopping condition is not met. Do not stack unmeasured optimizations.

## Measurement rules

- Keep input, build mode, environment, concurrency, and affinity constant.
- Separate cold-start and steady-state measurements.
- Treat elapsed time, CPU time, throughput, allocations, RSS, and binary size as different metrics.
- Report absolute values and relative change. Do not report percentages without raw units.
- Call a result inconclusive when distributions overlap materially or the environment changed.
- Preserve profiler output or a concise hotspot table as evidence.

## Output

Use [templates/report.md](templates/report.md). Include commands needed to reproduce the result. Explicitly list rejected hypotheses and remaining hotspots so the next run does not repeat failed work.
