#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const filePath = process.argv[2];
if (!filePath) throw new Error("usage: complete-demo-handoff.mjs <handoff.md>");

let input = await readFile(filePath, "utf8");
const replacements = {
  "State what the next profile should do and why.": "Run a controlled benchmark for the highest-ranked research hypothesis.",
  "List source paths, citations, measurements, and commands that support the decision.":
    "research-report.md records the baseline and evidence used for this decision.",
  "List falsifiable hypotheses in priority order. Include the expected observation for each.":
    "H1: the proposed change lowers median latency by at least ten percent without correctness regressions.",
  "List datasets, checkpoints, branches, environment variables, and external dependencies.":
    "Use the current branch, repository fixtures, and the declared benchmark binding.",
  "Record rejected approaches, known failure modes, and unresolved uncertainty.":
    "A cache-only approach was rejected; runtime variance remains an uncertainty.",
  "Define the objective checks that make the next phase complete.":
    "The test binding passes and repeated benchmark samples separate the effect from baseline noise.",
};
for (const [placeholder, replacement] of Object.entries(replacements)) input = input.replace(placeholder, replacement);
await writeFile(filePath, input, "utf8");
