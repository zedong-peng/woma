#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onboardProject } from "../dist/src/onboard.js";
import { leaveProfile, switchProfile } from "../dist/src/profile.js";

const root = await mkdtemp(path.join(os.tmpdir(), "harness-switch-benchmark-"));
const project = path.join(root, "project");
const previousHome = process.env.HARNESS_HOME;
process.env.HARNESS_HOME = path.join(root, "home");

try {
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { test: "true", benchmark: "true" } }),
    "utf8",
  );
  await onboardProject(project, {
    name: "switch-benchmark",
    agent: "codex",
    targets: ["codex"],
    switchToResearch: false,
  });
  await switchProfile(project, "research");

  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const target = index % 2 === 0 ? "performance" : "research";
    const started = performance.now();
    await switchProfile(project, target);
    samples.push(performance.now() - started);
  }
  await leaveProfile(project);

  samples.sort((left, right) => left - right);
  const quantile = (fraction) => {
    const position = (samples.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return samples[lower] + (samples[upper] - samples[lower]) * (position - lower);
  };
  console.log(
    JSON.stringify(
      {
        benchmark: "research-performance-profile-switch",
        n: samples.length,
        medianMs: Number(quantile(0.5).toFixed(2)),
        p95Ms: Number(quantile(0.95).toFixed(2)),
        minMs: Number(samples[0].toFixed(2)),
        maxMs: Number(samples.at(-1).toFixed(2)),
      },
      null,
      2,
    ),
  );
} finally {
  if (previousHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
