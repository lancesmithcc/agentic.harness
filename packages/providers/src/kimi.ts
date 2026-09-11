import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

const seed: Record<string, ModelCapabilities> = {
  "k3": { coding: 10, reasoning: 10, cost: 0, context: 262144, thinking: true, longContext: true },
  "k3-256k": { coding: 10, reasoning: 10, cost: 0, context: 1048576, thinking: true, longContext: true },
  "kimi-for-coding": { coding: 9, reasoning: 8, cost: 0, context: 262144, thinking: true },
  "kimi-for-coding-highspeed": { coding: 8, reasoning: 7, cost: 0, context: 262144 },
};

export class KimiProvider extends OpenAICompatProvider {
  constructor(apiKey?: string | null) {
    super("kimi", "https://api.kimi.com/coding/v1", {
      apiKey,
      envVar: "KIMI_API_KEY",
      billing: "coding-plan",
      capabilitiesSeed: seed,
    });
  }
}
