import { describe, expect, test } from "bun:test";
import { OpenAICompatProvider } from "./openai-compat.ts";

class TestProvider extends OpenAICompatProvider {
  constructor() { super("test", "https://provider.invalid/v1", { apiKey: "x" }); }
}
function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
}

describe("OpenAI-compatible streaming", () => {
  test("joins split SSE chunks and flushes a truncated final line", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(stream([
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}'
    ]))) as typeof fetch;
    try {
      const events = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [] }));
      expect(events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("hello world");
      expect(events.at(-1)).toMatchObject({ type: "done", text: "hello world" });
    } finally { globalThis.fetch = original; }
  });

  test("reports caller cancellation as aborted", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
    const controller = new AbortController(); controller.abort();
    try {
      const events = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [], signal: controller.signal }));
      expect(events[0]).toMatchObject({ type: "error", error: { code: "aborted" } });
    } finally { globalThis.fetch = original; }
  });

  test("treats EOF without a completion marker as a fatal partial stream", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']))) as typeof fetch;
    try {
      const events = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [] }));
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error", fatal: true, error: { code: "provider-error" } });
    } finally { globalThis.fetch = original; }
  });

  test("rejects malformed and provider-error SSE payloads", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(stream(["data: {bad json}\n\n"]))) as typeof fetch;
      const malformed = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [] }));
      expect(malformed.at(-1)).toMatchObject({ type: "error", error: { code: "provider-error" } });
      globalThis.fetch = (async () => new Response(stream(['data: {"error":{"message":"quota denied"}}\n\n']))) as typeof fetch;
      const providerError = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [] }));
      expect(providerError.at(-1)).toMatchObject({ type: "error", fatal: true, error: { code: "provider-error" } });
    } finally { globalThis.fetch = original; }
  });

  test("reports non-text terminal reasons as interrupted instead of done", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(stream(['data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n\n']))) as typeof fetch;
    try {
      const events = await Array.fromAsync(new TestProvider().generate({ model: "test/x", messages: [] }));
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "provider-error" } });
    } finally { globalThis.fetch = original; }
  });

  test("cancels and releases its reader when a consumer stops early", async () => {
    const original = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"one"}}]}\n\n')); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    try {
      const iterator = new TestProvider().generate({ model: "test/x", messages: [] })[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(cancelled).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test("does not advertise unsupported tool execution", () => {
    expect(new TestProvider().capabilities("x").tools).toBe(false);
  });
});
