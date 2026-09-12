/**
 * DeepHarness web dashboard — the runtime's second client (PRD §37 preview).
 * Serves one page + a tiny JSON/SSE API on localhost.
 */
import { activeProfileName, loadConfig, HARNESS_HOME } from "@harness/core";
import type { ProviderHealth, RoutingDecision } from "@harness/core";
import { buildFleet, fleetModels } from "@harness/providers";
import { findDelegationDoc, parseDelegation, route } from "@harness/router";
import { compileContext } from "@harness/context";
import { SessionStore, listSessions, usageSummary } from "@harness/sessions";
import { askRouted, type OrchestratorContext } from "../../cli/src/orchestrator.ts";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanSkills } from "@harness/skills";
import { scanTools } from "@harness/tools";
import { ORCHESTRATOR_ONLY_MODELS } from "@harness/providers";

const PORT = Number(process.env.HARNESS_WEB_PORT ?? 8790);
const here = dirname(fileURLToPath(import.meta.url));

async function buildWebContext(profile: string): Promise<OrchestratorContext & { delegationPath: string | null }> {
  const fleet = await buildFleet(profile);
  const models = await fleetModels(fleet);
  const s0 = loadSettings();
  for (const cm of s0.customModels ?? []) {
    const [prov, ...rest] = cm.id.split("/");
    models.push({
      id: cm.id, model: rest.join("/") || cm.id, provider: prov ?? "custom",
      name: cm.display ?? cm.id,
      capabilities: { coding: cm.coding ?? 7, reasoning: cm.reasoning ?? 7, context: cm.context ?? 128000, billing: (cm.billing as never) ?? "api", longContext: (cm.context ?? 0) > 400_000 },
    });
  }
  const health = new Map<string, ProviderHealth>();
  await Promise.all([...fleet.providers.entries()].map(async ([id, p]) => health.set(id, await p.health())));
  // Project config (.harness/, project delegation.md) resolves from the workspace.
  const loaded = loadConfig(profile, activeWorkspace(profile));
  const doc = findDelegationDoc(loaded.projectDir, HARNESS_HOME, profile);
  const delegation = doc ? parseDelegation(doc.text, doc.path) : null;
  return {
    providers: fleet.providers,
    models,
    health,
    delegation,
    session: new SessionStore(profile),
    profile,
    delegationPath: doc?.path ?? null,
  };
}

// ---- Settings (persisted) + orchestrator gating --------------------------
interface HarnessSettings {
  astraAvailable: boolean;
  theme: "gold" | "inverse";
  /** Working folder per profile (Claude Code-style project picker). */
  workspaces: Record<string, string>;
  /** User-registered models (Settings → Add a model). */
  customModels: Array<{ id: string; display?: string; role?: string; bestAt: string[]; avoidFor: string[]; coding?: number; reasoning?: number; context?: number; billing?: string }>;
  /** Fleet model ids hidden from routing and the roster. */
  hiddenModels: string[];
  /** Model used as the main starting model when the composer pin is empty. */
  startModel: string;
  /** Hide reasoning/thinking output in conversations. */
  reasoningOff: boolean;
}
const DEFAULT_SETTINGS: HarnessSettings = { astraAvailable: false, theme: "gold", workspaces: {}, customModels: [], hiddenModels: [], startModel: "", reasoningOff: false };
function loadSettings(): HarnessSettings {
  const path = join(HARNESS_HOME, "settings.json");
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s: HarnessSettings): void {
  writeFileSync(join(HARNESS_HOME, "settings.json"), JSON.stringify(s, null, 2), "utf8");
}
/** Orchestrator-only models (Astra) leave the pool unless gated on AND the job is an orchestration. */
function routedModels(all: OrchestratorContext["models"], s: HarnessSettings, orchestratorJob: boolean) {
  const hidden = new Set(s.hiddenModels ?? []);
  const pool = all.filter((m) => !ORCHESTRATOR_ONLY_MODELS.has(m.id) && !hidden.has(m.id));
  if (s.astraAvailable && orchestratorJob) return all.filter((m) => !hidden.has(m.id));
  return pool;
}

/** Active working folder for a profile (validated directory). */
function activeWorkspace(profile: string): string {
  const raw = loadSettings().workspaces?.[profile];
  if (raw) {
    try {
      const abs = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
      if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
    } catch { /* fall through to home */ }
  }
  return homedir();
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json",
  ".css": "text/css", ".woff2": "font/woff2", ".js": "text/javascript",
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" },
});

