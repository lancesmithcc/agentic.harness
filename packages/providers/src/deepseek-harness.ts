/** The official DeepSeek Harness SDK runtime, distinct from text-only API chat. */
import type { HarnessEvent, HarnessRequest, Model, ModelCapabilities, ModelProvider, ProviderHealth } from "@harness/core";
import { generateHarness, runtimeHealth, type RuntimeRoute } from "./harness-runtime.ts";
import { harnessError } from "./claude-code.ts";

export { DSH_VERSION, generateHarness, runtimeHealth } from "./harness-runtime.ts";
export type { RuntimeRoute, RuntimeHealth, HarnessApi } from "./harness-runtime.ts";
const models = ["deepseek-v4-flash", "deepseek-v4-pro"];

export class DeepSeekHarnessProvider implements ModelProvider {
  readonly id = "deepseek-harness";
  readonly kind = "api" as const;
  constructor(private profile: string, private apiKey?: string | null) {}
  capabilities(model: string): ModelCapabilities {
    return { coding: 9, reasoning: model.endsWith("pro") ? 9 : 8, tools: true, context: 128000, billing: "api", thinking: true };
  }
  async models(): Promise<Model[]> { return models.map(model => ({ id: `${this.id}/${model}`, model, provider: this.id, name: `DeepSeek Harness · ${model.endsWith("pro") ? "Pro" : "Flash"}`, capabilities: this.capabilities(model) })); }
  private route(model: string): RuntimeRoute { return { provider: "deepseek-official", model, apiKey: this.apiKey ?? process.env.DEEPSEEK_API_KEY, capabilities: this.capabilities(model), billing: "api" }; }
  async health(): Promise<ProviderHealth> {
    const health = await runtimeHealth(this.route(models[0]!));
    return { provider: this.id, ...health, checkedAt: new Date().toISOString() };
  }
  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const model = request.model.split("/").at(-1)!;
    if (!models.includes(model)) { yield { type: "error", error: harnessError("unavailable", `unsupported DeepSeek Harness model: ${model}`), fatal: true }; return; }
    yield* generateHarness(request, { profile: this.profile, route: this.route(model) });
  }
}
