import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore as SessionStoreT, listSessions as listSessionsT, usageSummary as usageSummaryT } from "./store.ts";

let home = "";
let SessionStore!: typeof SessionStoreT;
let listSessions!: typeof listSessionsT;
let usageSummary!: typeof usageSummaryT;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dh-"));
  process.env.HARNESS_HOME = home;
  ({ SessionStore, listSessions, usageSummary } = await import("./store.ts"));
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

  test("recovers valid history when JSONL ends in a truncated record", () => {
    const id = "recover-1";
    const first = new SessionStore("home", id);
    first.append({ v: 1, ts: ts(), kind: "user-message", text: "durable" });
    appendFileSync(first.filePath, '{"v":1,"ts":"broken"', "utf8");

    const reopened = new SessionStore("home", id);
    expect(reopened.messages()).toEqual([{ role: "user", content: "durable" }]);
    expect(listSessions("home").find((session) => session.id === id)?.events).toBe(1);
  });

  test("rejects unsafe profile and session identifiers", () => {
    expect(() => new SessionStore("../home", "safe-1")).toThrow("invalid profile name");
    expect(() => new SessionStore("home", "../escape")).toThrow("invalid session id");
    expect(() => new SessionStore("home", "")).toThrow("invalid session id");
  });

  test("refreshes history when another store appends to the same session", () => {
    const first = new SessionStore("home", "shared-1");
    const second = new SessionStore("home", "shared-1");
    second.append({ v: 1, ts: ts(), kind: "user-message", text: "from second writer" });
    expect(first.messages()).toEqual([{ role: "user", content: "from second writer" }]);
  });

  test("includes readable JSONL usage fallback rows", async () => {
    const logs = join(home, "logs");
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, "usage.jsonl"), `${JSON.stringify({ ts: ts(), profile: "home", provider: "local", model: "test", inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0 })}\n`, "utf8");
    expect((await usageSummary("home")).some((row) => row.model === "test" && row.totalTokens === 5)).toBe(true);
  });

  test("replays one partial assistant message after a streamed turn crashes", () => {
    const store = new SessionStore("home", "journal-partial");
    store.append({ v: 1, ts: ts(), kind: "user-message", text: "hello" });
    store.append({ v: 1, ts: ts(), kind: "assistant-delta", turnId: "turn-1", text: "hel", provider: "local", model: "test" });
    store.append({ v: 1, ts: ts(), kind: "assistant-delta", turnId: "turn-1", text: "lo", provider: "local", model: "test" });
    expect(new SessionStore("home", "journal-partial").messages()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello", model: "test", partial: true },
    ]);
  });

  test("keeps a crashed partial reply before a later user follow-up", () => {
    const store = new SessionStore("home", "journal-order");
    store.append({ v: 1, ts: ts(), kind: "user-message", text: "first" });
    store.append({ v: 1, ts: ts(), kind: "assistant-delta", turnId: "turn-3", text: "partial", provider: "local", model: "test" });
    store.append({ v: 1, ts: ts(), kind: "user-message", text: "follow-up" });
    expect(store.messages()).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "partial", model: "test", partial: true },
      { role: "user", content: "follow-up" },
    ]);
  });

  test("final assistant text commits its journal without replay duplication", () => {
    const store = new SessionStore("home", "journal-final");
    store.append({ v: 1, ts: ts(), kind: "assistant-delta", turnId: "turn-2", text: "streamed", provider: "local", model: "test" });
    store.append({ v: 1, ts: ts(), kind: "assistant-text", turnId: "turn-2", text: "streamed final", provider: "local", model: "test" });
    expect(store.messages()).toEqual([{ role: "assistant", content: "streamed final", model: "test" }]);
  });

  test("preserves durable tool results when a session is reopened", () => {
    const store = new SessionStore("home", "tool-result-replay");
    store.append({ v: 1, ts: ts(), kind: "tool-result", id: "call-1", name: "read_file", content: "fixture output", turnId: "turn-1", provider: "agent", model: "agent/test" });
    const restored = new SessionStore("home", "tool-result-replay").all();
    expect(restored).toContainEqual(expect.objectContaining({ kind: "tool-result", id: "call-1", content: "fixture output" }));
  });
});
