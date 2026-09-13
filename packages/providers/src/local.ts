/**
 * Local model adapter (PRD §15): Ollama, llama.cpp server, LM Studio, MLX,
 * or any OpenAI-compatible localhost endpoint. Local models are first-class
 * citizens: private:true, cost:0, preferred for simple/preprocessing work.
 */
import { join } from "node:path";
import type { HarnessEvent, HarnessRequest, Model, ModelCapabilities, ProviderHealth } from "@harness/core";
import { OpenAICompatProvider } from "./openai-compat.ts";

export interface LocalEndpoint {
  name: string;
  url: string;
  model?: string;
  kind?: "ollama" | "llamacpp" | "lmstudio" | "mlx" | "openai-compat";
  contextWindow?: number;
}

const LOCAL_CAPS: ModelCapabilities = {
  coding: 6,
  reasoning: 6,
  summarization: 9,
  tools: true,
  local: true,
  private: true,
  cost: 0,
  billing: "local",
  context: 8192,
};

/** Probe common localhost ports to detect running local runtimes. */
export async function detectLocalEndpoints(): Promise<LocalEndpoint[]> {
  const candidates: Array<{ port: number; name: string; kind: LocalEndpoint["kind"] }> = [
    { port: 8088, name: "gemma-llamacpp", kind: "llamacpp" }, // delegate-to-gemma4 default
    { port: 11434, name: "ollama", kind: "ollama" },
    { port: 1234, name: "lmstudio", kind: "lmstudio" },
    { port: 8080, name: "llamacpp", kind: "llamacpp" },
    { port: 1235, name: "mlx", kind: "mlx" },
  ];
  const found: LocalEndpoint[] = [];
  await Promise.all(
    candidates.map(async (c) => {
      try {
        const res = await fetch(`http://127.0.0.1:${c.port}/v1/models`, { signal: AbortSignal.timeout(1200) });
        if (!res.ok) return;
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        if (body.data?.length) found.push({ name: c.name, url: `http://127.0.0.1:${c.port}`, kind: c.kind });
      } catch {
        // not running
      }
    }),
  );
  return found;
}

/** Local models use the same streaming and tool runtime as remote API models. */
export class LocalProvider extends OpenAICompatProvider {
  override readonly kind = "local" as const;
  private contextWindow = 8192;
  private contextCheckedAt = 0;
  private contextPending?: Promise<void>;

  constructor(public endpoint: LocalEndpoint, apiKey?: string | null) {
    const url = endpoint.url.replace(/\/+$/, "");
    super("local", url.endsWith("/v1") ? url : `${url}/v1`, {
      apiKey, billing: "local", defaultCapabilities: LOCAL_CAPS,
    });
    this.contextWindow = endpoint.contextWindow ?? 8192;
  }

  override capabilities(model: string): ModelCapabilities {
    return { ...LOCAL_CAPS, context: this.contextWindow };
  }

  private async refreshContext(): Promise<void> {
    if (this.endpoint.contextWindow || Date.now() - this.contextCheckedAt < 60_000) return;
    if (this.contextPending) return this.contextPending;
    this.contextPending = (async () => {
      try {
        const key = this.apiKey();
        const response = await fetch(`${this.baseUrl.replace(/\/v1$/, "")}/props`, {
          headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) return;
        const body = await response.json() as { default_generation_settings?: { n_ctx?: number } };
        const context = body.default_generation_settings?.n_ctx;
        if (typeof context === "number" && Number.isFinite(context) && context >= 1024) this.contextWindow = Math.floor(context);
      } catch { /* Other local runtimes can set contextWindow explicitly. */ }
      finally { this.contextCheckedAt = Date.now(); }
    })();
    try { await this.contextPending; } finally { this.contextPending = undefined; }
  }

  override async models(): Promise<Model[]> {
    const [models] = await Promise.all([super.models(), this.refreshContext()]);
    return models.map(model => ({ ...model, capabilities: this.capabilities(model.model) }));
  }

  override async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    await this.refreshContext();
    yield* super.generate({ ...request, maxTokens: Math.min(request.maxTokens ?? 8192, Math.floor(this.contextWindow / 4)) });
  }

  override async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const key = this.apiKey();
      const res = await fetch(`${this.baseUrl}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { provider: this.id, ok: false, detail: `HTTP ${res.status} at ${this.endpoint.url}`, checkedAt };
      const body = await res.json() as { data?: unknown[] };
      return { provider: this.id, ok: true, detail: `${this.endpoint.kind ?? "openai-compat"} at ${this.endpoint.url} (${body.data?.length ?? 0} models)`, modelsFound: body.data?.length ?? 0, checkedAt };
    } catch {
      return { provider: this.id, ok: false, detail: `no server at ${this.endpoint.url}`, checkedAt };
    }
  }
}

/** Convenience: provider id for a named local endpoint (single-endpoint v1). */
export function localModelPath(endpoint: LocalEndpoint, model: string): string {
  return join("local", model);
}
