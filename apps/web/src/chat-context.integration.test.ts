import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const webRoot = join(import.meta.dir, "..");
let home = "", one = "", two = "", source = "", port = 0;
let child: ReturnType<typeof Bun.spawn>;
let modelServer: ReturnType<typeof Bun.serve>;

const base = () => `http://127.0.0.1:${port}`;
async function ready() { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base()}/api/health`)).ok) return; } catch {} await Bun.sleep(50); } throw new Error("web server did not start"); }
function sse(text: string): any[] { return text.split("\n\n").flatMap(part => { const line = part.split("\n").find(row => row.startsWith("data: ")); return line ? [JSON.parse(line.slice(6))] : []; }); }
async function put(body: unknown) { return fetch(`${base()}/api/session/context?profile=home`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function ask(body: unknown) { const response = await fetch(`${base()}/api/ask?profile=home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { response, events: sse(await response.text()) }; }
function serverEnv(bridge: string) { return { HOME: join(home, "runtime-home"), TMPDIR: home, PATH: dirname(process.execPath), LANG: "en_US.UTF-8", HARNESS_HOME: home, HARNESS_PROFILE: "home", HARNESS_WEB_HOST: "127.0.0.1", HARNESS_WEB_PORT: String(port), HARNESS_DSH_BRIDGE: bridge, HARNESS_NODE_PATH: process.execPath, FIXTURE_KEY: "fixture-key" }; }
async function stopServer() { child?.kill(); await child?.exited; }
async function startServer(bridge: string) { child = Bun.spawn([process.execPath, "src/server.ts"], { cwd: webRoot, stdout: "ignore", stderr: "ignore", env: serverEnv(bridge) }); await ready(); }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "agentic-chat-context-home-")); one = mkdtempSync(join(tmpdir(), "agentic-chat-one-")); two = mkdtempSync(join(tmpdir(), "agentic-chat-two-")); source = mkdtempSync(join(tmpdir(), "agentic-chat-source-"));
  mkdirSync(join(home, "runtime-home"), { recursive: true });
  // A valid disposable root prevents any startup recovery/checkpoint from
  // discovering the real checkout when self-evolve is tested per chat.
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "agentic.harness" }));
  Bun.spawnSync(["git", "init"], { cwd: source, stdout: "ignore", stderr: "ignore" });
  const bridge = join(home, "bridge.mjs");
  writeFileSync(bridge, `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; let raw=''; for await(const c of process.stdin)raw+=c; const r=JSON.parse(raw); if(r.messages.at(-1)?.content.includes('busy')) await new Promise(ok=>setTimeout(ok,500)); writeFileSync(join(r.cwd,'captured-cwd.txt'),JSON.stringify({cwd:r.cwd,access:r.access,prompt:r.messages.map(m=>m.content).join('\\n')})); console.log(JSON.stringify({type:'tool-call',id:'ctx',name:'write',arguments:'{}'})); console.log(JSON.stringify({type:'tool-result',id:'ctx',name:'write',content:JSON.stringify({cwd:r.cwd,access:r.access})})); console.log(JSON.stringify({type:'done',text:'ok'}));`);
  modelServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { return new URL(req.url).pathname === "/v1/models" ? Response.json({ data: [{ id: "ctx-model" }] }) : new Response("no", { status: 404 }); } });
  mkdirSync(join(home, "profiles", "home"), { recursive: true });
  writeFileSync(join(home, "profiles", "home", "profile.toml"), `[providers.fixture]\nenabled=true\nbase_url="http://127.0.0.1:${modelServer.port}/v1"\napi_key="env://FIXTURE_KEY"\n[providers.fixture.models]\ninclude=["ctx-model"]\n`);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ workspaces: { home: one }, selfSourceRoot: source, selfEvolve: false, agentAccess: "workspace" }));
  port = 28_000 + Math.floor(Math.random() * 1_000);
  await startServer(bridge);
});
afterAll(async () => { await stopServer(); modelServer?.stop(); for (const path of [home, one, two, source]) if (path) rmSync(path, { recursive: true, force: true }); });

