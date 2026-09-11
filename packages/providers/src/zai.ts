import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

const seed: Record<string, ModelCapabilities> = {
  "glm-5.3": { coding: 9, reasoning: 9, cost: 0, context: 128000, thinking: true },
  "glm-5.3-flash": { coding: 8, reasoning: 7, cost: 0, context: 128000 },
  "glm-5.2": { coding: 8, reasoning: 8, cost: 0, context: 128000 },
  "glm-5.1": { coding: 8, reasoning: 7, cost: 0, context: 128000 },
};

export class ZAIProvider extends OpenAICompatProvider {
  constructor(apiKey?: string | null) {
    super("zai", "https://api.z.ai/api/coding/paas/v4", {
      apiKey,
      envVar: "ZAICODINGPLAN_KEY",
      billing: "coding-plan",
      capabilitiesSeed: seed,
    });
  }
}
