// FILE: packages/providers/src/openai-compat.ts
import type {
  ModelProvider, Model, ModelCapabilities, ProviderHealth, HarnessRequest, HarnessEvent, UsageReport, HarnessError,
} from "@harness/core";

export interface OpenAICompatProviderOptions {
  apiKey?: string | null;
  envVar?: string;
  capabilitiesSeed?: Record<string, ModelCapabilities>;
  defaultCapabilities?: ModelCapabilities;
  extraHeaders?: Record<string, string>;
  billing?: "api" | "coding-plan" | "local";
}

export function harnessError(
  code: HarnessError["code"],
  message: string,
  opts: { provider?: string; model?: string; retryable?: boolean; status?: number } = {},
): HarnessError {
  const err = new Error(message) as HarnessError;
  err.code = code;
  err.provider = opts.provider;
  err.model = opts.model;
  err.retryable = opts.retryable;
  err.status = opts.status;
  return err;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export abstract class OpenAICompatProvider implements ModelProvider {
  readonly kind = "api" as const;
  protected sendStreamOptions = true;
  lastUsage: UsageReport | null = null;
  private modelsCache: Model[] | null = null;
  private modelsCacheAt = 0;
  private modelsError: string | null = null;

  constructor(
    readonly id: string,
    protected baseUrl: string,
    protected opts: OpenAICompatProviderOptions = {},
  ) {}

  capabilities(model: string): ModelCapabilities {
    return { ...(this.opts.defaultCapabilities ?? {}), ...(this.opts.capabilitiesSeed?.[model] ?? {}) };
  }

  private apiKey(): string | null {
    if (this.opts.apiKey) return this.opts.apiKey;
    if (this.opts.envVar) {
      const v = process.env[this.opts.envVar];
      if (v && v.trim()) return v.trim();
    }
    return null;
  }

  private seedModels(): Model[] {
    return Object.keys(this.opts.capabilitiesSeed ?? {}).map((m) => ({
      id: `${this.id}/${m}`, model: m, provider: this.id, name: m, capabilities: this.capabilities(m),
    }));
  }

  async models(): Promise<Model[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCacheAt < 60_000) return this.modelsCache;
    const headers: Record<string, string> = {};
    const key = this.apiKey();
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`GET ${this.baseUrl}/models -> ${res.status}`);
      const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      this.modelsCache = (json.data ?? []).map((m) => ({
        id: `${this.id}/${m.id}`, model: m.id, provider: this.id, name: m.display_name ?? m.id, capabilities: this.capabilities(m.id),
      }));
      this.modelsCacheAt = now;
      this.modelsError = null;
      return this.modelsCache;
    } catch (e) {
      this.modelsError = errMsg(e);
      return this.seedModels();
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.apiKey()) return { provider: this.id, ok: false, detail: `no API key (env ${this.opts.envVar ?? "unset"})`, checkedAt };
    const models = await this.models();
    if (this.modelsError) return { provider: this.id, ok: false, detail: this.modelsError, checkedAt };
    return { provider: this.id, ok: true, detail: `${models.length} models via ${this.baseUrl}`, checkedAt };
  }

  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const slash = request.model.indexOf("/");
    const model = slash >= 0 ? request.model.slice(slash + 1) : request.model;
    const started = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = this.apiKey();
    if (key) headers.authorization = `Bearer ${key}`;
    Object.assign(headers, this.opts.extraHeaders ?? {});
    const body = JSON.stringify({
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      ...(this.sendStreamOptions ? { stream_options: { include_usage: true } } : {}),
    });
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST", headers, body, signal: AbortSignal.timeout(300_000),
      });
    } catch (e) {
      yield { type: "error", error: harnessError("unavailable", errMsg(e), { provider: this.id, model, retryable: true }), fatal: true };
      return;
    }
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      const status = res.status;
      let code: HarnessError["code"] = "provider-error";
      let retryable: boolean | undefined;
      if (status === 401 || status === 403) code = "auth";
      else if (status === 429) code = "rate-limit";
      else if (status === 400 && /context|length|token limit/i.test(errText)) code = "context-length";
      else if (status >= 500) retryable = true;
      yield { type: "error", error: harnessError(code, `${status} ${errText.slice(0, 400)}`, { provider: this.id, model, status, retryable }), fatal: code === "auth" };
      return;
    }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let carry = "", text = "", ended = false;
    let finishReason: string | undefined, usage: UsageReport | undefined;
    const onLine = (raw: string): HarnessEvent[] => {
      const out: HarnessEvent[] = [];
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.startsWith("data:")) return out;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { ended = true; return out; }
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch { return out; }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content; out.push({ type: "text-delta", text: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) out.push({ type: "reasoning-delta", text: delta.reasoning_content });
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) out.push({ type: "tool-call", id: tc?.id ?? "", name: tc?.function?.name ?? "", arguments: tc?.function?.arguments ?? "" });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed.usage) {
        const u = parsed.usage;
        const rt: number | undefined = u.completion_tokens_details?.reasoning_tokens;
        usage = {
          inputTokens: u.prompt_tokens,
          outputTokens: u.completion_tokens,
          ...(typeof rt === "number" ? { reasoningTokens: rt } : {}),
          totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          billing: this.opts.billing ?? "api",
        };
      }
      return out;
    };
    try {
      while (!ended) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        for (let nl = carry.indexOf("\n"); nl >= 0; nl = carry.indexOf("\n")) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          for (const ev of onLine(line)) yield ev;
          if (ended) break;
        }
      }
      carry += decoder.decode();
      if (!ended && carry) {
        for (const line of carry.split("\n")) {
          for (const ev of onLine(line)) yield ev;
          if (ended) break;
        }
      }
    } catch (e) {
      yield { type: "error", error: harnessError("unavailable", errMsg(e), { provider: this.id, model, retryable: true }), fatal: true };
      return;
    }
    this.lastUsage = usage ?? null;
    if (usage) yield { type: "usage", usage };
    yield { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started };
    yield { type: "done", ...(finishReason ? { finishReason } : {}), text };
  }
}
