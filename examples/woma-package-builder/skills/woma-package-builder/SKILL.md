---
name: woma-package-builder
description: Creates and updates valid Woma Packages from existing or new Skills, MCP servers, hooks, requirements, and Package dependencies. Use when the user wants to wrap a downloaded Skill, package Agent resources, scaffold a reusable capability, aggregate dependencies, or describe an end-to-end method implemented by an optional coordinating entrypoint Skill.
---

# Woma Package Builder

Create one ordinary Woma Package that contains exactly the resources needed by the user. A Package may contain any combination of Skills, MCP servers, hooks, requirements, dependencies, and entrypoints. Do not introduce Package subtypes.

Before writing files, read [references/package-format.md](references/package-format.md). Use its layouts, manifest fields, and validation rules exactly.

Use the user's available Woma CLI invocation for all commands below. Examples show `woma`; preserve an equivalent invocation such as `node /path/to/woma/dist/src/cli.js` when that is how the CLI is installed.

## Author the Package

1. Inspect the destination and supplied resources before changing them. When updating an existing Package, read its complete `woma.yaml` and preserve unrelated resources and metadata. Refuse to overwrite unrelated files unless the user explicitly requests replacement.
2. Classify the request without asking the user to choose a Package type:
   - wrap existing Skills, MCP definitions, or hooks;
   - create new resources from a described capability;
   - update an existing Woma Package;
   - aggregate dependency Packages;
   - coordinate dependency capabilities through an ordinary entrypoint Skill.
3. Establish the Package name, version, destination, Agent targets, portable requirements, and requested resources. Infer discoverable facts and ask only for choices that materially affect the result.
4. Make Package contents self-contained. Copy a standalone external Skill under `skills/<name>/`; do not leave paths that escape the Package root. Preserve source files unless the user explicitly authorizes moving or deleting them.
5. Convert MCP and hook configuration to the Woma manifest. Declare secret names under `requirements.env`; never copy credential values, authorization headers, or machine-specific secrets.
6. Run `woma inspect <source>` for every dependency. Record its resolved Package name and compatible version. Stop on identity mismatch, invalid content, unavailable source, incompatible versions, cycles, or conflicting resolutions.
7. Add a coordinating Skill only when the user describes a reusable method across capabilities. Put ordering, branches, feedback, interruption recovery, stopping conditions, and output expectations in that ordinary `SKILL.md`; keep dependencies as an unordered install graph.
8. Create a new empty destination with `woma init <directory> --name <package-name>` when useful, then adapt or remove the generic scaffold so the manifest exposes only the requested resources.
9. Run `woma inspect <directory>` from the generated Package's parent directory. Fix every manifest, frontmatter, path, identity, version, source, or dependency-closure error and rerun validation.
10. Review for credentials, path escapes, symbolic links, hard-coded project commands, machine-specific paths, undeclared executables, accidental files, and invented dependencies.

## Preserve Boundaries

- Treat Package as the only distribution type. A coordinating Skill remains a Skill, and a Package with dependencies remains a Package.
- Keep repository-specific build, test, benchmark, and operational knowledge in Project Memory rather than portable Package content.
- Prefer immutable Git tags or revisions for shared dependencies. Treat local dependency sources as development-only and report their portability limit.
- Do not publish, push, install into an Environment, alter Agent-global configuration, or delete source files without explicit authorization.
- Do not add a workflow runtime, DAG, phase state, handoff protocol, or mandatory linear execution model.

## Deliver

Return:

- generated or updated Package path and identity;
- contained Skills, MCP servers, hooks, requirements, dependencies, and entrypoints;
- copied versus preserved source resources;
- exact validation command and result;
- portability or security limitations;
- an installation command the user can run later.
