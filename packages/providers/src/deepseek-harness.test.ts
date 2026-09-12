import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSeekHarnessProvider } from "./deepseek-harness.ts";
import type { HarnessEvent } from "@harness/core";

async function fakeBridge(source: string, run: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-dsh-test-"));
  const previous = process.env.HARNESS_DSH_BRIDGE;
  const path = join(dir, "bridge.mjs"); writeFileSync(path, source);
  process.env.HARNESS_DSH_BRIDGE = path;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.HARNESS_DSH_BRIDGE; else process.env.HARNESS_DSH_BRIDGE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
const request = { model: "deepseek-harness/deepseek-v4-flash", messages: [{ role: "user" as const, content: "fixture" }], timeoutMs: 3000 };
async function collect(overrides = {}) { const events: HarnessEvent[] = []; for await (const e of new DeepSeekHarnessProvider("test", "fixture").generate({ ...request, ...overrides })) events.push(e); return events; }
describe("DeepSeek Harness boundary", () => {
  test("forwards real tool events and waits for clean exit before done", async () => {
    await fakeBridge(`process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'tool-call',id:'t',name:'read',arguments:'{}'})); console.log(JSON.stringify({type:'text-delta',text:'héllo'})); process.stdout.write(JSON.stringify({type:'done',text:'héllo',finishReason:'stop'})); });`, async () => {
      const events = await collect();
      expect(events.map(e => e.type)).toEqual(["tool-call", "text-delta", "model-call", "done"]);
    });
  });
  test("a failure exit cannot masquerade as a completed turn", async () => {
    await fakeBridge(`process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'done',text:'wrong'})); process.exitCode=1; });`, async () => {
      const events = await collect(); expect(events.some(e => e.type === "done")).toBe(false); expect(events.at(-1)?.type).toBe("error");
    });
  });
  test("pre-aborted calls do not start the SDK", async () => {
    const controller = new AbortController(); controller.abort();
    const events = await collect({ signal: controller.signal });
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") expect(events[0].error.code).toBe("aborted");
  });
  test("forwards local MCP config to the SDK bridge and rejects extra workspace scope", async () => {
    await fakeBridge(`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({type:'text-delta',text:r.mcpConfig}));console.log(JSON.stringify({type:'done',text:'ok'}));});`, async () => {
      const mcp = await collect({ mcpConfig: "/local/mcp.json" });
      expect(mcp.some(e => e.type === "text-delta" && e.text === "/local/mcp.json")).toBe(true);

      const dirs = await collect({ addDirs: ["/another-workspace"] });
      expect(dirs).toHaveLength(1);
      expect(dirs[0]?.type).toBe("error");
      if (dirs[0]?.type === "error") expect(dirs[0].error.message).toContain("additional workspace");
    });
  });
  test("accepts directories already covered by the chosen access scope", async () => {
    await fakeBridge(`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'done',text:'ok'})));`, async () => {
      const same = await collect({ cwd: "/workspace", access: "workspace", addDirs: ["/workspace", "/workspace/src"] });
      expect(same.at(-1)?.type).toBe("done");
      const full = await collect({ cwd: "/workspace", access: "full", addDirs: ["/other"] });
      expect(full.at(-1)?.type).toBe("done");
    });
  });
});
