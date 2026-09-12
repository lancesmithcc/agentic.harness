import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverSplitSessions } from "./recover-split-sessions.ts";

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
const event = (ts: string, kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ts, kind, ...extra });

function fixture(targets = 1) {
  const root = mkdtempSync(join(tmpdir(), "dh-recover-")); homes.push(root);
  const dir = join(root, "home", "sessions");
  mkdirSync(dir, { recursive: true });
  const task = "repair this history";
  for (let i = 1; i <= targets; i++) writeFileSync(join(dir, `target-${i}.jsonl`), `${event("2026-01-01T00:00:00.000Z", "user-message", { text: task })}\n`);
  writeFileSync(join(dir, "orphan-1.jsonl"), `${event("2026-01-01T00:00:01.000Z", "routing", { decision: { task } })}\n${event("2026-01-01T00:00:02.000Z", "assistant-text", { text: "recovered", provider: "local", model: "test" })}\n`);
  return { root, dir, task };
}

describe("recoverSplitSessions", () => {
  test("dry-run identifies one exact, nearby unfinished turn without changing files", async () => {
    const { root, dir } = fixture();
    const before = Bun.file(join(dir, "target-1.jsonl")).text();
    const report = recoverSplitSessions({ profilesDir: root });
    expect(report.matches).toHaveLength(1);
    expect(report.applied).toBe(0);
    expect(await Bun.file(join(dir, "target-1.jsonl")).text()).toBe(await before);
  });

  test("apply backs up logs, preserves orphan, and is idempotent", () => {
    const { root, dir } = fixture();
    const report = recoverSplitSessions({ profilesDir: root, apply: true, now: new Date("2026-02-03T04:05:06.000Z") });
    expect(report.applied).toBe(1);
    expect(existsSync(join(dir, "target-1.jsonl.bak.2026-02-03T04-05-06-000Z"))).toBe(true);
    expect(existsSync(join(dir, "orphan-1.jsonl.bak.2026-02-03T04-05-06-000Z"))).toBe(true);
    expect(existsSync(join(dir, "orphan-1.jsonl"))).toBe(true);
    expect(recoverSplitSessions({ profilesDir: root, apply: true }).matches).toHaveLength(0);
  });

  test("refuses ambiguous matching user turns", () => {
    const { root } = fixture(2);
    const report = recoverSplitSessions({ profilesDir: root });
    expect(report.matches).toHaveLength(0);
    expect(report.refused[0]?.reason).toBe("ambiguous unfinished user turn");
  });
});
