import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessEvent } from "@harness/core";
import { generateHarness } from "./harness-runtime.ts";

const packagedNode = "/Applications/agentic.harness.app/Contents/Resources/node-runtime/bin/node";
const sourceNode = join(process.cwd(), "apps/desktop/.runtime/node/bin/node");
const sourceBridge = join(process.cwd(), "packages/providers/runtime/deepseek-bridge.mjs");
const node = existsSync(packagedNode) ? packagedNode : existsSync(sourceNode) ? sourceNode : undefined;
const canRun = Boolean(node && existsSync(sourceBridge));

type Turn = { body: Record<string, unknown>; res: import("node:http").ServerResponse };
async function startMock(onTurn: (turn: Turn) => void) {
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    onTurn({ body: JSON.parse(raw), res });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("mock did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
function sse(res: import("node:http").ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}
function toolCall(id: string, name: string, arguments_: string) {
  return [
    { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: arguments_ } }] }, finish_reason: null }] },
    { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}
function finalText(text: string) {
  return [
    { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}
async function withSdk<T>(run: () => Promise<T>): Promise<T> {
  if (!node) throw new Error("pinned Node runtime missing");
  const oldNode = process.env.HARNESS_NODE_PATH, oldBridge = process.env.HARNESS_DSH_BRIDGE;
  process.env.HARNESS_NODE_PATH = node; process.env.HARNESS_DSH_BRIDGE = sourceBridge;
  try { return await run(); } finally {
    if (oldNode === undefined) delete process.env.HARNESS_NODE_PATH; else process.env.HARNESS_NODE_PATH = oldNode;
    if (oldBridge === undefined) delete process.env.HARNESS_DSH_BRIDGE; else process.env.HARNESS_DSH_BRIDGE = oldBridge;
  }
}
async function collect(request: Parameters<typeof generateHarness>[0], baseUrl: string) {
  const events: HarnessEvent[] = [];
  for await (const event of generateHarness(request, { profile: "integration", route: { provider: "mock", model: "mock", baseUrl, api: "openai-completions", billing: "local", capabilities: { context: 16000, tools: true, billing: "local" } } })) events.push(event);
  return events;
}

const integration = canRun ? describe : describe.skip;
integration("official SDK runtime bridge", () => {
  test("executes a shell tool then sends the actual result back to the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-runtime-integration-"));
    writeFileSync(join(root, "sample.txt"), "fixture-content");
    let turns = 0, sawTools = false, sawResult = false;
    const mock = await startMock(({ body, res }) => {
      turns++; const messages = Array.isArray(body.messages) ? body.messages : [];
      sawTools ||= Array.isArray(body.tools) && body.tools.some((entry: any) => entry.function?.name === "bash");
      const result = messages.find((entry: any) => entry.role === "tool");
      if (!result) return sse(res, toolCall("read-1", "bash", JSON.stringify({ command: "cat sample.txt", description: "Read fixture" })));
      sawResult = JSON.stringify(result).includes("fixture-content");
      sse(res, finalText("native tool loop complete"));
    });
    try {
      const events = await withSdk(() => collect({ model: "mock/mock", cwd: root, access: "workspace", messages: [{ role: "user", content: "Read sample.txt with bash." }], timeoutMs: 20_000 }, mock.baseUrl));
      expect(turns).toBeGreaterThanOrEqual(2); expect(sawTools).toBe(true); expect(sawResult ? "fixture-content" : "missing").toBe("fixture-content");
      expect(events.some(event => event.type === "tool-call" && event.name === "bash")).toBe(true);
      expect(events.some(event => event.type === "tool-result" && event.content.includes("fixture-content"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", text: "native tool loop complete" });
    } finally { await mock.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test("read-only mode reports a denied write instead of modifying the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-runtime-readonly-"));
    let sawDenied = false;
    const mock = await startMock(({ body, res }) => {
      const tool = Array.isArray(body.messages) && body.messages.find((entry: any) => entry.role === "tool") as any;
      if (!tool) return sse(res, toolCall("write-1", "bash", JSON.stringify({ command: "printf changed > blocked.txt", description: "Attempt write" })));
      sawDenied = /denied|read.?only|permission|not permitted/i.test(JSON.stringify(tool));
      sse(res, finalText("write was refused"));
    });
    try {
      const events = await withSdk(() => collect({ model: "mock/mock", cwd: root, access: "read-only", messages: [{ role: "user", content: "Write blocked.txt using bash." }], timeoutMs: 20_000 }, mock.baseUrl));
      expect(existsSync(join(root, "blocked.txt"))).toBe(false); expect(sawDenied ? "denied" : "missing").toBe("denied");
      expect(events.some(event => event.type === "tool-result" && event.isError)).toBe(true);
    } finally { await mock.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  test("cancellation terminates a pending native turn without done", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentic-runtime-abort-"));
    const mock = await startMock(({ res }) => { setTimeout(() => sse(res, finalText("too late")), 5_000); });
    const controller = new AbortController();
    try {
      const pending = withSdk(() => collect({ model: "mock/mock", cwd: root, access: "workspace", messages: [{ role: "user", content: "Wait." }], timeoutMs: 20_000, signal: controller.signal }, mock.baseUrl));
      setTimeout(() => controller.abort(), 150);
      const events = await pending;
      expect(events.some(event => event.type === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } });
    } finally { await mock.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