Bun.serve({
  port: PORT,
  idleTimeout: 255, // SSE streams idle while a CLI adapter waits; Bun default is 10s
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = join(here, "..", "index.html");
      return new Response(readFileSync(page, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const profile = url.searchParams.get("profile") ?? activeProfileName();

    if (url.pathname.startsWith("/assets/")) {
      const rel = url.pathname.slice("/assets/".length);
      if (rel.includes("..")) return json({ error: "bad path" }, 400);
      const file = join(here, "..", "assets", rel);
      if (!existsSync(file)) return json({ error: "not found" }, 404);
      return new Response(readFileSync(file), {
        headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
      });
    }

    if (url.pathname === "/brand.css") {
      return new Response(readFileSync(join(here, "..", "brand.css"), "utf8"), {
        headers: { "content-type": "text/css", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/meta") {
      const modelsMeta = JSON.parse(readFileSync(join(here, "..", "models-meta.json"), "utf8"));
      const verbs = JSON.parse(readFileSync(join(here, "..", "verbs.json"), "utf8"));
      return json({ ...modelsMeta, ...verbs, settings: loadSettings() });
    }

    if (url.pathname === "/api/settings" && req.method === "GET") return json(loadSettings());

    // Directory browser for the workspace picker — directories only, names never contents.
    if (url.pathname === "/api/fs/list") {
      const raw = url.searchParams.get("dir");
      let dir = homedir();
      if (raw && raw !== "~") {
        const abs = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
        try {
          if (statSync(abs).isDirectory()) dir = abs;
        } catch {
          return json({ error: "not a directory" }, 400);
        }
      }
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort()
        .slice(0, 500);
      const parent = dirname(dir);
      return json({ dir, parent: parent === dir ? null : parent, entries });
    }

    if (url.pathname === "/api/models" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string } & Record<string, unknown>;
      if (!body.id || !/^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(body.id)) return json({ error: "id must be provider/model" }, 400);
      const s = loadSettings();
      s.customModels = [...(s.customModels ?? []).filter((m) => m.id !== body.id), {
        id: body.id, display: typeof body.display === "string" ? body.display : undefined,
        role: typeof body.role === "string" ? body.role : undefined,
        bestAt: Array.isArray(body.bestAt) ? body.bestAt.map(String) : [],
        avoidFor: Array.isArray(body.avoidFor) ? body.avoidFor.map(String) : [],
        coding: typeof body.coding === "number" ? body.coding : undefined,
        reasoning: typeof body.reasoning === "number" ? body.reasoning : undefined,
        context: typeof body.context === "number" ? body.context : undefined,
        billing: typeof body.billing === "string" ? body.billing : undefined,
      }];
      s.hiddenModels = (s.hiddenModels ?? []).filter((h) => h !== body.id);
      saveSettings(s);
      return json({ ok: true });
    }
    if (url.pathname === "/api/models" && req.method === "DELETE") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; custom?: boolean; unhide?: boolean };
      if (!body.id) return json({ error: "id required" }, 400);
      const s = loadSettings();
      if (body.unhide) s.hiddenModels = (s.hiddenModels ?? []).filter((h) => h !== body.id);
      else if (body.custom) s.customModels = (s.customModels ?? []).filter((m) => m.id !== body.id);
      else if (!(s.hiddenModels ?? []).includes(body.id)) s.hiddenModels = [...(s.hiddenModels ?? []), body.id];
      saveSettings(s);
      return json({ ok: true });
    }

    if (url.pathname === "/api/workspace" && req.method === "GET") {
      return json({ workspace: activeWorkspace(profile), profile });
    }
    if (url.pathname === "/api/workspace" && req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { path?: string };
      if (!body.path) return json({ error: "path required" }, 400);
      const abs = body.path.startsWith("~/") ? join(homedir(), body.path.slice(2)) : resolve(body.path);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return json({ error: "not a directory" }, 400);
      const s = loadSettings();
      s.workspaces = { ...(s.workspaces ?? {}), [profile]: abs };
      saveSettings(s);
      return json({ workspace: abs, profile });
    }

    if (url.pathname === "/api/settings" && req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as Partial<HarnessSettings>;
      const s = { ...loadSettings(), ...body };
      saveSettings(s);
      return json(s);
    }

    if (url.pathname === "/api/skills") {
      return json({ skills: await scanSkills({ cwd: process.cwd(), harnessHome: HARNESS_HOME }) });
    }
    if (url.pathname === "/api/tools") {
      return json({ tools: await scanTools() });
    }
    if (url.pathname === "/api/routines") {
      const path = join(HARNESS_HOME, "routines.json");
      if (!existsSync(path)) {
        writeFileSync(path, JSON.stringify({ routines: [
          { id: "morning-triage", name: "Morning triage", steps: ["Summarize unread items and classify by urgency", "Draft replies for the simple ones locally"], model: "" },
          { id: "repo-review", name: "Repo review", steps: ["Plan the review approach", "Inspect changed files for defects", "Cross-model verify findings"], model: "" },
          { id: "deep-research", name: "Deep research", steps: ["Decompose the question", "Research across sources with a long-context model", "Synthesize with verification"], model: "kimi/k3" },
        ] }, null, 2), "utf8");
      }
      return json(JSON.parse(readFileSync(path, "utf8")));
    }

    if (url.pathname === "/api/status") {
      const ctx = await buildWebContext(profile);
      const st = loadSettings();
      const hidden = new Set(st.hiddenModels ?? []);
      const customIds = new Set((st.customModels ?? []).map((m) => m.id));
      return json({
        settings: st,
        hiddenModels: st.hiddenModels ?? [],
        workspace: activeWorkspace(profile),
        profile,
        profiles: ["home", "work"],
        providers: [...ctx.health.entries()].map(([id, h]) => ({
          id,
          ok: h.ok,
          detail: h.detail,
          models: ctx.models.filter((m) => m.provider === id && !hidden.has(m.id)).map((m) => ({
            id: m.id,
            custom: customIds.has(m.id),
            orchestratorOnly: ORCHESTRATOR_ONLY_MODELS.has(m.id),
            caps: {
              coding: m.capabilities.coding,
              reasoning: m.capabilities.reasoning,
              context: m.capabilities.context,
              billing: m.capabilities.billing,
              local: m.capabilities.local ?? false,
            },
          })),
        })),
        providersExtras: ctx.models
          .filter((m) => customIds.has(m.id) && !ctx.providers.has(m.provider) && !hidden.has(m.id))
          .map((m) => ({ id: m.id, custom: true, orchestratorOnly: false, caps: { coding: m.capabilities.coding, reasoning: m.capabilities.reasoning, context: m.capabilities.context, billing: m.capabilities.billing, local: false } })),
        delegation: {
          path: ctx.delegationPath,
          frontmatter: ctx.delegation?.frontmatter ?? null,
          rows: ctx.delegation?.rows ?? [],
        },
      });
    }

    if (url.pathname === "/api/explain") {
      const task = url.searchParams.get("task") ?? "";
      if (!task.trim()) return json({ error: "task required" }, 400);
      const ctx = await buildWebContext(profile);
      const decision: RoutingDecision = route({
        task,
        models: ctx.models,
        health: ctx.health,
        delegation: ctx.delegation,
      });
      return json({ decision });
    }

    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { task?: string; model?: string; sessionId?: string; escalate?: boolean; orchestrator?: boolean; noFallback?: boolean };
      const task = (body.task ?? "").trim();
      if (!task) return json({ error: "task required" }, 400);

      const ctx = await buildWebContext(profile);
      const settings = loadSettings();
      const orchestratorJob = body.orchestrator === true;
      const pool = routedModels(ctx.models, settings, orchestratorJob);
      if (body.model && ORCHESTRATOR_ONLY_MODELS.has(body.model) && !(settings.astraAvailable && orchestratorJob)) {
        return json({ error: "orchestrator-only model is gated off (enable in Settings, and mark the job as an orchestration)" }, 403);
      }
      const session = body.sessionId ? new SessionStore(profile, body.sessionId) : ctx.session;
      session.append({ v: 1, ts: new Date().toISOString(), kind: "user-message", text: task });
      session.append({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: activeWorkspace(profile), note: "workspace" });

      const history = session.messages().slice(0, -1);
      const decision0 = route({ task, models: pool, health: ctx.health, delegation: ctx.delegation, escalate: body.escalate });
      const target = pool.find((m) => m.id === decision0.selected);
      const workspace = activeWorkspace(profile);
      const messages = target
        ? compileContext(task, target, { cwd: workspace, history })
        : [{ role: "user" as const, content: task }];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          send({ t: "route", decision: decision0, session: session.sessionId });
          try {
            const routedCtx: OrchestratorContext = { ...ctx, models: pool };
            const effectivePin = body.model || (settings.startModel && pool.some((m) => m.id === settings.startModel) ? settings.startModel : undefined);
            const result = await askRouted(routedCtx, task, messages, {
              pinnedModel: effectivePin,
              escalate: body.escalate,
              noFallback: body.noFallback,
              onEvent: (e) => {
                if (e.type === "text-delta") send({ t: "delta", text: e.text });
                else if (e.type === "reasoning-delta" && !settings.reasoningOff) send({ t: "thinking", text: e.text });
                else if (e.type === "usage") send({ t: "usage", usage: e.usage });
              },
            });
            for (const fb of result.fellBack) send({ t: "fallback", ...fb });
            send({ t: "done", model: result.modelUsed, text: result.text, usage: result.usage });
          } catch (err) {
            send({ t: "error", message: (err as Error).message });
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    if (url.pathname === "/api/sessions") return json({ sessions: listSessions(profile) });
    if (url.pathname === "/api/session" && req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[a-z0-9-]+$/i.test(id)) return json({ error: "bad id" }, 400);
      const { rmSync } = await import("node:fs");
      try { rmSync(join(HARNESS_HOME, "profiles", profile, "sessions", id + ".jsonl")); return json({ ok: true }); }
      catch { return json({ error: "not found" }, 404); }
    }
    if (url.pathname === "/api/session") {
      const store = new SessionStore(profile, url.searchParams.get("id") ?? "");
      return json({ events: store.all() });
    }
    if (url.pathname === "/api/usage") return json({ usage: await usageSummary(profile) });

    return json({ error: "not found" }, 404);
  },
});

console.log(`DeepHarness web → http://localhost:${PORT} (profile: ${activeProfileName()})`);
