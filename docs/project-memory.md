# Project Memory

Project Memory is optional, project-local context for people and Agents. It can record stable repository conventions without putting those conventions into a reusable Package.

It is not an Environment dependency, lockfile input, activation setting, or task state. A project does not need Memory to use Harness, and an Environment does not gain or lose reproducibility based on Memory files.

## Optional helper

`harness-project-memory` is an ordinary built-in Package. Install it only in an Environment where an Agent should be able to help inspect or update project context:

```bash
harness install -n <environment> builtin:harness-project-memory
```

It is removable like every other root Package. Installing it only makes the Skill available through that Environment's Agent view. It does not create Memory files, edit `.gitignore`, write `AGENTS.md` or `CLAUDE.md`, or require the Skill to run at session startup. Select the Skill explicitly when the user asks to load, inspect, or update project knowledge.

`harness-package-builder` follows the same model: it is optional authoring tooling, not an implicit Environment dependency. This mirrors Conda's separation between an Environment's requested packages and optional tooling such as `conda-build`.

## Layout and isolation

Projects that choose to use Memory can keep it in this layout:

```text
.harness/
|-- memory/
|   |-- project.md
|   `-- packages/
|       |-- performance-engineering.md
|       `-- auto-research.md
`-- local/
    `-- memory.md
```

`.harness/memory/project.md` can hold knowledge useful across the repository, such as build systems, test conventions, generated-file rules, or verification expectations.

`.harness/memory/packages/<package-name>.md` can adapt one Package to the project. A Package must not use another Package's scoped Memory as private state. Package names use the same validated lowercase identity as Harness manifests, so a name cannot escape the Memory directory.

`.harness/local/memory.md` can hold machine-specific context such as dataset paths, hardware selection, or local tool locations. Decide and maintain ignore rules in the project; Harness does not modify `.gitignore`.

`harness info --json` reports the paths for an explicit project directory and maps active Skills to Packages. It does not create, parse, inject, or execute Memory contents. Harness deliberately does not search parent directories to guess the project boundary.

## Authoring contract

When an Agent is explicitly asked to use Project Memory, it should:

1. Read the relevant shared, Package-scoped, and local files when they exist.
2. Treat their content as context rather than unquestionable instructions.
3. Verify stored commands and constraints against the current repository before acting.
4. Inspect the repository or ask the user when essential knowledge is missing.
5. Write or update Memory only when the user explicitly asks to remember, record, or update it.
6. Keep changes concise, scoped, reviewable, and reported to the user.

Do not store credentials, tokens, transient task progress, workflow phases, handoffs, outcomes, process identifiers, benchmark results, or unverified guesses. Durable task artifacts and resumable checkpoints belong in user-selected project outputs, not Project Memory.

## Legacy migration

Environment recipes written by earlier Harness releases contained `harness-project-memory` and `harness-package-builder` as implicit roots. The next operation that loads or updates such an Environment upgrades its recipe to `environment-v2` and removes those former implicit built-in roots from its lock and Agent view. Install either Package explicitly afterward when it is wanted.

Earlier releases also wrote marker-delimited Project Memory discovery blocks to `AGENTS.md` and `CLAUDE.md`. `harness activate` and `harness info` remove an unchanged legacy block once; no current command writes one. Harness preserves surrounding user content, symbolic links, and file modes. A modified managed block is not removed automatically and is reported for manual review by `harness doctor`.

## Portability

Commit `.harness/memory/` only when its contents are appropriate for collaborators and other machines. Keep machine-specific information in project-owned local files and exclude it according to the repository's own policy. Review Project Memory like any other Agent-influencing project content.

Environment bundles exclude Project Memory and all project instruction files. Package export remains a portable capability distribution mechanism, not a project-context backup.
