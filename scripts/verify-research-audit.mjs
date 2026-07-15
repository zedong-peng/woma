import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const reportPath = "eval-artifacts/research-audit.md";
const report = await readFile(reportPath, "utf8").catch(() => "");
const failures = [];

if (report.length < 900) failures.push(`${reportPath} must contain at least 900 characters`);
for (const heading of ["Evidence", "Risk", "Hypothesis", "Experiment", "Verdict"]) {
  if (!new RegExp(`^# ${heading}$`, "m").test(report)) failures.push(`missing exact heading: # ${heading}`);
}

const references = new Set(report.match(/(?:src|test)\/[a-z0-9.-]+\.ts:\d+/gi) ?? []);
if (references.size < 3) failures.push("report must contain at least three unique src/test file:line references");
if (![...references].some((value) => value.startsWith("src/profile.ts:"))) failures.push("Evidence must inspect src/profile.ts");
if (![...references].some((value) => value.startsWith("src/activation.ts:"))) failures.push("Evidence must inspect src/activation.ts");
if (!/(npm test|node --test|npm run check)/.test(report)) failures.push("Experiment must include an executable validation command");

const sourceChanges = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "src", "test"], {
  encoding: "utf8",
});
if (sourceChanges.status !== 0) failures.push("could not inspect source changes");
if (sourceChanges.stdout.trim()) failures.push(`task must not edit source or tests: ${sourceChanges.stdout.trim()}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(`eval verifier: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`eval verifier: ${references.size} evidence references and all required sections found`);
}
