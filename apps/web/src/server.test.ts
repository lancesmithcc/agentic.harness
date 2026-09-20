import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..");
let home = "";
let port = 0;
let child: ReturnType<typeof Bun.spawn>;

async function ready(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch { /* server still starting */ }
    await Bun.sleep(50);
  }
  throw new Error("web server did not start");
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dh-web-"));
  port = 18_000 + Math.floor(Math.random() * 10_000);
  child = Bun.spawn([process.execPath, "src/server.ts"], {
    cwd: webRoot,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, HARNESS_HOME: home, HARNESS_PROFILE: "home", HARNESS_WEB_HOST: "127.0.0.1", HARNESS_WEB_PORT: String(port) },
  });
  await ready(`http://127.0.0.1:${port}`);
});

afterAll(() => {
  child?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("web session API", () => {
  test("exposes a fast local readiness endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, name: "agentic.sidekick", activeTurns: 0 });
  });

  test("does not create a session when its id is missing or unsafe", async () => {
    const missing = await fetch(`http://127.0.0.1:${port}/api/session?id=missing-1`);
    expect(missing.status).toBe(404);
    const unsafe = await fetch(`http://127.0.0.1:${port}/api/session?id=../escape`);
    expect(unsafe.status).toBe(400);
    expect(existsSync(join(home, "profiles", "home", "sessions", "missing-1.jsonl"))).toBe(false);
  });

  test("rejects a cross-site API request before it can touch local state", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  test("offers a bring-your-own key slot for every API provider and never echoes a value", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/providers/keys`);
    expect(response.status).toBe(200);
    const body = await response.json() as { providers: Array<Record<string, unknown>> };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("minimax");
    // Only the shape of a credential is ever reported, never the credential.
    expect(JSON.stringify(body)).not.toContain("key\":\"");
    for (const provider of body.providers) {
      expect(provider).toHaveProperty("envVar");
      expect(provider).toHaveProperty("configured");
      expect(provider).not.toHaveProperty("value");
    }
  });

  test("refuses a key for an unknown provider, and an empty or malformed key", async () => {
    const put = (payload: unknown) => fetch(`http://127.0.0.1:${port}/api/providers/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect((await put({ provider: "not-a-provider", key: "abc" })).status).toBe(400);
    expect((await put({ provider: "deepseek", key: "   " })).status).toBe(400);
    expect((await put({ provider: "deepseek", key: "has spaces and\nnewlines" })).status).toBe(400);
    const removed = await fetch(`http://127.0.0.1:${port}/api/providers/keys?provider=not-a-provider`, { method: "DELETE" });
    expect(removed.status).toBe(400);
  });

  test("shares only folders and files that exist on this Mac", async () => {
    const shared = mkdtempSync(join(tmpdir(), "dh-shared-"));
    const file = join(shared, "universal.env");
    writeFileSync(file, "SHARED_KEY=abc123\n");

    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sharedPaths: [shared, file, shared] }),
    });
    expect(saved.status).toBe(200);
    // Duplicates collapse; the file is kept as written and resolved to its folder at request time.
    expect((await saved.json()).sharedPaths).toEqual([shared, file]);

    const rejected = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sharedPaths: [join(shared, "does-not-exist")] }),
    });
    expect(rejected.status).toBe(400);
    // A rejected save leaves the stored list untouched.
    expect((await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json()).sharedPaths).toEqual([shared, file]);

    rmSync(shared, { recursive: true, force: true });
  });
});
