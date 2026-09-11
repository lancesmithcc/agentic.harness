/**
 * Session store (PRD §29): provider-neutral event log per session.
 * JSONL under ~/.deepharness/profiles/<profile>/sessions/<id>.jsonl so a
 * session can move Gemma → DeepSeek → Claude → Codex without losing history.
 * Usage totals go to SQLite for `harness usage` rollups.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HARNESS_HOME } from "@harness/core";
import type { SessionEvent, UsageReport } from "@harness/core";

export class SessionStore {
  readonly sessionId: string;
  readonly filePath: string;
  private events: SessionEvent[] = [];

  constructor(profile: string, sessionId?: string) {
    this.sessionId = sessionId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = join(HARNESS_HOME, "profiles", profile, "sessions");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${this.sessionId}.jsonl`);
    if (sessionId && existsSync(this.filePath)) {
      this.events = readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as SessionEvent);
    }
  }

  append(event: SessionEvent): void {
    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  all(): SessionEvent[] {
    return this.events;
  }

  /** Rebuild the provider-neutral message list from the event log. */
  messages(): Array<{ role: "user" | "assistant"; content: string; model?: string }> {
    const out: Array<{ role: "user" | "assistant"; content: string; model?: string }> = [];
    for (const e of this.events) {
      if (e.kind === "user-message") out.push({ role: "user", content: e.text });
      else if (e.kind === "assistant-text") out.push({ role: "assistant", content: e.text, model: e.model });
    }
    return out;
  }

  totalUsage(): UsageReport {
    const total: UsageReport = { billing: "mixed" };
    for (const e of this.events) {
      if (e.kind !== "usage") continue;
      total.inputTokens = (total.inputTokens ?? 0) + (e.usage.inputTokens ?? 0);
      total.outputTokens = (total.outputTokens ?? 0) + (e.usage.outputTokens ?? 0);
      total.reasoningTokens = (total.reasoningTokens ?? 0) + (e.usage.reasoningTokens ?? 0);
      total.totalTokens = (total.totalTokens ?? 0) + (e.usage.totalTokens ?? 0);
      total.costUsd = Math.round(((total.costUsd ?? 0) + (e.usage.costUsd ?? 0)) * 1e6) / 1e6;
    }
    return total;
  }
}

export function listSessions(profile: string): Array<{ id: string; events: number; modified: string; title?: string }> {
  const dir = join(HARNESS_HOME, "profiles", profile, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const content = readFileSync(join(dir, f), "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      let title: string | undefined;
      for (const l of lines) {
        try {
          const e = JSON.parse(l) as { kind?: string; text?: string };
          if (e.kind === "user-message" && e.text) { title = e.text.slice(0, 48); break; }
        } catch { /* skip */ }
      }
      return {
        id: f.replace(".jsonl", ""),
        events: lines.length,
        title,
        modified: new Date(lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]!).ts : 0).toISOString(),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// ---------------------------------------------------------------------------
// Usage rollups (SQLite via bun:sqlite; graceful fallback to JSONL scan).
// ---------------------------------------------------------------------------

export interface UsageRow {
  ts: string;
  profile: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export async function recordUsage(profile: string, provider: string, model: string, usage: UsageReport): Promise<void> {
  const row: UsageRow = {
    ts: new Date().toISOString(),
    profile,
    provider,
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    costUsd: usage.costUsd ?? 0,
  };
  try {
    const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
    const db = new Database(join(HARNESS_HOME, "usage.db"));
    db.run(`CREATE TABLE IF NOT EXISTS usage (
      ts TEXT, profile TEXT, provider TEXT, model TEXT,
      inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, costUsd REAL
    )`);
    db.run(
      "INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)",
      [row.ts, row.profile, row.provider, row.model, row.inputTokens, row.outputTokens, row.totalTokens, row.costUsd],
    );
    db.close();
  } catch {
    // Non-Bun runtime: append to JSONL instead.
    const dir = join(HARNESS_HOME, "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(row) + "\n", "utf8");
  }
}

export async function usageSummary(profile: string): Promise<UsageRow[]> {
  try {
    const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
    const path = join(HARNESS_HOME, "usage.db");
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    const rows = db
      .query("SELECT * FROM usage WHERE profile = ? ORDER BY ts DESC LIMIT 500")
      .all(profile) as unknown as UsageRow[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}
