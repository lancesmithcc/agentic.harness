import type { ModelCapabilities } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

const defaultCapabilities: ModelCapabilities = { coding: 8, reasoning: 8 };

export class OpenRouterProvider extends OpenAICompatProvider {
  constructor(apiKey?: string | null) {
    super("openrouter", "https://openrouter.ai/api/v1", {
      apiKey,
      envVar: "OPENROUTER_API_KEY",
      billing: "api",
      defaultCapabilities,
      extraHeaders: {
        "HTTP-Referer": "https://deepharness.local",
        "X-Title": "DeepHarness",
      },
    });
  }
}
