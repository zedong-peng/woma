---
name: reproducibility-core
description: Preserves reproducible evidence, exact commands, environment facts, and failure cases across research, experiments, debugging, and reporting. Use in every technical method that produces a claim or decision.
---

# Reproducibility core

For every material claim, retain enough evidence for another person or Agent session to verify it.

1. Record the repository revision, dirty state, relevant tool versions, and data or input identity.
2. Preserve exact commands and parameters that produced a result.
3. Separate observations from interpretations and decisions.
4. Record failed commands, rejected hypotheses, and negative results; do not silently retry until something works.
5. Keep credentials and private data out of reports, logs, and committed artifacts.
6. Before transferring work, write a durable artifact with evidence, uncertainty, and objective acceptance criteria.

Prefer artifacts in the repository's declared output directories. Do not claim reproducibility when inputs, dependencies, or environment facts are unknown.
