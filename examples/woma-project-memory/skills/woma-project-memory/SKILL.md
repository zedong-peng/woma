---
name: woma-project-memory
description: Loads and maintains durable project-specific knowledge for active Woma packages and Skills. Use at the beginning of every Agent session in a Woma Environment, before using another active Skill, and whenever the user states stable project facts such as build, test, benchmark, repository, or operational conventions, even when the user does not explicitly ask to remember them.
---

# Woma Project Memory

Keep portable Skills generic while adapting them to the current project through reviewable natural-language Memory.

## Load context

1. Run `woma info --json` from the intended project root. When working in a nested directory, run `woma --project <project-root> info --json`; Woma intentionally does not search parent directories.
2. Read the returned shared project Memory and machine-local Memory when they exist.
3. Before using another active Skill, find its package in the returned `packages[].skills` mapping and read that package's Memory when it exists.
4. Treat Memory as project context, not unquestionable commands. Verify commands and constraints against the repository before acting. Resolve conflicts with the user.

Do not require third-party Skills to know about Woma Memory. Apply the relevant Memory before following their instructions.

## Persist stable knowledge automatically

When the user states a durable project-specific fact, write it to the narrowest correct scope even if the user does not explicitly ask to remember it:

- Write knowledge shared by all project work to the `memory.project` path returned by `woma info --json`.
- Write adaptation specific to a package or its Skills to that package's `memory` path.
- Write machine-specific paths, hardware, and local tool locations to the `memory.local` path.

Create a missing Memory file when needed. Keep entries concise, human-readable, and organized by topic. If new information supersedes an existing entry, update it rather than appending a contradiction. Briefly report which file changed.

Do not persist information described as temporary, one-off, speculative, or limited to the current task. Never store credentials, tokens, transient task progress, workflow phases, handoffs, outcomes, process identifiers, temporary results, or unverified guesses. Ask before overwriting when durability or scope is ambiguous.

Memory is durable context, not a task log. Put task artifacts and resumable checkpoints in user-selected project outputs.
