/**
 * Session store (PRD §29): provider-neutral event log per session.
 * JSONL under ~/.deepharness/profiles/<profile>/sessions/<id>.jsonl so a
 * session can move Gemma → DeepSeek → Claude → Codex without losing history.
 * Usage totals go to SQLite for `harness usage` rollups.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHarnessHome } from "@harness/core";
import type { SessionEvent, UsageReport } from "@harness/core";

export class SessionStore {
  readonly sessionId: string;
  readonly filePath: string;
  private events: SessionEvent[] = [];

  constructor(profile: string, sessionId?: string) {
    assertProfile(profile);
    if (sessionId !== undefined) assertSessionId(sessionId);
    this.sessionId = sessionId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = join(getHarnessHome(), "profiles", profile, "sessions");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = sessionPath(profile, this.sessionId);
    if (sessionId && existsSync(this.filePath)) this.events = readSessionEvents(this.filePath);
  }

  append(event: SessionEvent): void {
    const fd = openSync(this.filePath, "a");
    try {
      const record = Buffer.from(JSON.stringify(event) + "\n", "utf8");
      let offset = 0;
      while (offset < record.length) offset += writeSync(fd, record, offset, record.length - offset);
      fsyncSync(fd);
      this.events.push(event);
    } finally {
      closeSync(fd);
    }
  }

  all(): SessionEvent[] {
    this.refresh();
    return this.events;
  }

  /** Rebuild the provider-neutral message list from the event log. */
  messages(): Array<{ role: "user" | "assistant"; content: string; model?: string; partial?: boolean }> {
    this.refresh();
    type Message = { role: "user" | "assistant"; content: string; model?: string; partial?: boolean };
    type Pending = { chunks: string[]; model: string };
    const out: Array<Message | Pending> = [];
    const pending = new Map<string, { entry: Pending; index: number }>();
    for (const e of this.events) {
      if (e.kind === "user-message") out.push({ role: "user", content: e.text });
      else if (e.kind === "assistant-delta") {
        let current = pending.get(e.turnId);
        if (!current) {
          const entry: Pending = { chunks: [], model: e.model };
          current = { entry, index: out.length };
          pending.set(e.turnId, current);
          // Keep the original conversational position even if a new user turn
          // was persisted after a crash but before this session was replayed.
          out.push(entry);
        }
        current.entry.chunks.push(e.text);
      } else if (e.kind === "assistant-text") {
        const current = e.turnId ? pending.get(e.turnId) : undefined;
        const final: Message = { role: "assistant", content: e.text, model: e.model };
        if (current) {
          out[current.index] = final;
          pending.delete(e.turnId!);
        } else out.push(final);
      }
    }
    return out.map((entry) => "chunks" in entry
      ? { role: "assistant" as const, content: entry.chunks.join(""), model: entry.model, partial: true }
      : entry);
  }

  totalUsage(): UsageReport {
    this.refresh();
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

  /** Another process may append between turns; history is a shared durable log. */
  private refresh(): void {
    if (existsSync(this.filePath)) this.events = readSessionEvents(this.filePath);
  }
}

