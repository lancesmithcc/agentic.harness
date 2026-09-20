import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string, base: string, processHandle: ReturnType<typeof Bun.spawn>, mock: ReturnType<typeof Bun.serve>;
let cliEnv: Record<string, string>, workspace: string;
const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const controllers = new Set<ReturnType<typeof setInterval>>();
async function launchServer() {
  processHandle = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    cwd: workspace, stdout: "ignore", stderr: "pipe", env: cliEnv,
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("isolated harness failed to start");
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agentic-integration-"));
  mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    if (req.method !== "POST") return Response.json({ ok: true });
    const body = await req.json(); calls.push(body);
    const last = body.messages.at(-1)?.content ?? "";
    const slow = last.includes("slow-turn");
    let count = 0;
    let interval: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({ start(controller) {
      const encoder = new TextEncoder();
      const emit = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      interval = setInterval(() => {
        emit({ choices: [{ delta: { content: count++ === 0 ? "Saved partial " : "reply " }, finish_reason: null }] });
        if (!slow && count >= 2) {
          emit({ choices: [{ delta: {}, finish_reason: "stop" }] });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          clearInterval(interval); controllers.delete(interval); controller.close();
        }
      }, slow ? 60 : 10);
      controllers.add(interval);
    }, cancel() { clearInterval(interval); controllers.delete(interval); } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }});
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const cli of ["codex", "claude"]) writeFileSync(join(bin, cli), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  workspace = join(root, "workspace"); mkdirSync(workspace);
  const home = join(root, "data"); mkdirSync(home);
  for (const profile of ["home", "work"]) {
    const dir = join(home, "profiles", profile); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.toml"), ["[profile]", `name = "${profile}"`, ...["deepseek", "deepseek-harness", "openai", "zai", "kimi", "minimax", "openrouter"].flatMap(p => [`[providers.${p}]`, "enabled = false"]), "[[local.endpoints]]", 'name = "fixture"', `url = "http://127.0.0.1:${mock.port}/v1"`, 'kind = "openai-compat"'].join("\n"));
  }
  writeFileSync(join(home, "settings.json"), JSON.stringify({ workspaces: { home: workspace, work: workspace }, agentAccess: "read-only" }));
  const port = 28_000 + Math.floor(Math.random() * 6000);
  base = `http://127.0.0.1:${port}`;
  cliEnv = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, HARNESS_HOME: home, HARNESS_PROFILE: "home", HARNESS_WEB_PORT: String(port), HARNESS_WEB_HOST: "127.0.0.1" };
  await launchServer();
});
afterAll(async () => {
  processHandle?.kill(); if (processHandle) await processHandle.exited;
  for (const interval of controllers) clearInterval(interval);
  mock?.stop(true); if (root) rmSync(root, { recursive: true, force: true });
});

