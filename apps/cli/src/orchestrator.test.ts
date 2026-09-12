import { describe, expect, test } from "bun:test";
import { askRouted, type OrchestratorContext } from "./orchestrator.ts";
import type { HarnessEvent, ModelProvider } from "@harness/core";

function provider(id: string, events: HarnessEvent[]): ModelProvider {
  return {
    id, kind: "api", async models() { return []; }, capabilities() { return {}; }, async health() { return { provider: id, ok: true, detail: "test", checkedAt: "" }; },
    async *generate() { for (const event of events) yield event; },
  };
}
function context(first: HarnessEvent[], second: HarnessEvent[]) {
  const records: unknown[] = [];
  return {
    records,
    ctx: {
      providers: new Map([["one", provider("one", first)], ["two", provider("two", second)]]),
      models: ["one/a", "two/b"].map((id) => ({ id, model: id.split("/")[1]!, provider: id.split("/")[0]!, capabilities: {} })),
      health: new Map(), delegation: null, profile: "test", session: { append(e: unknown) { records.push(e); } },
    } as unknown as OrchestratorContext,
  };
}

describe("askRouted stream recovery", () => {
  test("persists partial text and does not repeat it on a later error", async () => {
    const { ctx, records } = context(
      [{ type: "text-delta", text: "partial" }, { type: "error", fatal: true, error: Object.assign(new Error("gone"), { code: "provider-error" as const }) }],
      [{ type: "done", text: "fallback" }],
    );
    let journaledBeforeDelivery = false;
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a", onEvent: (event) => {
      if (event.type === "text-delta") journaledBeforeDelivery = (records.at(-1) as any)?.kind === "assistant-delta";
    } });
    expect(result.text).toBe("partial");
    expect(result.providerUsed).toBe("one");
    expect(result.outcome).toBe("interrupted");
    expect(records.some((r: any) => r.kind === "assistant-text" && r.text === "partial")).toBe(true);
    expect(journaledBeforeDelivery).toBe(true);
  });

  test("does not fallback after a tool-only response", async () => {
    const { ctx } = context(
      [{ type: "tool-call", id: "t", name: "write", arguments: "{}" }, { type: "error", fatal: true, error: Object.assign(new Error("gone"), { code: "provider-error" as const }) }],
      [{ type: "done", text: "must not run" }],
    );
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" });
    expect(result.providerUsed).toBe("one");
    expect(result.text).toBe("");
    expect(result.outcome).toBe("failed");
  });

  test("returns an interrupted partial result even with noFallback", async () => {
    const { ctx } = context(
      [{ type: "text-delta", text: "saved" }, { type: "error", fatal: true, error: Object.assign(new Error("gone"), { code: "provider-error" as const }) }],
      [{ type: "done", text: "must not run" }],
    );
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a", noFallback: true });
    expect(result).toMatchObject({ text: "saved", outcome: "interrupted" });
  });

  test("falls back on empty terminal response", async () => {
    const { ctx } = context([{ type: "done", text: "" }], [{ type: "done", text: "fallback" }]);
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" });
    expect(result.text).toBe("fallback");
    expect(result.outcome).toBe("completed");
  });

  test("accumulates usage emitted by multiple agent steps", async () => {
    const { ctx } = context([
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.1 } },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.2 } },
      { type: "done", text: "done" },
    ], []);
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" });
    expect(result.usage.inputTokens).toBe(7);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.usage.costUsd).toBeCloseTo(0.3);
  });
});
