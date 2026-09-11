/**
 * Local model adapter (PRD §15): Ollama, llama.cpp server, LM Studio, MLX,
 * or any OpenAI-compatible localhost endpoint. Local models are first-class
 * citizens: private:true, cost:0, preferred for simple/preprocessing work.
 */
import { join } from "node:path";
import type {
  ModelProvider,
  Model,
  ModelCapabilities,
  ProviderHealth,
  HarnessRequest,
  HarnessEvent,
  UsageReport,
  HarnessError,
} from "@harness/core";
import { harnessError } from "./claude-code.ts";

export interface LocalEndpoint {
  name: string;
  url: string;
  model?: string;
  kind?: "ollama" | "llamacpp" | "lmstudio" | "mlx" | "openai-compat";
}

const LOCAL_CAPS: ModelCapabilities = {
  coding: 6,
  reasoning: 6,
  summarization: 9,
  tools: false,
  local: true,
  private: true,
  cost: 0,
  billing: "local",
  context: 131072,
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

export class LocalProvider implements ModelProvider {
  readonly id: string;
  readonly kind = "local" as const;
  private modelsCache: Model[] | null = null;
  private cacheAt = 0;

  constructor(
    public endpoint: LocalEndpoint,
    private apiKey?: string | null,
  ) {
    this.id = `local`;
  }

  get baseUrl(): string {
    return this.endpoint.url.replace(/\/$/, "") + "/v1";
  }

  async models(): Promise<Model[]> {
    if (this.modelsCache && Date.now() - this.cacheAt < 60_000) return this.modelsCache;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
      const list = (body.data ?? []).map((m) => ({
        id: `${this.id}/${m.id}`,
        model: m.id,
        provider: this.id,
        name: m.id,
        capabilities: {
          ...LOCAL_CAPS,
          tools: this.endpoint.kind === "ollama", // llama.cpp has no native tool calling here
          context: m.id.includes("gemma") ? 262144 : LOCAL_CAPS.context,
        },
      }));
      this.modelsCache = list;
      this.cacheAt = Date.now();
      return list;
    } catch {
      return [];
    }
  }

  capabilities(model: string): ModelCapabilities {
    return { ...LOCAL_CAPS };
  }

  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const model = request.model.includes("/") ? request.model.split("/").slice(1).join("/") : request.model;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.images?.length ? { images: m.images } : {}),
          })),
          stream: true,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal: AbortSignal.timeout(600000),
      });
    } catch (err) {
      yield {
        type: "error",
        error: harnessError("unavailable", `local server ${this.endpoint.url} unreachable: ${(err as Error).message}`, {
          provider: this.id,
          model,
        }),
        fatal: true,
      };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const code: HarnessError["code"] = res.status === 401 ? "auth" : "provider-error";
      yield {
        type: "error",
        error: harnessError(code, `local server error ${res.status}: ${text.slice(0, 300)}`, {
          provider: this.id,
          model,
          status: res.status,
          retryable: res.status >= 500,
        }),
        fatal: true,
      };
      return;
    }

    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let finishReason: string | undefined;
    let usage: UsageReport | null = null;

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content };
        if (delta?.content) {
          full += delta.content;
          yield { type: "text-delta", text: delta.content };
        }
        const fr = json.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (json.usage) {
          usage = {
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            totalTokens: (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
            billing: "local",
          };
        }
      }
    }

    if (usage) yield { type: "usage", usage };
    yield { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started };
    yield { type: "done", finishReason, text: full };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { provider: this.id, ok: false, detail: `HTTP ${res.status} at ${this.endpoint.url}`, checkedAt };
      const body = (await res.json()) as { data?: unknown[] };
      return {
        provider: this.id,
        ok: true,
        detail: `${this.endpoint.kind ?? "openai-compat"} at ${this.endpoint.url} (${body.data?.length ?? 0} models)`,
        modelsFound: body.data?.length ?? 0,
        checkedAt,
      };
    } catch {
      return { provider: this.id, ok: false, detail: `no server at ${this.endpoint.url}`, checkedAt };
    }
  }
}

/** Convenience: provider id for a named local endpoint (single-endpoint v1). */
export function localModelPath(endpoint: LocalEndpoint, model: string): string {
  return join("local", model);
}
