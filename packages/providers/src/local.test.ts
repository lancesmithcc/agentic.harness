import { describe, expect, test } from "bun:test";
import { LocalProvider } from "./local.ts";

describe("local context discovery", () => {
  test("adopts llama.cpp n_ctx for native route capacity", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "gemma" }] });
      if (url.endsWith("/props")) return Response.json({ default_generation_settings: { n_ctx: 8192 } });
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    try {
      const provider = new LocalProvider({ name: "gemma", url: "http://127.0.0.1:8088", kind: "llamacpp" });
      const models = await provider.models();
      expect(models).toHaveLength(1);
      expect(models[0]?.capabilities.context).toBe(8192);
      expect((provider as any).harnessRoute("gemma").capabilities.context).toBe(8192);
    } finally { globalThis.fetch = original; }
  });
});