function ask(task: string, sessionId?: string) {
  return fetch(`${base}/api/ask?profile=work`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, model: "local/fixture", noFallback: true, sessionId }) });
}
async function events(response: Response) {
  const raw = await response.text(); return raw.split("\n\n").filter(s => s.startsWith("data:")).map(s => JSON.parse(s.slice(5)));
}
describe("chat persistence through HTTP, routing and a real SSE adapter", () => {
  test("reply and prompt share one durable session; continuation receives both", async () => {
    const first = await events(await ask("hello fixture"));
    const id = first.find(e => e.t === "accepted").session;
    expect(first.find(e => e.t === "route").decision.selected).toBe("local/fixture");
    expect(first.at(-1)?.t).toBe("done");
    const transcript = await fetch(`${base}/api/session?profile=work&id=${id}`).then(r => r.json());
    expect(transcript.events.filter((e: { kind: string }) => e.kind === "user-message").length).toBe(1);
    expect(transcript.events.filter((e: { kind: string }) => e.kind === "assistant-text").length).toBe(1);
    const wrongProfile = await fetch(`${base}/api/session?profile=home&id=${id}`); expect(wrongProfile.status).toBe(404);
    const second = await events(await ask("continue fixture", id)); expect(second.at(-1)?.t).toBe("done");
    const last = calls.at(-1)!;
    expect(last.messages.some(m => m.role === "user" && m.content === "hello fixture")).toBe(true);
    expect(last.messages.some(m => m.role === "assistant" && m.content.includes("Saved partial"))).toBe(true);
    expect(last.messages.find(m => m.role === "system")?.content).toContain("Your name is agentic.sidekick");
    const list = await fetch(`${base}/api/sessions?profile=work`).then(r => r.json()); expect(list.sessions.length).toBe(1);
  }, 20_000);
  test("Stop aborts model work, keeps partial reply, and prevents concurrent turns", async () => {
    const response = await ask("slow-turn fixture");
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let received = "", id = "";
    while (!received.includes('"t":"delta"')) {
      const next = await reader.read(); if (next.done) throw new Error("stream ended before a partial reply");
      received += decoder.decode(next.value, { stream: true });
      const accepted = received.split("\n\n").find(s => s.includes('"t":"accepted"'));
      if (accepted) id = JSON.parse(accepted.slice(5)).session;
    }
    expect((await ask("duplicate", id)).status).toBe(409);
    expect((await fetch(`${base}/api/session?profile=work&id=${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await fetch(`${base}/api/turn/cancel?profile=home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }) })).status).toBe(404);
    const stopped = await fetch(`${base}/api/turn/cancel?profile=work`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }) });
    expect(stopped.ok).toBe(true);
    while (!(await reader.read()).done) {}
    const stored = await fetch(`${base}/api/session?profile=work&id=${id}`).then(r => r.json());
    expect(stored.events.some((e: { kind: string; text?: string }) => e.kind === "assistant-text" && e.text?.includes("Saved partial"))).toBe(true);
    expect(stored.events.some((e: { kind: string; outcome?: string }) => e.kind === "turn-outcome" && e.outcome === "interrupted")).toBe(true);
  }, 20_000);
  test("CLI resumes the same profile session without producing orphan responses", async () => {
    const cli = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../cli/src/index.ts"), "--profile", "work", ...args], { cwd: workspace, env: cliEnv, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit !== 0) throw new Error(stderr);
      return stdout;
    };
    const before = await fetch(`${base}/api/sessions?profile=work`).then(r => r.json());
    await cli("models");
    const inspected = await fetch(`${base}/api/sessions?profile=work`).then(r => r.json());
    expect(inspected.sessions.length).toBe(before.sessions.length);
    const first = JSON.parse(await cli("ask", "hello cli fixture", "--model", "local/fixture", "--json"));
    const next = JSON.parse(await cli("ask", "continue cli fixture", "--model", "local/fixture", "--session", first.sessionId, "--json"));
    expect(next.sessionId).toBe(first.sessionId);
    expect(calls.at(-1)?.messages.some(m => m.content === "hello cli fixture")).toBe(true);
    const stored = await fetch(`${base}/api/session?profile=work&id=${first.sessionId}`).then(r => r.json());
    expect(stored.events.filter((e: { kind: string }) => e.kind === "assistant-text").length).toBe(2);
    const after = await fetch(`${base}/api/sessions?profile=work`).then(r => r.json());
    expect(after.sessions.length).toBe(before.sessions.length + 1);
  }, 30_000);
  test("a hard process crash recovers visible text before the next user message", async () => {
    const response = await ask("slow-turn crash fixture");
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let received = "";
    while (!received.includes('"t":"delta"')) {
      const next = await reader.read(); if (next.done) throw new Error("missing first delta");
      received += decoder.decode(next.value, { stream: true });
    }
    const id = JSON.parse(received.split("\n\n").find(s => s.includes('"t":"accepted"'))!.slice(5)).session;
    processHandle.kill("SIGKILL"); await processHandle.exited;
    await reader.cancel().catch(() => {});
    await launchServer();
    const stored = await fetch(`${base}/api/session?profile=work&id=${id}`).then(r => r.json());
    expect(stored.events.some((e: { kind: string }) => e.kind === "assistant-delta")).toBe(true);
    expect(stored.events.some((e: { kind: string }) => e.kind === "assistant-text")).toBe(false);
    const next = await events(await ask("resume after crash", id));
    expect(next.at(-1)?.t).toBe("done");
    const transcript = calls.at(-1)!.messages.filter(m => m.role !== "system");
    expect(transcript.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(transcript[1]?.content).toContain("Saved partial");
    expect(transcript.at(-1)?.content).toBe("resume after crash");
  }, 20_000);
});
