import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "./openai.ts";
import { MiniMaxProvider } from "./minimax.ts";

const routeOf = (provider: object, model: string) => (provider as any).harnessRoute(model);

describe("native SDK provider routes", () => {
  test("uses Responses only for the official OpenAI endpoint", () => {
    const official = new OpenAIProvider("test");
    expect(routeOf(official, "gpt-5.6-sol")).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1", api: "openai-responses" });
    official.configureEndpoint("https://gateway.example/v1/");
    const custom = routeOf(official, "gpt-5.6-sol");
    expect(custom.baseUrl).toBe("https://gateway.example/v1"); expect(custom.api).toBeUndefined();
  });

  test("uses Anthropic Messages only for the official MiniMax endpoint", () => {
    const official = new MiniMaxProvider("test");
    expect(routeOf(official, "MiniMax-M3")).toMatchObject({ provider: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages" });
    official.configureEndpoint("https://gateway.example/v1/");
    const custom = routeOf(official, "MiniMax-M3");
    expect(custom.baseUrl).toBe("https://gateway.example/v1"); expect(custom.api).toBeUndefined();
  });
});
