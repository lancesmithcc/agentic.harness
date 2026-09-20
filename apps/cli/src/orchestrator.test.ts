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
      health: new Map(), delegation: null, profile: "test", session: { append(e: unknown) { records.push(e); }, all() { return records as any[]; } },
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
    ctx.models[0]!.capabilities.tools = true;
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" });
    expect(result.providerUsed).toBe("one");
    expect(result.text).toBe("");
    expect(result.outcome).toBe("failed");
  });

  test("journals bounded tool results before UI delivery and never falls back", async () => {
    const { ctx, records } = context(
      [{ type: "tool-result", id: "r1", name: "write_file", content: "created output.txt" }, { type: "error", fatal: true, error: Object.assign(new Error("lost"), { code: "provider-error" as const }) }],
      [{ type: "done", text: "must not run" }],
    );
    ctx.models[0]!.capabilities.tools = true;
    let persisted = false;
    const result = await askRouted(ctx, "write a file", [{ role: "user", content: "x" }], { pinnedModel: "one/a", onEvent(event) {
      if (event.type === "tool-result") persisted = (records.at(-1) as any)?.kind === "tool-result";
    } });
    const entry = records.find((record: any) => record.kind === "tool-result") as any;
    expect(persisted).toBe(true);
    expect(entry).toMatchObject({ id: "r1", name: "write_file", provider: "one", model: "one/a" });
    expect(result).toMatchObject({ providerUsed: "one", outcome: "failed", text: "" });
  });

  test("uses tool runtime for a file inspection request and tool-bearing follow-up", async () => {
    const captured: any[] = [];
    const p = provider("one", [{ type: "done", text: "ok" }]);
    p.generate = async function* (request) { captured.push(request); yield { type: "done", text: "ok" }; };
    const records: any[] = [{ v: 1, ts: new Date().toISOString(), kind: "tool-call", id: "prior", name: "read", arguments: "{}" }];
    const ctx = { providers: new Map([["one", p]]), models: [{ id: "one/a", model: "a", provider: "one", capabilities: { tools: true } }], health: new Map(), delegation: null, profile: "work", session: { append(e: unknown) { records.push(e); }, all() { return records; } } } as unknown as OrchestratorContext;
    await askRouted(ctx, "inspect the repository files", [{ role: "user", content: "x" }], { pinnedModel: "one/a", request: { access: "read-only" } });
    await askRouted(ctx, "please continue", [{ role: "user", content: "x" }], { pinnedModel: "one/a", request: { access: "read-only" } });
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ tools: true, profile: "work", access: "read-only", cwd: process.cwd() });
    expect(captured[1].tools).toBe(true);
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

  test("reports why a stream was empty instead of calling it empty output", async () => {
    // A 402 is not fallback-worthy, so its message used to vanish and the turn
    // looked like an unexplained empty response.
    const balance = Object.assign(new Error("402 insufficient balance (1008)"), { code: "provider-error" as const });
    const { ctx } = context([{ type: "error", fatal: false, error: balance }], [{ type: "done", text: "fallback" }]);
    const result = await askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" });
    expect(result.text).toBe("fallback");
    expect(result.fellBack).toHaveLength(1);
    expect(result.fellBack[0]!.cause).toContain("insufficient balance");
  });

  test("noFallback stops at the selected model and surfaces its error", async () => {
    const balance = Object.assign(new Error("402 insufficient balance (1008)"), { code: "provider-error" as const });
    const { ctx } = context([{ type: "error", fatal: false, error: balance }], [{ type: "done", text: "must not run" }]);
    await expect(
      askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a", noFallback: true }),
    ).rejects.toThrow("insufficient balance");
  });

  test("an exhausted chain never silently runs the next model without recording the hop", async () => {
    const { ctx } = context([{ type: "done", text: "" }], [{ type: "done", text: "" }]);
    await expect(askRouted(ctx, "x", [{ role: "user", content: "x" }], { pinnedModel: "one/a" })).rejects.toThrow("produced no output");
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
