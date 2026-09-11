/**
 * OpenAI direct-API provider: GPT 5.6 sol/terra/luna plus GPT 6 Astra.
 * Astra is orchestrator-only and gated by settings — see apps/web settings
 * and the router's orchestrator handling. Requires OPENAI_KEY (no key yet
 * on this machine; adapter is wired and dormant until one is added).
 */
import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

const seed: Record<string, ModelCapabilities> = {
  "gpt-5.6-sol": { coding: 10, reasoning: 10, vision: true, tools: true, context: 400000, cost: 5, thinking: true },
  "gpt-5.6-terra": { coding: 9, reasoning: 9, vision: true, tools: true, context: 400000, cost: 2 },
  "gpt-5.6-luna": { coding: 7, reasoning: 7, tools: true, context: 128000, cost: 0.3 },
  // Orchestrator-only: excluded from routine routing; surfaced when the
  // settings gate is on and the job is an orchestration role.
  "gpt-6-astra": {
    coding: 10, reasoning: 10, vision: true, tools: true, context: 1000000,
    cost: 20, thinking: true, longContext: true,
  },
};

export const ORCHESTRATOR_ONLY_MODELS = new Set(["openai/gpt-6-astra"]);

export class OpenAIProvider extends OpenAICompatProvider {
  constructor(apiKey?: string | null) {
    super("openai", "https://api.openai.com/v1", {
      apiKey,
      envVar: "OPENAI_KEY",
      billing: "api",
      capabilitiesSeed: seed,
    });
  }
}
