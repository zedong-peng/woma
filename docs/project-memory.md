# Project Memory

Project Memory adapts portable Skills and meta-skills to one repository using natural-language context. Harness Conda defines and initializes the storage boundary; users and Agents author the content. Harness does not parse the prose, inject Memory contents into Agent configuration, execute commands from it, or treat it as workflow state.

## Layout and isolation

```text
.harness/
├── memory/
│   ├── project.md
│   └── packages/
│       ├── performance-engineering.md
│       └── auto-research.md
└── local/
    └── memory.md
```

`.harness/memory/project.md` contains stable knowledge useful across Agent packages in the repository: build systems, test conventions, repository constraints, and verification expectations.

`.harness/memory/packages/<package-name>.md` contains project adaptation for exactly one package or meta-skill. A package must not use another package's scoped memory as its private state. Package names use the same validated lowercase identity as Harness manifests, so a name cannot escape the memory directory.

`.harness/local/memory.md` contains optional machine-specific context such as dataset paths, hardware selection, or local tool locations. `.harness/local/` is git-ignored and is not portable.

Project Memory is user-owned context, not an activation artifact. Activating, deactivating, switching, or removing an Environment must not delete or rewrite it. Removing a package from an Environment must also preserve its package-scoped memory for review or later reuse; users and Agents delete obsolete memory explicitly. Memory contents do not affect package integrity or Environment lock identities.

## Startup discovery

`harness-project-memory` is an ordinary Harness package with the same manifest, cache, lock, activation, and target projection as every other Skill package. It and `meta-skill-builder` are foundational roots in every Environment, including the implicit global `base`, so Project Memory behavior is consistently available and cannot be omitted at Environment creation time.

When the package is active, the Codex Adapter adds an exact marker-delimited pointer to `.agents/skills/harness-project-memory/SKILL.md` in the project-root `AGENTS.md`; the Claude Adapter points to the equivalent `.claude/skills/` path in `CLAUDE.md`. Existing user instructions outside the block are preserved. Switching or deactivating updates the pointers atomically, and modified managed blocks are treated as drift.

At session start the Memory Skill runs `harness current --json`. This dynamically returns the nearest project root, active Environment, shared/local Memory paths, and each active package's version, Skills, entrypoints, and isolated Memory path. No derived context file is maintained. The Skill reads shared and local Memory, then reads package Memory before the Agent uses a mapped Skill. Third-party Skills do not need to mention Harness or modify their contents.

## Authoring contract

Before using project-specific guidance, an Agent should:

1. Read shared, package-scoped, and local memory when present.
2. Treat memory as context rather than unquestionable instructions.
3. Verify stored commands and constraints against the current repository before acting.
4. Inspect the repository or ask the user when essential knowledge is missing.
5. When the user states a durable project-specific fact, persist it automatically in the narrowest correct scope even without an explicit request to remember it.
6. Do not persist temporary, one-off, speculative, or current-task-only statements.
7. Resolve conflicts or ambiguous durability with the user instead of silently overwriting Memory.
8. Briefly report which Memory file changed.

Good Project Memory includes build and test conventions, slow-test warnings, benchmark protocols, generated-file rules, compatibility constraints, and repository-specific acceptance criteria.

Do not store credentials, tokens, transient task progress, current workflow phases, handoffs, outcomes, temporary process identifiers, benchmark results, or unverified guesses. Durable task artifacts and resumable workflow checkpoints belong in user-selected project outputs, not in Project Memory.

## Portability

Commit `.harness/memory/` when its contents are appropriate for collaborators and other machines. Keep machine-specific information under `.harness/local/`. Review Project Memory like code because it can influence Agent behavior. Environment export should include portable Project Memory and exclude local memory when bundle support is added.
