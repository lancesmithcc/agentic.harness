import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    expect(await response.json()).toMatchObject({ ok: true, name: "agentic.harness", activeTurns: 0 });
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
});
