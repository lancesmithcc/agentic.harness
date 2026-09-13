// FILE: packages/providers/src/openai-compat.ts
import type {
  ModelProvider, Model, ModelCapabilities, ProviderHealth, HarnessRequest, HarnessEvent, UsageReport, HarnessError,
} from "@harness/core";
import { generateHarness } from "./harness-runtime.ts";

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

/** Bound connection lifetime and stream silence, while preserving caller aborts. */
function boundedSignal(request: HarnessRequest, idleMs = 30_000): {
  signal: AbortSignal; touch(): void; dispose(): void; abortedByCaller(): boolean;
} {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const abort = (reason: unknown) => { if (!controller.signal.aborted) controller.abort(reason); };
  const total = setTimeout(() => abort(new Error("provider request timed out")), request.timeoutMs ?? 90_000);
  const onAbort = () => abort(request.signal?.reason ?? new Error("request cancelled"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => abort(new Error("provider stream idle timeout")), idleMs);
  };
  touch();
  return {
    signal: controller.signal, touch,
    dispose: () => { clearTimeout(total); if (idle) clearTimeout(idle); request.signal?.removeEventListener("abort", onAbort); },
    abortedByCaller: () => request.signal?.aborted === true,
  };
}

export abstract class OpenAICompatProvider implements ModelProvider {
  readonly kind: ModelProvider["kind"] = "api";
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
    // Execution is supplied by the same official agent runtime for every
    // API backend. Ordinary text requests retain the lightweight SSE path.
    return { ...(this.opts.defaultCapabilities ?? {}), ...(this.opts.capabilitiesSeed?.[model] ?? {}), tools: true };
  }

  configureEndpoint(baseUrl: string): void {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Model endpoint must use HTTP or HTTPS");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.modelsCache = null;
  }

  protected apiKey(): string | null {
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
    if (request.tools === true) {
      yield* generateHarness(request, { profile: request.profile ?? "home", route: {
        provider: this.id, model, baseUrl: this.baseUrl, apiKey: this.apiKey() ?? undefined,
        headers: this.opts.extraHeaders, capabilities: this.capabilities(model), billing: this.opts.billing ?? "api",
      } });
      return;
    }
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
    const bounds = boundedSignal(request);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST", headers, body, signal: bounds.signal,
      });
    } catch (e) {
      const code = bounds.abortedByCaller() ? "aborted" : "unavailable";
      yield { type: "error", error: harnessError(code, errMsg(e), { provider: this.id, model, retryable: code !== "aborted" }), fatal: true };
      bounds.dispose();
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
      bounds.dispose();
      return;
    }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let carry = "", text = "", ended = false, sawDoneSentinel = false;
    let finishReason: string | undefined, usage: UsageReport | undefined;
    let protocolError: string | null = null;
    // Some servers (MiniMax, raw DeepSeek/Qwen chat templates) inline reasoning
    // in content as <think>…</think>. Split it out so it never lands in the answer.
    let inThink = false, tagCarry = "";
    const emitPart = (t: string, out: HarnessEvent[]) => {
      if (inThink) { out.push({ type: "reasoning-delta", text: t }); return; }
      if (!text) t = t.replace(/^\s+/, ""); // drop the blank lines left behind </think>
      if (!t) return;
      text += t; out.push({ type: "text-delta", text: t });
    };
    const splitThink = (chunk: string, out: HarnessEvent[]) => {
      let s = tagCarry + chunk;
      tagCarry = "";
      while (s) {
        const tag = inThink ? "</think>" : "<think>";
        const i = s.indexOf(tag);
        if (i < 0) {
          // hold back a partial tag split across chunks
          let keep = 0;
          for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) { keep = k; break; }
          if (s.length > keep) emitPart(s.slice(0, s.length - keep), out);
          tagCarry = s.slice(s.length - keep);
          return;
        }
        if (i > 0) emitPart(s.slice(0, i), out);
        inThink = !inThink;
        s = s.slice(i + tag.length);
      }
    };
    const onLine = (raw: string): HarnessEvent[] => {
      const out: HarnessEvent[] = [];
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.startsWith("data:")) return out;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { ended = true; sawDoneSentinel = true; return out; }
      let parsed: any;
      try { parsed = JSON.parse(payload); }
      catch { protocolError = "provider sent malformed SSE JSON"; ended = true; return out; }
      if (parsed?.error) {
        const detail = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : JSON.stringify(parsed.error);
        protocolError = `provider error: ${detail.slice(0, 400)}`;
        ended = true;
        return out;
      }
      const choice = parsed.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) out.push({ type: "reasoning-delta", text: delta.reasoning_content });
      else if (typeof delta.reasoning === "string" && delta.reasoning) out.push({ type: "reasoning-delta", text: delta.reasoning });
      if (typeof delta.content === "string" && delta.content) splitThink(delta.content, out);
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
        bounds.touch();
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
      if (tagCarry) {
        const out: HarnessEvent[] = [];
        const rest = tagCarry;
        tagCarry = "";
        emitPart(rest, out);
        for (const ev of out) yield ev;
      }
    } catch (e) {
      const code = bounds.abortedByCaller() ? "aborted" : "unavailable";
      yield { type: "error", error: harnessError(code, errMsg(e), { provider: this.id, model, retryable: code !== "aborted" }), fatal: true };
      return;
    } finally {
      // Generators can be stopped by a consumer before EOF. Release the
      // reader and every timer/listener in that path as well as normal EOF.
      try { await reader.cancel(); } catch { /* body already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      bounds.dispose();
    }
    this.lastUsage = usage ?? null;
    if (usage) yield { type: "usage", usage };
    yield { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started };
    if (protocolError) {
      yield { type: "error", error: harnessError("provider-error", protocolError, { provider: this.id, model }), fatal: true };
      return;
    }
    if (finishReason && finishReason !== "stop") {
      const detail = finishReason === "length"
        ? "provider stopped because the output reached its length limit"
        : finishReason === "content_filter"
          ? "provider stopped due to content filtering"
          : finishReason === "tool_calls"
            ? "provider requested tools in a text-only request; enable tool execution for this turn"
            : `provider stopped with finish_reason ${finishReason}`;
      yield { type: "error", error: harnessError("provider-error", detail, { provider: this.id, model }), fatal: true };
      return;
    }
    if (!sawDoneSentinel && finishReason !== "stop") {
      yield { type: "error", error: harnessError("provider-error", "provider stream ended without a completion marker", { provider: this.id, model }), fatal: true };
      return;
    }
    yield { type: "done", ...(finishReason ? { finishReason } : {}), text };
  }
}
