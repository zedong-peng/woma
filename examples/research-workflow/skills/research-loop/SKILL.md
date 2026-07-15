---
name: research-loop
description: Runs an evidence-led investigation from a scoped technical question through source collection, claim comparison, gap analysis, and ranked falsifiable hypotheses. Use when surveying prior work, evaluating an idea, or preparing experiments.
---

# Research loop

The deliverable is not a pile of links. It is a decision-ready evidence map and a handoff that an experiment profile can execute.

## Frame

1. Rewrite the request as one primary question and explicit decision.
2. State scope, exclusions, freshness requirements, and what evidence would change the decision.
3. Inspect the current repository before searching so research connects to the actual system.

## Investigate

1. Decompose the question into claims that can be independently verified.
2. Prefer primary sources: papers, official documentation, source code, datasets, standards, and measured repository behavior.
3. For each source, record the supported claim, date or revision, limitations, and conflicting evidence.
4. Compare approaches on shared dimensions rather than summarizing sources one by one.
5. Search specifically for failure modes, negative results, boundary conditions, and costs.

## Synthesize

1. Separate established facts, reasonable inferences, open uncertainty, and opinion.
2. Identify the gap between prior work and the current project.
3. Produce a ranked hypothesis list. Every hypothesis must include mechanism, expected observation, cheapest discriminating experiment, and rejection condition.
4. Recommend the next action only when the evidence supports it.

## Phase completion

Before switching to experiment:

- preserve the evidence ledger and source links;
- create `harness handoff experiment`;
- fill its Decision, Evidence, Hypotheses, Required inputs, Failure cases, and Acceptance criteria sections;
- do not implement the experiment while the research profile is active unless the user explicitly asks for a tiny feasibility probe.
