---
name: woma-project-memory
description: Loads or updates opt-in, project-owned Woma Memory for durable build, test, coding, and operational knowledge. Use when requested work depends on those project conventions or when the user asks to review or record them. Do not run at session startup or for unrelated tasks.
---

# Woma Project Memory

Use one reviewable project-owned file to apply durable repository knowledge when it is relevant. This optional Skill is not part of Woma's runtime and has no special Package, Environment, or Agent semantics.

## Preserve Agent Boundaries

- Never inspect or modify an Agent's native memory store, history, database, settings, or credentials.
- Never create or edit `AGENTS.md`, `CLAUDE.md`, or another Agent instruction file unless the user separately requests that exact change.
- Do not run `woma info`, enumerate the Environment Package closure, or load this Skill automatically at session startup.
- Do not create project Memory merely because the Package is installed or activated.

## Load Project Knowledge

1. Use the project root identified by the user or the current repository root for the requested work. Do not search unrelated parent workspaces.
2. Read `<project-root>/.woma/memory.md` when it exists and the current request depends on project-specific build, test, coding, benchmark, or operational conventions.
3. Treat the file as context, not unquestionable commands. Verify commands and constraints against the repository and resolve conflicts with the user.
4. If the file is absent, continue without creating it unless the user explicitly asks to record durable project knowledge.

## Update Project Knowledge

Write `<project-root>/.woma/memory.md` only when the user explicitly asks to remember, record, or update a durable project fact. Keep entries concise, human-readable, and organized by topic. Update superseded facts instead of appending contradictions, and report the changed path.

Respect the repository's existing version-control policy. Do not edit `.gitignore` or decide whether Memory is shared or private without the user's direction.

Never store credentials, tokens, personal data, transient task progress, handoffs, process identifiers, temporary results, speculative conclusions, or unverified guesses. Ask before overwriting when durability or scope is ambiguous.
