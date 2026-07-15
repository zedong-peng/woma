import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendWorkflowEvent, eventsPath, readWorkflowEvents, recordOutcome, workflowStats } from "../src/events.js";
import { onboardProject } from "../src/onboard.js";

test("local workflow stats aggregate transitions, sessions, handoffs, and outcomes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-events-"));
  try {
    await appendWorkflowEvent(root, { type: "profile_transition", to: "research", status: "success", durationMs: 20 });
    await appendWorkflowEvent(root, { type: "profile_transition", from: "research", to: "experiment", status: "failure", reason: "conflict" });
    await appendWorkflowEvent(root, { type: "handoff", from: "research", to: "experiment", handoff: ".harness/handoffs/a.md" });
    await appendWorkflowEvent(root, { type: "session_start", profile: "research", agent: "codex", sessionId: "session-1" });
    await appendWorkflowEvent(root, {
      type: "session_end",
      profile: "research",
      agent: "codex",
      sessionId: "session-1",
      exitCode: 0,
      durationMs: 1200,
    });
    await appendWorkflowEvent(root, { type: "outcome", profile: "research", status: "success" });
    await appendWorkflowEvent(root, { type: "outcome", profile: "research", status: "inconclusive" });

    const stats = await workflowStats(root);
    assert.deepEqual(stats.transitions, { success: 1, failure: 1 });
    assert.equal(stats.handoffs, 1);
    assert.deepEqual(stats.sessions, { started: 1, completed: 1, nonzeroExit: 0, medianDurationMs: 1200 });
    assert.deepEqual(stats.outcomes, { success: 1, failure: 0, inconclusive: 1 });
    assert.deepEqual(stats.profiles.research, { success: 1, failure: 0, inconclusive: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outcomes attach evidence to the active profile and remain local", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-events-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    await onboardProject(project, { targets: ["codex"] });
    await writeFile(path.join(project, "research-report.md"), "evidence", "utf8");
    const outcome = await recordOutcome(project, "success", {
      artifact: "research-report.md",
      note: "Hypotheses are ready for experiment.",
    });
    assert.equal(outcome.profile, "research");
    assert.equal(outcome.artifact, "research-report.md");
    const events = await readWorkflowEvents(project);
    assert.ok(events.some((event) => event.type === "profile_transition" && event.status === "success"));
    assert.ok(events.some((event) => event.id === outcome.id && event.note === "Hypotheses are ready for experiment."));
    assert.match(await readFile(eventsPath(project), "utf8"), /"type":"outcome"/);
    assert.equal(await readFile(path.join(project, ".harness", "local", ".gitignore"), "utf8"), "*\n");
    await assert.rejects(recordOutcome(project, "failure", { artifact: "../outside.txt" }), /escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
