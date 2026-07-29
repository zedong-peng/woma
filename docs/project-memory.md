# Optional Project Memory

Woma core manages Agent capabilities and isolated Environments, not Agent Memory or project context. It never creates project Memory, injects startup instructions, or reads and writes native Agent memory stores.

Projects that need shared build commands, test procedures, coding conventions, or operational knowledge can explicitly install the ordinary, removable Project Memory Package:

```bash
woma install builtin:woma-project-memory
```

The Package contributes one Skill to the selected Environment. It has no special runtime semantics and is not installed into `base` or new Environments automatically. Installation, activation, deactivation, and Environment switching do not invoke the Skill or create project files.

When relevant work selects the Skill, it reads the project-owned `.woma/memory.md` file if present. It creates or updates that file only when the user explicitly asks to persist durable knowledge. The Skill does not run `woma info`, enumerate Packages, edit `AGENTS.md` or `CLAUDE.md`, or inspect Agent-native memory, configuration, history, databases, or credentials.

The repository owner decides whether `.woma/memory.md` is version-controlled or ignored. Do not store credentials, personal data, transient progress, or unverified conclusions in it.
