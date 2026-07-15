#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const inputs = process.argv.slice(2);
const text = inputs.length
  ? (await Promise.all(inputs.map((file) => readFile(file, "utf8")))).join("\n")
  : await new Promise((resolve) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (value += chunk));
      process.stdin.on("end", () => resolve(value));
    });

const values = String(text)
  .split(/[\s,]+/)
  .filter(Boolean)
  .map(Number);
if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
  console.error("usage: printf '1.2 1.1 1.3' | summarize-bench.mjs");
  process.exit(2);
}

values.sort((left, right) => left - right);
const quantile = (fraction) => {
  const index = (values.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
};
const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

console.log(
  JSON.stringify(
    {
      n: values.length,
      min: values[0],
      median: quantile(0.5),
      mean,
      p95: quantile(0.95),
      max: values.at(-1),
      standardDeviation: Math.sqrt(variance),
    },
    null,
    2,
  ),
);
