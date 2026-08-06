import type { AgentAdapter, AgentProjectionInput, ProjectionPlan } from "./adapter.js";
import { stable } from "./canonical.js";

export interface AdapterConformanceOptions {
  secretLiterals?: readonly string[];
}

function planShape(plan: ProjectionPlan): unknown {
  return {
    files: plan.files,
    resources: plan.resources,
    ownership: plan.ownership ?? [],
  };
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/** Validate the deterministic, side-effect-free portion of an Adapter. */
export function adapterConformanceIssues(
  adapter: AgentAdapter,
  input: AgentProjectionInput,
  options: AdapterConformanceOptions = {},
): string[] {
  const issues: string[] = [];
  let firstPlan: ProjectionPlan;
  let secondPlan: ProjectionPlan;
  try {
    firstPlan = adapter.plan(input);
    secondPlan = adapter.plan(input);
  } catch (error) {
    return [`plan throws: ${(error as Error).message}`];
  }
  if (stable(planShape(firstPlan)) !== stable(planShape(secondPlan))) issues.push("plan is not deterministic");

  const fileDuplicate = duplicate(firstPlan.files.map((file) => file.artifactId));
  if (fileDuplicate) issues.push(`plan writes artifact ${fileDuplicate} more than once`);
  const resourceDuplicate = duplicate(firstPlan.resources.mcpServers);
  if (resourceDuplicate) issues.push(`plan repeats MCP resource ${resourceDuplicate}`);
  const ownership = firstPlan.ownership ?? [];
  const ownershipDuplicate = duplicate(ownership.map((record) => record.identity));
  if (ownershipDuplicate) issues.push(`plan repeats ownership identity ${ownershipDuplicate}`);

  const firstDiscovery = adapter.discover(input);
  const secondDiscovery = adapter.discover(input);
  if (stable(firstDiscovery) !== stable(secondDiscovery)) issues.push("discovery is not deterministic");
  const firstDiagnostics = adapter.diagnose(input);
  const secondDiagnostics = adapter.diagnose(input);
  if (stable(firstDiagnostics) !== stable(secondDiagnostics)) issues.push("diagnostics are not deterministic");

  const rendered = stable({ plan: firstPlan, discovery: firstDiscovery, diagnostics: firstDiagnostics });
  for (const secret of options.secretLiterals ?? []) {
    if (secret && rendered.includes(secret)) issues.push("plan, discovery, or diagnostics expose a literal secret");
  }
  return issues;
}

export function assertAdapterConformance(
  adapter: AgentAdapter,
  input: AgentProjectionInput,
  options: AdapterConformanceOptions = {},
): void {
  const issues = adapterConformanceIssues(adapter, input, options);
  if (issues.length > 0) throw new Error(`${adapter.descriptor.displayName} Adapter conformance failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}
