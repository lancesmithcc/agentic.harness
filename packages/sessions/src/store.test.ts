import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore as SessionStoreT } from "./store.ts";

let home = "";
let SessionStore!: typeof SessionStoreT;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dh-"));
  process.env.HARNESS_HOME = home;
  ({ SessionStore } = await import("./store.ts"));
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

const ts = () => new Date().toISOString();

describe("SessionStore", () => {
  test("append 4 events yields messages and total usage", () => {
    const store = new SessionStore("home", "sess-1");
    store.append({ v: 1, ts: ts(), kind: "session-start", sessionId: "sess-1", profile: "home", cwd: "/tmp" });
    store.append({ v: 1, ts: ts(), kind: "user-message", text: "hello" });
    store.append({ v: 1, ts: ts(), kind: "assistant-text", text: "world", provider: "zai", model: "glm-5.3" });
    store.append({ v: 1, ts: ts(), kind: "usage", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, provider: "zai", model: "glm-5.3" });

    const msgs = store.messages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("hello");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content).toBe("world");
    expect(store.totalUsage().totalTokens).toBe(30);
  });

  test("reopening same sessionId sees all 4 events", () => {
    const id = "sess-2";
    const first = new SessionStore("home", id);
    first.append({ v: 1, ts: ts(), kind: "session-start", sessionId: id, profile: "home", cwd: "/tmp" });
    first.append({ v: 1, ts: ts(), kind: "user-message", text: "hi" });
    first.append({ v: 1, ts: ts(), kind: "assistant-text", text: "yo", provider: "zai", model: "glm-5.3" });
    first.append({ v: 1, ts: ts(), kind: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, provider: "zai", model: "glm-5.3" });

    const reopened = new SessionStore("home", id);
    expect(reopened.all()).toHaveLength(4);
  });
});
