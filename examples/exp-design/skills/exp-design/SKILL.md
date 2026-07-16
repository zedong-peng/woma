---
name: exp-design
description: Converts a concrete idea into a controlled and executable experiment specification. Use when a hypothesis needs baselines, metrics, controls, budgets, and falsification criteria.
---

# Experiment design

Freeze the hypothesis before choosing implementation details. Define the expected observation and the result that would reject the idea.

Specify:

- datasets, workloads, splits, and contamination controls;
- primary and secondary metrics with units;
- strongest relevant baselines and ablations;
- fixed seeds, repetitions, budgets, and stopping conditions;
- correctness gates and unacceptable regressions;
- implementation scope and protected files;
- artifacts needed to reproduce and audit the result.

Call out confounders explicitly. Prefer the smallest experiment that discriminates the hypothesis before committing to a full implementation. The output must be executable by another Agent without relying on hidden chat context.
