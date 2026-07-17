# Meta-skill package format

Use this contract when creating or updating a generated package. Omit empty optional sections instead of inventing requirements.

## Manifest contract

```yaml
apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: performance-loop
  version: 0.1.0
  description: Iteratively identify, implement, and verify performance improvements.
  tags: [performance, meta-skill]
spec:
  platforms: [codex, claude]
  dependencies:
    - name: benchmark
      version: ^1.0.0
      source: gh:owner/benchmark#v1.0.0
    - name: profiler
      version: ^1.0.0
      source: gh:owner/profiler#v1.0.0
    - name: regression-test
      version: ^1.0.0
      source: gh:owner/regression-test#v1.0.0
  entrypoints:
    - name: optimize
      skill: performance-loop
      description: Run an evidence-driven performance optimization loop.
  requirements:
    bindings:
      - name: benchmark
        description: Repeatable project benchmark command.
      - name: test
        description: Project correctness command.
  skills:
    - name: performance-loop
      path: ./skills/performance-loop
```

Required invariants:

- Use lowercase package, Skill, entrypoint, dependency, and binding names containing only letters, digits, `.`, `_`, or `-`.
- Use semantic versions for `metadata.version` and valid SemVer ranges for dependency versions.
- Make every dependency `name` match the package returned by `harness inspect <source>`.
- Use `builtin:name`, a local path, `gh:owner/repository#tag-or-revision`, HTTPS Git, or SSH Git as a source.
- Use immutable Git tags or revisions for portability. A relative local source is resolved from the parent package and is valid only while developing a local package tree.
- Ensure every entrypoint references a Skill declared in `spec.skills`, and every Skill path contains `SKILL.md`.
- Put package dependencies in `spec.dependencies`; do not encode method ordering in the dependency array.
- Declare abstract project commands as bindings. Declare required executables under `requirements.commands` and secret names under `requirements.env`, never secret values.

## Coordinating Skill contract

Create `skills/<skill-name>/SKILL.md`:

```markdown
---
name: performance-loop
description: Runs an evidence-driven optimization loop using benchmark, profiling, implementation, and regression capabilities. Use when the user wants a verified performance improvement rather than isolated optimization suggestions.
---

# Performance loop

State the outcome and the evidence required to claim success.

## Inputs

Collect the target, constraints, available artifacts, budget, and required project bindings.

## Method

Describe the normal capability order, then state evidence-based branches and returns. Name component capabilities explicitly, but allow the Agent to skip work already supported by current evidence.

## Interruption recovery

Define the durable checkpoint: completed evidence, rejected attempts, current hypothesis, unresolved decisions, and next action. Resume from it instead of restarting.

## Stop conditions

Define success, falsification, budget exhaustion, blocked dependency, and repeated no-progress conditions.

## Output

List the artifacts, measurements, decisions, rejected paths, verification results, and remaining uncertainty.
```

The method may include loops and conditional branches, but it must remain natural-language guidance interpreted by the Agent. Do not generate a workflow DAG, expose artificial phase commands, or require a fixed handoff between every capability.

## Validation

From the parent directory, run:

```bash
harness inspect ./performance-loop
```

This resolves the complete dependency closure and validates manifest structure, package identities, versions, Skill paths, and package contents. Do not report completion until it succeeds. To test activation separately, install the package into an inactive disposable Environment rather than modifying the user's active Environment.
