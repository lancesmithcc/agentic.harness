import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..");
let home = "";
let workspace = "";
let port = 0;
let child: ReturnType<typeof Bun.spawn>;
let modelServer: ReturnType<typeof Bun.serve>;

async function ready(base: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(50);
  }
  throw new Error("web server did not start");
}

function events(text: string): any[] {
  return text.split("\n\n").flatMap(part => {
    const line = part.split("\n").find(row => row.startsWith("data: "));
    if (!line) return [];
    return [JSON.parse(line.slice(6))];
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "agentic-tools-home-"));
  workspace = mkdtempSync(join(tmpdir(), "agentic-tools-workspace-"));
  const bridge = join(home, "fixture-bridge.mjs");
  writeFileSync(bridge, `
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    writeFileSync(join(request.cwd, 'output.txt'), 'tool fixture output\\n');
    process.stdout.write(JSON.stringify({ type: 'tool-call', id: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: join(request.cwd, 'output.txt'), access: request.access, tools: true }) }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'tool-result', id: 'write-1', name: 'write_file', content: JSON.stringify({ cwd: request.cwd, access: request.access, provider: request.route.provider, model: request.route.model }), isError: false }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'text-delta', text: 'wrote output.txt' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'done', text: 'wrote output.txt', finishReason: 'stop' }) + '\\n');
  `);
  modelServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/models") return Response.json({ data: [{ id: "tool-model" }] });
    return new Response("not found", { status: 404 });
  } });
  mkdirSync(join(home, "profiles", "home"), { recursive: true });
  writeFileSync(join(home, "profiles", "home", "profile.toml"), `[providers.fixture]\nenabled = true\nbase_url = "http://127.0.0.1:${modelServer.port}/v1"\napi_key = "env://FIXTURE_KEY"\n[providers.fixture.models]\ninclude = ["tool-model"]\ndiscovery = "manual"\n`);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ workspaces: { home: workspace }, agentAccess: "workspace", selfEvolve: true }));
  port = 20_000 + Math.floor(Math.random() * 8_000);
  child = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: webRoot, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, HARNESS_HOME: home, HARNESS_PROFILE: "home", HARNESS_WEB_HOST: "127.0.0.1", HARNESS_WEB_PORT: String(port), HARNESS_DSH_BRIDGE: bridge, FIXTURE_KEY: "fixture-key" },
  });
  await ready(`http://127.0.0.1:${port}`);
});

afterAll(() => {
  child?.kill(); modelServer?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("web API shared tool runtime", () => {
  test("routes a pinned custom API model through tools and preserves its session", async () => {
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/ask?profile=home`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "write output.txt", model: "fixture/tool-model" }),
    });
    expect(response.status).toBe(200);
    const stream = events(await response.text());
    const accepted = stream.find(event => event.t === "accepted");
    if (!stream.some(event => event.t === "tool")) {
      const debug = await (await fetch(`${base}/api/session?profile=home&id=${accepted?.session}`)).json();
      console.error("tool integration stream", JSON.stringify(stream), JSON.stringify(debug));
    }
    expect(accepted?.session).toBeString();
    expect(stream).toContainEqual(expect.objectContaining({ t: "route", decision: expect.objectContaining({ selected: "fixture/tool-model" }) }));
    expect(stream).toContainEqual(expect.objectContaining({ t: "tool", id: "write-1", name: "write_file" }));
    expect(stream).toContainEqual(expect.objectContaining({ t: "tool-result", id: "write-1", name: "write_file", isError: false }));
    expect(stream).toContainEqual(expect.objectContaining({ t: "artifact", path: join(workspace, "output.txt") }));
    expect(stream).toContainEqual(expect.objectContaining({ t: "done", text: "wrote output.txt", model: "fixture/tool-model" }));
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("tool fixture output\n");

    const session = await (await fetch(`${base}/api/session?profile=home&id=${accepted.session}`)).json() as { events: any[] };
    const call = session.events.find(event => event.kind === "tool-call");
    const result = session.events.find(event => event.kind === "tool-result");
    expect(call).toMatchObject({ id: "write-1", provider: "fixture", model: "fixture/tool-model" });
    expect(result).toMatchObject({ id: "write-1", name: "write_file", provider: "fixture", model: "fixture/tool-model" });
    expect(JSON.parse(result.content)).toMatchObject({ cwd: workspace, access: "workspace", provider: "fixture", model: "tool-model" });

    const followup = await fetch(`${base}/api/ask?profile=home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "continue", model: "fixture/tool-model", sessionId: accepted.session }) });
    const next = events(await followup.text());
    expect(next).toContainEqual(expect.objectContaining({ t: "tool", id: "write-1" }));
    expect(existsSync(join(workspace, "output.txt"))).toBe(true);
  });
});
