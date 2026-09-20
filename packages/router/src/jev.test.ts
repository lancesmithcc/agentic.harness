import { afterEach, describe, expect, test } from "bun:test";
import type { Model, ProviderHealth } from "@harness/core";
import { JevDecider, jevConfig } from "./jev.ts";
import { routeAsync } from "./router.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const config = (over: Partial<ReturnType<typeof jevConfig>> = {}) => ({ ...jevConfig({ JEV_API_KEY: "test-key" } as NodeJS.ProcessEnv), ...over });

const answer = (category: string, confidence: number, noul = 0.9) => ({
  model: "jev-1.13.0",
  answers: {
    category: { type: "choice", choice: category, confidence, probabilities: { [category]: confidence } },
    requires_tools: { type: "noul", noul },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
});

const models: Model[] = [
  { id: "zai/glm", model: "glm", provider: "zai", capabilities: { coding: 9, reasoning: 7, tools: true, billing: "coding-plan" } },
  { id: "local/gemma", model: "gemma", provider: "local", capabilities: { summarization: 9, reasoning: 4, tools: true, local: true, billing: "local" } },
] as unknown as Model[];
const health = new Map<string, ProviderHealth>();

describe("jev decision model", () => {
  test("stays off without a key and never calls the API", async () => {
    const calls = stub(answer("simple", 1));
    const decider = new JevDecider(config({ apiKey: undefined }));
    expect(decider.enabled).toBe(false);
    expect((await decider.classify("summarize this")).signals.every(s => !s.startsWith("jev:"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("sends the task as state and returns the chosen category", async () => {
    const calls = stub(answer("debugging", 0.97));
    const result = await new JevDecider(config()).classify("why does the login test fail");
    expect(result.category).toBe("debugging");
    expect(result.confidence).toBeCloseTo(0.97);
    expect(result.jev).toMatchObject({ usedFallback: false, requiresTools: true });
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.body.state).toBe("why does the login test fail");
    expect(calls[0]!.body.model).toBe("jev-latest");
    expect(calls[0]!.body.questions.category.type).toBe("choice");
    expect(calls[0]!.body.questions.requires_tools.type).toBe("noul");
  });

  test("reads the tool answer from the noul field", async () => {
    stub(answer("simple", 0.95, 0.1));
    expect((await new JevDecider(config()).classify("what is 2 + 2")).jev?.requiresTools).toBe(false);
  });

  test("keeps the heuristic category when Jev is unsure, but keeps its tool answer", async () => {
    stub(answer("review", 0.31));
    const result = await new JevDecider(config()).classify("debug this stack trace");
    expect(result.category).toBe("debugging"); // heuristic, not Jev's low-confidence "review"
    expect(result.jev).toMatchObject({ usedFallback: true, requiresTools: true });
  });

  test("falls back to the heuristic when the API fails", async () => {
    stub({ error: "boom" }, 500);
    const result = await new JevDecider(config()).classify("debug this stack trace");
    expect(result.category).toBe("debugging");
    expect(result.jev).toBeUndefined();
  });

  test("caches a repeated task instead of paying for it twice", async () => {
    const calls = stub(answer("simple", 0.9));
    const decider = new JevDecider(config());
    await decider.classify("summarize this");
    await decider.classify("summarize this");
    expect(calls).toHaveLength(1);
  });
});

describe("routeAsync", () => {
  test("records Jev as the classifier and routes on its category", async () => {
    stub(answer("simple", 0.99, 0.1));
    const decision = await routeAsync({ task: "tidy up this sentence", models, health, delegation: null }, new JevDecider(config()));
    expect(decision.category).toBe("simple");
    expect(decision.classifiedBy).toBe("jev");
    expect(decision.selected).toBe("local/gemma");
  });

  test("never consults Jev for a pinned model", async () => {
    const calls = stub(answer("simple", 0.99));
    const decision = await routeAsync({ task: "anything", models, health, delegation: null, pinnedModel: "zai/glm" }, new JevDecider(config()));
    expect(decision.selected).toBe("zai/glm");
    expect(calls).toHaveLength(0);
  });

  test("Jev's tool answer can require an executing adapter, never relax one", async () => {
    stub(answer("general-coding", 0.99, 0.95));
    const decision = await routeAsync({ task: "have a look at the config", models, health, delegation: null }, new JevDecider(config()));
    expect(decision.reason.some(r => r.includes("requires file/tool execution"))).toBe(true);

    stub(answer("simple", 0.99, 0.02));
    const explicit = await routeAsync({ task: "say hello", models, health, delegation: null, requiresTools: true }, new JevDecider(config()));
    expect(explicit.reason.some(r => r.includes("requires file/tool execution"))).toBe(true);
  });

  test("routes by heuristic when the decider is absent", async () => {
    const decision = await routeAsync({ task: "debug this crash", models, health, delegation: null });
    expect(decision.classifiedBy).toBe("heuristic");
    expect(decision.category).toBe("debugging");
  });
});
