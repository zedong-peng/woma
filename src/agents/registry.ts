import type { Platform } from "../types.js";
import type { AgentAdapter } from "./adapter.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { qoderAdapter } from "./qoder.js";

const adapters: Readonly<Record<Platform, AgentAdapter>> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  pi: piAdapter,
  qoder: qoderAdapter,
  opencode: opencodeAdapter,
};

export const SUPPORTED_AGENTS: readonly Platform[] = ["codex", "claude", "pi", "qoder", "opencode"];
const LEGACY_ALWAYS_PRESENT_RESOURCE_METADATA: readonly Platform[] = ["codex", "claude"];

export function agentAdapter(platform: Platform): AgentAdapter {
  return adapters[platform];
}

export function agentAdapters(): readonly AgentAdapter[] {
  return SUPPORTED_AGENTS.map((platform) => adapters[platform]);
}

export function resourceMetadataPlatforms(targets: readonly Platform[]): Platform[] {
  return [...new Set([...LEGACY_ALWAYS_PRESENT_RESOURCE_METADATA, ...targets])];
}
