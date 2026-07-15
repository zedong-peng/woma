import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, pathExists, relativeDisplay, writeTextAtomic } from "./fs.js";
import { readState } from "./store.js";

export type OutcomeStatus = "success" | "failure" | "inconclusive";
export type FailureReason = "drift" | "conflict" | "dependency" | "configuration" | "unexpected";

export interface WorkflowEvent {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  type: "profile_transition" | "handoff" | "session_start" | "session_end" | "outcome";
  profile?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: "success" | "failure" | "inconclusive" | undefined;
  reason?: FailureReason | undefined;
  durationMs?: number | undefined;
  handoff?: string | undefined;
  packages?: string[] | undefined;
  agent?: "codex" | "claude" | undefined;
  sessionId?: string | undefined;
  exitCode?: number | undefined;
  artifact?: string | undefined;
  note?: string | undefined;
}

export interface WorkflowStats {
  transitions: { success: number; failure: number };
  handoffs: number;
  sessions: { started: number; completed: number; nonzeroExit: number; medianDurationMs?: number | undefined };
  outcomes: Record<OutcomeStatus, number>;
  profiles: Record<string, Record<OutcomeStatus, number>>;
}

export function eventsPath(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "local", "events.jsonl");
}

export function classifyFailure(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/modified|drift|missing managed|routing block/i.test(message)) return "drift";
  if (/refusing to overwrite|conflict/i.test(message)) return "conflict";
  if (/not installed|not cached|not found|missing from this installation|integrity/i.test(message)) return "dependency";
  if (
    /invalid|unknown profile|configured|project targets|fresh Harness project|requires a handoff|requires project binding|handoff .* not ready/i.test(
      message,
    )
  ) {
    return "configuration";
  }
  return "unexpected";
}

export async function appendWorkflowEvent(
  projectRoot: string,
  event: Omit<WorkflowEvent, "schemaVersion" | "id" | "timestamp">,
): Promise<WorkflowEvent> {
  const complete: WorkflowEvent = {
    schemaVersion: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  const filePath = eventsPath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const localIgnore = path.join(path.dirname(filePath), ".gitignore");
  if (!(await pathExists(localIgnore))) await writeTextAtomic(localIgnore, "*\n");
  await appendFile(filePath, `${JSON.stringify(complete)}\n`, "utf8");
  return complete;
}

export async function readWorkflowEvents(projectRoot: string): Promise<WorkflowEvent[]> {
  const filePath = eventsPath(projectRoot);
  if (!(await pathExists(filePath))) return [];
  const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try {
      const event = JSON.parse(line) as WorkflowEvent;
      if (event.schemaVersion !== 1 || typeof event.id !== "string" || typeof event.timestamp !== "string") {
        throw new Error("unsupported event");
      }
      return event;
    } catch (error) {
      throw new Error(`Cannot parse local workflow event ${index + 1}: ${(error as Error).message}`);
    }
  });
}

export async function recordOutcome(
  projectRoot: string,
  status: OutcomeStatus,
  options: { artifact?: string; note?: string } = {},
): Promise<WorkflowEvent> {
  const state = await readState(projectRoot);
  if (!state.profile) throw new Error("No active profile to attach this outcome to");
  if (options.note && options.note.length > 1000) throw new Error("Outcome note must be 1000 characters or fewer");
  let artifact: string | undefined;
  if (options.artifact) {
    const absolute = path.resolve(projectRoot, options.artifact);
    assertInside(projectRoot, absolute, "Outcome artifact");
    if (!(await pathExists(absolute))) throw new Error(`Outcome artifact does not exist: ${options.artifact}`);
    artifact = relativeDisplay(projectRoot, absolute);
  }
  return appendWorkflowEvent(projectRoot, {
    type: "outcome",
    profile: state.profile.name,
    status,
    ...(artifact ? { artifact } : {}),
    ...(options.note ? { note: options.note } : {}),
  });
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

export async function workflowStats(projectRoot: string): Promise<WorkflowStats> {
  const events = await readWorkflowEvents(projectRoot);
  const stats: WorkflowStats = {
    transitions: { success: 0, failure: 0 },
    handoffs: 0,
    sessions: { started: 0, completed: 0, nonzeroExit: 0 },
    outcomes: { success: 0, failure: 0, inconclusive: 0 },
    profiles: {},
  };
  const sessionDurations: number[] = [];
  for (const event of events) {
    if (event.type === "profile_transition") {
      if (event.status === "success") stats.transitions.success += 1;
      else if (event.status === "failure") stats.transitions.failure += 1;
    } else if (event.type === "handoff") {
      stats.handoffs += 1;
    } else if (event.type === "session_start") {
      stats.sessions.started += 1;
    } else if (event.type === "session_end") {
      stats.sessions.completed += 1;
      if (event.exitCode !== 0) stats.sessions.nonzeroExit += 1;
      if (event.durationMs !== undefined) sessionDurations.push(event.durationMs);
    } else if (event.type === "outcome" && event.status && event.profile) {
      stats.outcomes[event.status] += 1;
      const profile = stats.profiles[event.profile] ?? { success: 0, failure: 0, inconclusive: 0 };
      profile[event.status] += 1;
      stats.profiles[event.profile] = profile;
    }
  }
  const medianDurationMs = median(sessionDurations);
  if (medianDurationMs !== undefined) stats.sessions.medianDurationMs = medianDurationMs;
  return stats;
}