export function listSessions(profile: string): Array<{ id: string; events: number; modified: string; title?: string }> {
  assertProfile(profile);
  const dir = join(getHarnessHome(), "profiles", profile, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && isSessionId(f.slice(0, -".jsonl".length)))
    .map((f) => {
      const filePath = join(dir, f);
      const events = readSessionEvents(filePath);
      let title: string | undefined;
      for (const e of events) {
        if (e.kind === "user-message" && e.text) { title = e.text.slice(0, 48); break; }
      }
      if (!title && events.some(e => e.kind === "assistant-text" || e.kind === "assistant-delta")) {
        const routing = events.find(e => e.kind === "routing");
        title = routing?.kind === "routing" && typeof routing.decision?.task === "string" ? `Recovered reply: ${routing.decision.task.slice(0, 48)}` : "Recovered reply";
      }
      const lastTs = events.at(-1)?.ts;
      const modified = validTimestamp(lastTs) ? lastTs : statSync(filePath).mtime.toISOString();
      return {
        id: f.replace(".jsonl", ""),
        events: events.length,
        title,
        modified,
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** File-safe IDs prevent a session parameter from escaping its profile folder. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/i;
export const PROFILE_NAME_RE = /^[a-z0-9_-]{1,64}$/i;

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

export function sessionPath(profile: string, sessionId: string): string {
  assertProfile(profile);
  assertSessionId(sessionId);
  return join(getHarnessHome(), "profiles", profile, "sessions", `${sessionId}.jsonl`);
}

function assertProfile(profile: string): void {
  if (!PROFILE_NAME_RE.test(profile)) throw new Error("invalid profile name");
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) throw new Error("invalid session id");
}

/**
 * JSONL writes can be interrupted mid-line. Keep the durable prefix rather
 * than making an entire conversation unreadable because of its final line.
 */
function readSessionEvents(filePath: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isSessionEvent(event)) events.push(event);
    } catch { /* Ignore corrupt or truncated records; later valid lines still load. */ }
  }
  return events;
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { v?: unknown; ts?: unknown; kind?: unknown; turnId?: unknown; text?: unknown; sessionId?: unknown; profile?: unknown; cwd?: unknown; provider?: unknown; model?: unknown; outcome?: unknown; error?: unknown; path?: unknown; from?: unknown; to?: unknown; cause?: unknown; reason?: unknown; id?: unknown; name?: unknown; arguments?: unknown; decision?: unknown; usage?: unknown; before?: unknown; after?: unknown; root?: unknown; files?: unknown; reverted?: unknown; skipped?: unknown };
  if (event.v !== 1 || !validTimestamp(event.ts)) return false;
  switch (event.kind) {
    case "session-start": return typeof event.sessionId === "string" && typeof event.profile === "string" && typeof event.cwd === "string";
    case "user-message": return typeof event.text === "string";
    case "routing": return !!event.decision && typeof event.decision === "object";
    case "model-call": return typeof event.provider === "string" && typeof event.model === "string";
    case "assistant-delta": return typeof event.turnId === "string" && typeof event.text === "string" && typeof event.provider === "string" && typeof event.model === "string";
    case "assistant-text": return typeof event.text === "string" && typeof event.provider === "string" && typeof event.model === "string" && (event.turnId === undefined || typeof event.turnId === "string");
    case "turn-outcome": return typeof event.provider === "string" && typeof event.model === "string" && (event.outcome === "interrupted" || event.outcome === "failed") && (event.error === undefined || typeof event.error === "string");
    case "tool-call": return typeof event.id === "string" && typeof event.name === "string" && typeof event.arguments === "string";
    case "usage": return !!event.usage && typeof event.usage === "object" && typeof event.provider === "string" && typeof event.model === "string";
    case "fallback": return typeof event.from === "string" && typeof event.to === "string" && typeof event.cause === "string";
    case "artifact": return typeof event.path === "string";
    case "session-end": return typeof event.reason === "string";
    case "self-change": return typeof event.root === "string" && typeof event.before === "string" && typeof event.after === "string" && Array.isArray(event.files);
    case "self-revert": return typeof event.before === "string" && typeof event.after === "string" && Array.isArray(event.reverted) && Array.isArray(event.skipped);
    default: return false;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
    const home = getHarnessHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
    const db = new Database(join(home, "usage.db"));
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
    const dir = join(getHarnessHome(), "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "usage.jsonl"), JSON.stringify(row) + "\n", "utf8");
  }
}

export async function usageSummary(profile: string): Promise<UsageRow[]> {
  const fallback = readFallbackUsage(profile);
  try {
    const { Database } = (await import("bun:sqlite")) as typeof import("bun:sqlite");
    const path = join(getHarnessHome(), "usage.db");
    if (!existsSync(path)) return fallback;
    const db = new Database(path, { readonly: true });
    const rows = db
      .query("SELECT * FROM usage WHERE profile = ? ORDER BY ts DESC LIMIT 500")
      .all(profile) as unknown as UsageRow[];
    db.close();
    return [...rows, ...fallback].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 500);
  } catch {
    return fallback;
  }
}

function readFallbackUsage(profile: string): UsageRow[] {
  const path = join(getHarnessHome(), "logs", "usage.jsonl");
  if (!existsSync(path)) return [];
  const rows: UsageRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<UsageRow>;
      if (row.profile === profile && typeof row.ts === "string" && typeof row.provider === "string" && typeof row.model === "string") {
        rows.push({ ts: row.ts, profile, provider: row.provider, model: row.model, inputTokens: Number(row.inputTokens) || 0, outputTokens: Number(row.outputTokens) || 0, totalTokens: Number(row.totalTokens) || 0, costUsd: Number(row.costUsd) || 0 });
      }
    } catch { /* A damaged fallback row must not hide the valid rows around it. */ }
  }
  return rows;
}
