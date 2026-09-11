import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

const seed: Record<string, ModelCapabilities> = {
  "deepseek-flash": { coding: 8, reasoning: 7, cost: 0.1, context: 128000 },
  "deepseek-v4-pro": { coding: 9, reasoning: 9, cost: 0.5, context: 128000, thinking: true },
};

export class DeepSeekProvider extends OpenAICompatProvider {
  constructor(apiKey?: string | null) {
    super("deepseek", "https://api.deepseek.com", {
      apiKey,
      envVar: "DEEPSEEK_API_KEY",
      billing: "api",
      capabilitiesSeed: seed,
    });
  }
}
