import { describe, expect, test } from "bun:test";
import { route, taskRequiresTools } from "./router.ts";
import { parseDelegation } from "./delegation.ts";
import type { Model, ModelCapabilities } from "@harness/core";

const mk = (id: string, caps: ModelCapabilities): Model => {
  const [provider, ...rest] = id.split("/");
  return { id, provider: provider!, model: rest.join("/"), capabilities: caps };
};

function makeModels(): Model[] {
  return [
    mk("local/gemma-4-12b-it", {
      summarization: 9,
      coding: 6,
      reasoning: 6,
      local: true,
      private: true,
      billing: "local",
      context: 262144,
    }),
    mk("zai/glm-5.3-flash", { coding: 8, reasoning: 7, billing: "coding-plan", context: 128000 }),
    mk("zai/glm-5.3", { coding: 9, reasoning: 9, billing: "coding-plan", context: 128000 }),
    mk("kimi/k3", { coding: 10, reasoning: 10, context: 262144, billing: "coding-plan", thinking: true }),
    mk("deepseek/deepseek-v4-pro", { coding: 9, reasoning: 9, billing: "api", context: 128000, tools: true }),
    mk("claude-code/default", { coding: 10, reasoning: 10, billing: "subscription", context: 200000, tools: true }),
  ];
}

function health(down?: string): Map<string, { ok: boolean }> {
  const m = new Map<string, { ok: boolean }>();
  for (const p of ["local", "zai", "kimi", "deepseek", "claude-code"]) m.set(p, { ok: true });
  if (down) m.set(down, { ok: false });
  return m;
}

type RouteResult = {
  selected: string;
  reason: string[];
  classifiedBy: string;
  fallbacks: string[];
};

const R = (opts: Record<string, unknown>): RouteResult =>
  (route as unknown as (o: unknown) => RouteResult)(opts);

describe("router.route", () => {
  test("summarize and extract tags selects local gemma", () => {
    const res = R({ task: "summarize and extract tags", models: makeModels(), health: health() });
    expect(res.selected).toBe("local/gemma-4-12b-it");
  });

  test("delegation table boosts deepseek for debugging task", () => {
    const tsv = [
      "Model\t⭐ **Role**\tBest For\tAvoid For",
      "DeepSeek V4 Pro\t⭐ **Debugging specialist**\tDebugging, multi-file edits, tests, refactors\tDeep architecture",
    ].join("\n");
    const res = R({
      task: "fix this bug and debug the failing tests",
      models: makeModels(),
      health: health(),
      delegation: parseDelegation(tsv),
    });
    expect(res.selected).toBe("deepseek/deepseek-v4-pro");
    expect(res.reason.join(" ")).toContain("delegation.md");
  });

  test("fallbacks are diverse and unique", () => {
    const res = R({
      task: "architect a large migration",
      models: makeModels(),
      health: health(),
      pinnedModel: "claude-code/default",
    });
    const fallbacks = res.fallbacks ?? [];
    const otherClaude = fallbacks.filter(
      (id) => id.startsWith("claude-code/") && id !== "claude-code/default",
    );
    expect(otherClaude.length).toBeLessThanOrEqual(1);
    expect(new Set(fallbacks).size).toBe(fallbacks.length);
  });

  test("health filter excludes claude-code for architecture task", () => {
    const res = R({
      task: "design the system architecture",
      models: makeModels(),
      health: health("claude-code"),
    });
    expect(res.selected).not.toBe("claude-code/default");
  });

  test("pinnedModel wins with classifiedBy manual-pin", () => {
    const res = R({
      task: "do anything",
      models: makeModels(),
      health: health(),
      pinnedModel: "kimi/k3",
    });
    expect(res.selected).toBe("kimi/k3");
    expect(res.classifiedBy).toBe("manual-pin");
  });

  test("local_first frontmatter routes simple task locally", () => {
    const text = ["---", "local_first: true", "routing:", "  simple: [gemma-local]", "---"].join("\n");
    const res = R({
      task: "classify these files",
      models: makeModels(),
      health: health(),
      delegation: parseDelegation(text),
    });
    expect(res.selected).toBe("local/gemma-4-12b-it");
    expect(res.classifiedBy).toBe("delegation-frontmatter");
  });

  test("escalate moves local selection off the front", () => {
    const res = R({
      task: "summarize this",
      models: makeModels(),
      health: health(),
      escalate: true,
    });
    expect(res.selected).not.toBe("local/gemma-4-12b-it");
  });

  test("action tasks exclude text-only adapters from selection and fallback", () => {
    const models = [
      mk("api/text", { coding: 10, reasoning: 10, billing: "api", tools: false }),
      mk("agent/runner", { coding: 7, reasoning: 7, billing: "subscription", tools: true }),
    ];
    const res = R({ task: "fix the failing test and run it", models, health: new Map() });
    expect(res.selected).toBe("agent/runner");
    expect(res.fallbacks).not.toContain("api/text");
  });
  test("workspace inspection and tool requests require an executable runtime", () => {
    expect(taskRequiresTools("inspect the repository files and list folders")).toBe(true);
    expect(taskRequiresTools("use the MCP tool to search the workspace")).toBe(true);
    expect(taskRequiresTools("summarize this paragraph about tools")).toBe(false);
    const models = [mk("api/text", { reasoning: 10, tools: false }), mk("agent/runner", { reasoning: 6, tools: true })];
    const res = R({ task: "read the project files", models, health: new Map() });
    expect(res.selected).toBe("agent/runner");
  });

  test("action tasks return no route when only text adapters are healthy", () => {
    const res = R({ task: "fix this file", models: [mk("api/text", { coding: 10, tools: false })], health: new Map() });
    expect(res.selected).toBe("none");
  });
  test("manual pins cannot pretend text-only adapters execute tools", () => {
    const res = R({ task: "fix this file", models: makeModels(), health: health(), pinnedModel: "kimi/k3" });
    expect(res.selected).toBe("none");
    expect(res.reason.join(" ")).toContain("text replies only");
  });
  test("manual agent fallbacks exclude unhealthy and text-only providers", () => {
    const res = R({ task: "fix this file", models: makeModels(), health: health("deepseek"), pinnedModel: "claude-code/default" });
    expect(res.selected).toBe("claude-code/default");
    expect(res.fallbacks).toEqual([]);
  });

  test("frontmatter reports only actually unresolved references", () => {
    const delegation = parseDelegation(["---", "routing:", "  simple: [gemma-local, absent-model]", "---"].join("\n"));
    const res = R({ task: "summarize this", models: makeModels(), health: health(), delegation });
    expect(res.reason.join(" ")).toContain('could not resolve "absent-model"');
    expect(res.reason.join(" ")).not.toContain('could not resolve "gemma-local"');
  });
});
