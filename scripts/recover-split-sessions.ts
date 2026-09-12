#!/usr/bin/env bun
/**
 * Recover the narrow historical failure where a web request wrote its user
 * event to one session and the router/assistant events to another. This tool
 * never selects the real harness home itself: callers must provide a profiles
 * directory, and dry-run is the default.
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Event = { v?: unknown; ts?: unknown; kind?: unknown; text?: unknown; decision?: { task?: unknown }; [key: string]: unknown };
export interface RecoveryMatch { profile: string; orphanId: string; targetId: string; task: string; importedEvents: number }
export interface RecoveryReport { matches: RecoveryMatch[]; refused: Array<{ profile: string; orphanId: string; reason: string }>; applied: number }

const MARKER_PREFIX = "recovered-split-session:";

function readEvents(path: string): Event[] {
  const events: Event[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Event;
      if (event && typeof event === "object" && typeof event.kind === "string" && typeof event.ts === "string") events.push(event);
    } catch { /* Ignore damaged records; they cannot establish a safe match. */ }
  }
  return events;
}

function timestamp(event: Event): number | null {
  const value = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
  return Number.isFinite(value) ? value : null;
}

function hasMarker(events: Event[], orphanId: string): boolean {
  return events.some((event) => event.kind === "artifact" && event.note === `${MARKER_PREFIX}${orphanId}`);
}

function orphanTask(events: Event[]): { task: string; at: number } | null {
  if (events.some((event) => event.kind === "user-message")) return null;
  if (!events.some((event) => event.kind === "assistant-text")) return null;
  const routing = events.find((event) => event.kind === "routing" && typeof event.decision?.task === "string" && event.decision.task.trim());
  const at = routing ? timestamp(routing) : null;
  return routing && at !== null ? { task: routing.decision!.task as string, at } : null;
}

function unfinishedCandidates(eventsById: Map<string, Event[]>, task: string, around: number, windowMs: number): string[] {
  const candidates: string[] = [];
  for (const [id, events] of eventsById) {
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event.kind !== "user-message" || event.text !== task) continue;
      const at = timestamp(event);
      if (at === null || Math.abs(at - around) > windowMs) continue;
      if (!events.slice(i + 1).some((later) => later.kind === "assistant-text")) candidates.push(id);
    }
  }
  return candidates;
}

function outputEvents(orphan: Event[]): Event[] {
  return orphan.filter((event) => !["session-start", "session-end", "user-message"].includes(String(event.kind)));
}

export function recoverSplitSessions(opts: { profilesDir: string; apply?: boolean; windowMinutes?: number; now?: Date }): RecoveryReport {
  const report: RecoveryReport = { matches: [], refused: [], applied: 0 };
  if (!existsSync(opts.profilesDir)) throw new Error(`profiles directory not found: ${opts.profilesDir}`);
  const windowMs = Math.max(1, opts.windowMinutes ?? 10) * 60_000;
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  for (const profile of readdirSync(opts.profilesDir)) {
    const sessionsDir = join(opts.profilesDir, profile, "sessions");
    if (!existsSync(sessionsDir)) continue;
    const paths = readdirSync(sessionsDir).filter((name) => /^[a-z0-9][a-z0-9-]*\.jsonl$/i.test(name)).map((name) => [name.slice(0, -6), join(sessionsDir, name)] as const);
    const eventsById = new Map(paths.map(([id, path]) => [id, readEvents(path)]));
    const claimedTargets = new Set<string>();
    for (const [orphanId, orphanPath] of paths) {
      const orphan = eventsById.get(orphanId)!;
      const source = orphanTask(orphan);
      if (!source || hasMarker(orphan, orphanId)) continue;
      const candidates = unfinishedCandidates(eventsById, source.task, source.at, windowMs).filter((id) => id !== orphanId && !hasMarker(eventsById.get(id)!, orphanId));
      if (candidates.length !== 1 || claimedTargets.has(candidates[0]!)) {
        report.refused.push({ profile, orphanId, reason: candidates.length === 0 ? "no unique unfinished user turn within time window" : "ambiguous unfinished user turn" });
        continue;
      }
      const targetId = candidates[0]!;
      const imported = outputEvents(orphan);
      if (!imported.length) { report.refused.push({ profile, orphanId, reason: "no output events to import" }); continue; }
      claimedTargets.add(targetId);
      report.matches.push({ profile, orphanId, targetId, task: source.task, importedEvents: imported.length });
      if (!opts.apply) continue;
      const targetPath = join(sessionsDir, `${targetId}.jsonl`);
      copyFileSync(orphanPath, `${orphanPath}.bak.${stamp}`);
      copyFileSync(targetPath, `${targetPath}.bak.${stamp}`);
      appendFileSync(targetPath, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: orphanPath, note: `${MARKER_PREFIX}${orphanId}` })}\n`, "utf8");
      for (const event of imported) appendFileSync(targetPath, `${JSON.stringify(event)}\n`, "utf8");
      report.applied++;
    }
  }
  return report;
}

function usage(): never {
  throw new Error("usage: recover-split-sessions.ts --profiles-dir <path> [--window-minutes <n>] [--apply]");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--profiles-dir");
  if (dirIndex < 0 || !args[dirIndex + 1]) usage();
  const minutesIndex = args.indexOf("--window-minutes");
  const result = recoverSplitSessions({ profilesDir: args[dirIndex + 1]!, apply: args.includes("--apply"), windowMinutes: minutesIndex >= 0 ? Number(args[minutesIndex + 1]) : undefined });
  console.log(JSON.stringify(result, null, 2));
}
