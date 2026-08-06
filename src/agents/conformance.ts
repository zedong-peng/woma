import type { AgentAdapter, AgentProjectionInput, ProjectionPlan } from "./adapter.js";
import { stable } from "./canonical.js";

export interface AdapterConformanceOptions {
  secretLiterals?: readonly string[];
}

function planShape(plan: ProjectionPlan): unknown {
  return {
    files: plan.files,
    resources: plan.resources,
    ownership: plan.ownership,
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
  let firstValidation;
  let secondValidation;
  try {
    firstValidation = adapter.validate(input);
    secondValidation = adapter.validate(input);
  } catch (error) {
    return [`validate throws: ${(error as Error).message}`];
  }
  if (stable(firstValidation) !== stable(secondValidation)) issues.push("validate is not deterministic");
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
  const expectedResources = input.capabilities.mcpServers.map(({ server }) => server.name).sort();
  if (stable([...firstPlan.resources.mcpServers].sort()) !== stable(expectedResources)) {
    issues.push("plan omits or invents an MCP resource");
  }
  const ownership = firstPlan.ownership;
  const ownershipDuplicate = duplicate(ownership.map((record) => record.identity));
  if (ownershipDuplicate) issues.push(`plan repeats ownership identity ${ownershipDuplicate}`);
  for (const record of ownership) {
    if (!record.identity || !record.packageOwner || !record.nativeLocator || !/^sha256:[a-f0-9]{64}$/.test(record.valueDigest)) {
      issues.push(`plan contains malformed ownership record ${record.identity || "<empty>"}`);
    }
  }
  for (const record of ownership.filter((item) => item.capability === "hook")) {
    const exposesCommand = input.capabilities.hooks.some(({ hook }) =>
      hook.command
      && record.nativeLocator.includes(`${hook.event}${hook.matcher ? `:${hook.matcher}` : ""}`)
      && record.identity.includes(hook.command),
    );
    if (exposesCommand) {
      issues.push(`ownership identity exposes Hook command for ${record.nativeLocator}`);
    }
  }

  const firstDiscovery = adapter.discover(input);
  const secondDiscovery = adapter.discover(input);
  if (stable(firstDiscovery) !== stable(secondDiscovery)) issues.push("discovery is not deterministic");
  const firstDiagnostics = adapter.diagnose(input);
  const secondDiagnostics = adapter.diagnose(input);
  if (stable(firstDiagnostics) !== stable(secondDiagnostics)) issues.push("diagnostics are not deterministic");

  const rendered = stable({ ownership, discovery: firstDiscovery, diagnostics: firstDiagnostics });
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
