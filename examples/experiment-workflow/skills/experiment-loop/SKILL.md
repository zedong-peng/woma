---
name: experiment-loop
description: Executes a reproducible experiment from a research handoff, with a frozen hypothesis, baseline, controls, implementation, repeated measurement, failure analysis, and decision report. Use when validating an idea or comparing approaches.
---

# Experiment loop

Read the active profile's handoff before touching implementation. The experiment must test a stated hypothesis, not merely produce a successful-looking run.

## Protocol

1. Extract the hypothesis, expected observation, rejection condition, inputs, and acceptance criteria from the handoff.
2. Resolve missing decisions before implementation. Record any deviation from the handoff.
3. Use the project's declared build, test, benchmark, and data bindings.
4. Establish a correctness gate and measured baseline before the treatment.
5. Freeze evaluation data, metrics, repetitions, random seeds, budgets, and stopping conditions.

## Execute

1. Implement the smallest change that discriminates the active hypothesis.
2. Keep control and treatment paths comparable.
3. Run correctness checks before evaluation.
4. Preserve raw outputs, failures, logs, and environment facts.
5. Repeat enough times to distinguish the effect from observed noise.
6. Do not tune on held-out evaluation data or silently change the metric after seeing results.

## Decide

Report absolute measurements, variation, relative change, correctness, and resource cost. Classify the result as supported, rejected, or inconclusive. Explain what evidence led to that classification.

Negative and inconclusive results are valid deliverables. Record the next discriminating hypothesis instead of forcing a positive conclusion.

Before moving to reporting, debugging, or a new research cycle, create a new Harness handoff with exact reproduction commands and unresolved failure cases.
