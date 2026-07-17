---
name: meta-skill-builder
description: Creates a valid Harness meta-skill package from a natural-language method that coordinates multiple Skills. Use when the user wants to compose component Skills into a reusable loop, end-to-end method, conditional process, or portable Agent environment package.
---

# Meta-skill builder

Turn the user's method into an ordinary Harness package: dependencies make the component Skills installable, while one coordinating `SKILL.md` keeps the loop, branches, recovery behavior, and output contract in natural language. Do not introduce a DAG or runtime phase state.

Before writing files, read [references/package-format.md](references/package-format.md). Use its manifest and Skill contracts exactly.

Use the user's available Harness CLI invocation for all commands below. Examples show `harness`; preserve an equivalent invocation such as `node /path/to/harness-conda/dist/src/cli.js` when that is how the CLI is installed.

## Build the package

1. Inspect the destination before changing it. Refuse to overwrite an existing `harness.yaml` or unrelated files unless the user explicitly requests an update.
2. Establish the package name, destination, desired outcome, Agent targets, and component package sources. Ask only for choices that cannot be discovered or safely inferred.
3. Run `harness inspect <source>` for every component source. Record its resolved package name and version. Stop on an identity mismatch, invalid package, unavailable source, or incompatible version request.
4. Extract the method's capabilities and control semantics:
   - normal ordering without treating every step as mandatory;
   - conditions for branching, retrying, returning to an earlier capability, or skipping work;
   - evidence carried between iterations;
   - interruption checkpoints and how to resume from durable artifacts;
   - success, failure, budget, and no-progress stopping conditions;
   - final deliverables and verification evidence.
5. Create the package directory with `harness init <directory> --name <package-name>` when starting from scratch, then replace the generic scaffold with the format in the reference.
6. Declare every component package in `spec.dependencies`. Expose exactly one coordinating Skill as the primary entrypoint unless the user explicitly needs multiple entrypoints.
7. Write the coordinating `SKILL.md` as an adaptive method. Refer to dependencies by their declared Skill or capability names. Do not copy their implementation instructions or claim tools that their packages do not provide.
8. Run `harness inspect <directory>` from the directory containing the generated package. This must validate the manifest, Skill paths, package identity, dependency identities, versions, sources, and complete dependency closure.
9. Review the generated package for machine-specific paths, credentials, hard-coded project commands, hidden dependencies, and mandatory linear phases. Fix any issue and rerun validation.

## Preserve the boundary

- Keep orchestration policy in the generated `SKILL.md`, not in Harness Conda core state.
- Use dependencies for installable component packages, not as an ordered step list.
- Use project bindings for abstract commands such as `test` or `benchmark`; never embed one user's repository commands in a portable package.
- Use environment-variable requirements for secret names only. Never write credential values.
- Prefer immutable Git tags or revisions for shared packages. Treat local dependency sources as development-only and call out that they are not portable.
- Do not publish, push, install into the user's active Environment, or delete existing files without explicit authorization.

## Deliver

Return:

- generated package path and package identity;
- component dependencies with selected versions and sources;
- a concise explanation of the method, feedback paths, interruption recovery, and stopping conditions;
- the exact validation command and its result;
- portability limitations or unresolved dependency choices;
- the command the user can run later to install it into a named Environment.