describe("per-chat context HTTP contract", () => {
  test("pins workspace and self-evolve to each chat across switches and restart-readable sessions", async () => {
    const created = await put({ workspace: one, selfEvolve: true }); expect(created.status).toBe(200);
    const first = await created.json() as { session: string; workspace: string; selfEvolve: boolean }; expect(first).toMatchObject({ workspace: one, selfEvolve: true });
    const firstAsk = await ask({ sessionId: first.session, task: "write output.txt", model: "fixture/ctx-model", workspace: two, selfEvolve: false });
    expect(firstAsk.events).toContainEqual(expect.objectContaining({ t: "done", model: "fixture/ctx-model" }));
    const firstCapture = JSON.parse(readFileSync(join(one, "captured-cwd.txt"), "utf8"));
    expect(firstCapture).toMatchObject({ cwd: one, access: "workspace" });
    expect(firstCapture.prompt).toContain(one);
    expect(firstCapture.prompt).not.toContain(source);
    expect(existsSync(join(source, ".git", "agentic-harness"))).toBe(false);
    expect(Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", "refs/heads/self-evolve"], { cwd: source, stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
    expect(existsSync(join(two, "captured-cwd.txt"))).toBe(false);

    const updatedDefault = await fetch(`${base()}/api/workspace?profile=home`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: two }) });
    expect(updatedDefault.status).toBe(200);
    await ask({ sessionId: first.session, task: "continue with pinned folder", model: "fixture/ctx-model" });
    expect(JSON.parse(readFileSync(join(one, "captured-cwd.txt"), "utf8"))).toMatchObject({ cwd: one });

    const switched = await put({ sessionId: first.session, workspace: two, selfEvolve: false }); expect(switched.status).toBe(200);
    await ask({ sessionId: first.session, task: "continue", model: "fixture/ctx-model" });
    expect(JSON.parse(readFileSync(join(two, "captured-cwd.txt"), "utf8"))).toMatchObject({ cwd: two });
    const stored = await (await fetch(`${base()}/api/session?profile=home&id=${first.session}`)).json() as { workspace?: string; selfEvolve: boolean; events: any[] };
    expect(stored).toMatchObject({ workspace: two, selfEvolve: false });
    expect(stored.events.filter(event => event.kind === "user-message")).toHaveLength(3);
    const status = await (await fetch(`${base()}/api/status?profile=home&sessionId=${first.session}`)).json() as { workspace?: string; selfEvolve: boolean };
    expect(status).toMatchObject({ workspace: two, selfEvolve: false });

    await stopServer();
    const bridge = join(home, "bridge.mjs");
    await startServer(bridge);
    const restarted = await (await fetch(`${base()}/api/session?profile=home&id=${first.session}`)).json() as { workspace?: string; selfEvolve: boolean };
    expect(restarted).toMatchObject({ workspace: two, selfEvolve: false });
    await ask({ sessionId: first.session, task: "continue after restart", model: "fixture/ctx-model" });
    expect(JSON.parse(readFileSync(join(two, "captured-cwd.txt"), "utf8"))).toMatchObject({ cwd: two });
  });

  test("keeps ordinary source-root work read-only and blocks self edits when this chat disables them", async () => {
    const created = await put({ workspace: source, selfEvolve: true });
    const chat = await created.json() as { session: string };
    const ordinary = await ask({ sessionId: chat.session, task: "write output.txt", model: "fixture/ctx-model" });
    expect(ordinary.events).toContainEqual(expect.objectContaining({ t: "done" }));
    expect(JSON.parse(readFileSync(join(source, "captured-cwd.txt"), "utf8"))).toMatchObject({ cwd: source, access: "read-only" });

    expect((await put({ sessionId: chat.session, selfEvolve: false })).status).toBe(200);
    const blocked = await ask({ sessionId: chat.session, task: "edit agentic.harness server", model: "fixture/ctx-model" });
    expect(blocked.events).toContainEqual(expect.objectContaining({ t: "error", message: expect.stringContaining("Turn on") }));
    expect(blocked.events).not.toContainEqual(expect.objectContaining({ t: "tool" }));
  });

  test("reports default versus saved context, rejects missing folders, and refuses updates during a turn", async () => {
    const status = await (await fetch(`${base()}/api/status?profile=home`)).json() as { defaultWorkspace: string; context?: unknown };
    expect(status.defaultWorkspace).toBe(two);
    const missing = await put({ workspace: join(home, "missing-folder") }); expect(missing.status).toBe(400);
    const chat = await put({ workspace: one, selfEvolve: false }).then(response => response.json()) as { session: string };
    const busy = await fetch(`${base()}/api/ask?profile=home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: chat.session, task: "write busy output.txt", model: "fixture/ctx-model" }) });
    expect(busy.status).toBe(200);
    expect((await put({ sessionId: chat.session, workspace: two })).status).toBe(409);
    await busy.text();
  });

  test("uses legacy workspace metadata and pins uploads to the selected chat", async () => {
    const id = "legacy-context";
    const sessions = join(home, "profiles", "home", "sessions"); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${id}.jsonl`), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "session-start", sessionId: id, profile: "home", cwd: one })}\n${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: two, note: "workspace" })}\n`);
    const legacy = await (await fetch(`${base()}/api/session?profile=home&id=${id}`)).json() as { workspace?: string; selfEvolve: boolean };
    expect(legacy).toMatchObject({ workspace: two, selfEvolve: false });
    const upload = await fetch(`${base()}/api/upload?profile=home&sessionId=${id}&name=context.txt`, { method: "POST", body: "context upload" });
    expect(upload.status).toBe(200);
    const uploaded = await upload.json() as { path: string };
    expect(uploaded.path.startsWith(join(two, ".harness", "uploads"))).toBe(true);
  });
});
