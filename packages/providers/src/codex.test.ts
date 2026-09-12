import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "./codex.ts";

const originalPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fakeCodex(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "deepharness-codex-")); dirs.push(dir);
  const command = join(dir, "codex");
  writeFileSync(command, `#!/bin/sh\n${script}\n`);
  chmodSync(command, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
}

describe("Codex CLI JSON adapter", () => {
  test("parses a valid terminal JSON event without a final newline", async () => {
    fakeCodex("printf '%s\\n%s' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":2,\"cached_input_tokens\":9,\"output_tokens\":3}}'");
    const events = await Array.fromAsync(new CodexProvider("unit-codex-stream").generate({ model: "codex/default", messages: [] }));
    expect(events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("")).toBe("hello");
    expect(events.at(-1)).toMatchObject({ type: "done", text: "hello" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { inputTokens: 2, totalTokens: 5 } });
  });

  test("does not spawn after a pre-aborted request", async () => {
    fakeCodex("echo should-not-run >&2; exit 99");
    const controller = new AbortController(); controller.abort();
    const events = await Array.fromAsync(new CodexProvider("unit-codex-abort").generate({ model: "codex/default", messages: [], signal: controller.signal }));
    expect(events).toMatchObject([{ type: "error", error: { code: "aborted" } }]);
  });

  test("surfaces failed turns instead of reporting success", async () => {
    fakeCodex("printf '%s' '{\"type\":\"turn.failed\",\"error\":\"upstream broken\"}'");
    const events = await Array.fromAsync(new CodexProvider("unit-codex-failed").generate({ model: "codex/default", messages: [] }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});
