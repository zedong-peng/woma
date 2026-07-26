import type { CodexClaudePlatform } from "./types.js";

export const AGENT_SKILLS_DIRECTORY = "skills";

export const AGENT_SESSION_ENTRIES: Readonly<Record<CodexClaudePlatform, readonly string[]>> = {
  codex: ["archived_sessions", "history.jsonl", "session_index.jsonl", "sessions", "shell_snapshots"],
  claude: ["file-history", "history.jsonl", "plans", "projects", "session-env", "shell-snapshots", "tasks", "todos"],
};
