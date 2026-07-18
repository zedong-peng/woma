---
name: auto-research
description: Runs an evidence-to-experiment research loop using paper-search, idea-gen, and exp-design. Use when the user wants a defensible research direction and an executable experiment plan rather than disconnected brainstorming.
---

# Auto research

Produce an evidence-backed, falsifiable experiment plan. The component Skills are capabilities, not mandatory exposed phases; adapt the method to the task while preserving its evidence and falsification contract.

## Method

1. Use `paper-search` to map the closest prior work, unresolved limitations, and unsupported assumptions.
2. Use `idea-gen` to propose one idea grounded in a specific limitation.
3. Compare the idea against the evidence map. If it materially overlaps prior work or relies on a broken assumption, record the rejection reason and return to idea generation. Do not repeat a rejected direction without new evidence.
4. Use `exp-design` to define the hypothesis, baselines, controls, metrics, implementation scope, budget, and falsification criteria.
5. If experiment design exposes an invalid assumption or cannot distinguish the claimed mechanism, feed that evidence back into idea generation.
6. Stop when the plan is defensible and executable, or when the agreed search and iteration budget is exhausted.

Handle interruptions by preserving the current evidence map, accepted and rejected ideas, open assumptions, and next decision in a durable artifact. Resume from that artifact instead of restarting the loop.

## Output

Return:

- a traceable related-work evidence map;
- the accepted idea and its material difference from prior work;
- rejected ideas and rejection evidence;
- a falsifiable hypothesis;
- an executable experiment specification;
- success, failure, and stopping criteria;
- remaining uncertainty.
