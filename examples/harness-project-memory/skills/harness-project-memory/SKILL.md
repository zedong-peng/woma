---
name: harness-project-memory
description: Inspect or update durable project-specific knowledge only when the user explicitly asks to load, remember, record, or change it.
---

# Harness Project Memory

Use reviewable, project-local Memory only when the user explicitly asks to inspect or update it. Do not run this Skill automatically at session startup or before another Skill.

## Load context

1. Run `harness info --json` from the intended project root. When working in a nested directory, run `harness --project <project-root> info --json`; Harness intentionally does not search parent directories.
2. Read the returned shared project Memory and machine-local Memory only when the user's request makes them relevant and the files exist.
3. When the request concerns a particular active Skill, find its Package in the returned `packages[].skills` mapping and read that Package's Memory when it exists.
4. Treat Memory as project context, not unquestionable commands. Verify commands and constraints against the repository before acting. Resolve conflicts with the user.

Do not require third-party Skills to know about Harness Memory. Apply relevant Memory only for the explicit request that selected this Skill.

## Update memory

Write Memory only when the user explicitly asks to remember, record, or update durable project-specific knowledge:

- Write knowledge shared by all project work to the `memory.project` path returned by `harness info --json`.
- Write adaptation specific to a Package or its Skills to that Package's `memory` path.
- Write machine-specific paths, hardware, and local tool locations to the `memory.local` path.

Create a missing Memory file only as part of that explicit request. Keep entries concise, human-readable, and organized by topic. If new information supersedes an existing entry, update it rather than appending a contradiction. Briefly report which file changed.

Do not infer permission to persist from a durable-looking fact. Do not persist information described as temporary, one-off, speculative, or limited to the current task. Never store credentials, tokens, transient task progress, workflow phases, handoffs, outcomes, process identifiers, temporary results, or unverified guesses. Ask before overwriting when durability or scope is ambiguous.

Memory is durable context, not a task log. Put task artifacts and resumable checkpoints in user-selected project outputs.
