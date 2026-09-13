import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";
import type { RuntimeRoute } from "./harness-runtime.ts";

const seed: Record<string, ModelCapabilities> = {
  "MiniMax-M3": { coding: 8, reasoning: 8, cost: 0.3, context: 1000000, longContext: true, vision: true, tools: true },
  "MiniMax-M2.7": { coding: 7, reasoning: 6, cost: 0.1, context: 200000 },
};

export class MiniMaxProvider extends OpenAICompatProvider {
  protected override harnessRoute(model: string): RuntimeRoute {
    const route = super.harnessRoute(model);
    // Native content blocks preserve separate thinking, text and tool results.
    return this.baseUrl === "https://api.minimax.io/v1"
      ? { ...route, api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" }
      : route;
  }

  constructor(apiKey?: string | null) {
    super("minimax", "https://api.minimax.io/v1", {
      apiKey,
      envVar: "MINIMAX_API_KEY",
      billing: "api",
      capabilitiesSeed: seed,
    });
  }
}
