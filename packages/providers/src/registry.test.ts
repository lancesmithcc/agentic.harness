import { describe, expect, test } from "bun:test";
import { fleetModels, type Fleet } from "./registry.ts";
import type { ModelProvider } from "@harness/core";

const never: ModelProvider = {
  id: "stuck", kind: "api", capabilities() { return {}; },
  async models() { return await new Promise<never>(() => {}); },
  async health() { return { provider: "stuck", ok: true, detail: "test", checkedAt: "" }; },
  async *generate() { yield { type: "done" as const, text: "" }; },
};
const ready: ModelProvider = {
  id: "ready", kind: "api", capabilities() { return {}; },
  async models() { return [{ id: "ready/x", model: "x", provider: "ready", capabilities: {} }]; },
  async health() { return { provider: "ready", ok: true, detail: "test", checkedAt: "" }; },
  async *generate() { yield { type: "done" as const, text: "" }; },
};

describe("fleetModels", () => {
  test("returns healthy provider models when another provider discovery never settles", async () => {
    const fleet = { profile: "test", providers: new Map([["stuck", never], ["ready", ready]]), config: { capabilityOverrides: {} } } as unknown as Fleet;
    const started = Date.now();
    const models = await fleetModels(fleet, { timeoutMs: 20 });
    expect(models.map((m) => m.id)).toEqual(["ready/x"]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
