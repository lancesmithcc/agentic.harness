/**
 * agentic.harness web dashboard — the runtime's second client.
 * Serves one page + a tiny JSON/SSE API on localhost.
 */
import { activeProfileName, ensureHarnessHome, loadConfig, HARNESS_HOME } from "@harness/core";
import type { ProviderHealth, RoutingDecision } from "@harness/core";
import { buildFleet, fleetModels } from "@harness/providers";
import { findDelegationDoc, parseDelegation, route, taskRequiresTools } from "@harness/router";
import { buildSelfKnowledge, compileContext, findSourceRoot, selfEvolutionIntent } from "@harness/context";
import { SessionStore, isSessionId, listSessions, sessionPath, usageSummary } from "@harness/sessions";
import { askRouted, type OrchestratorContext } from "../../cli/src/orchestrator.ts";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname, extname, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { scanSkills } from "@harness/skills";
import { scanTools } from "@harness/tools";
import { ORCHESTRATOR_ONLY_MODELS } from "@harness/providers";
import { DiscoveryCache } from "./discovery-cache.ts";
import { beginEvolution, evolutionStatus, syncEvolution, revertEvolution, recoverEvolution, acknowledgeEvolution, type SelfChange } from "./self-evolution.ts";

const PORT = Number(process.env.HARNESS_WEB_PORT ?? 8790);
const here = dirname(fileURLToPath(import.meta.url));
ensureHarnessHome();
/** Page, CSS, assets and JSON metadata. The desktop app points this at its bundled resources. */
const WEB_ROOT = process.env.HARNESS_WEB_ROOT ?? join(here, "..");

const HEALTH_CACHE_MS = 15_000;
const healthCache = new Map<string, { expires: number; value: Map<string, ProviderHealth>; pending?: Promise<Map<string, ProviderHealth>> }>();
const activeTurns = new Map<string, AbortController>();
const discoveryCache = new DiscoveryCache<WebDiscovery>();

interface WebDiscovery {
  providers: OrchestratorContext["providers"];
  models: OrchestratorContext["models"];
  health: Map<string, ProviderHealth>;
  delegation: OrchestratorContext["delegation"];
  delegationPath: string | null;
}

/** Provider health checks can involve several subprocesses/network probes. */
async function cachedHealth(key: string, providers: Map<string, { health: () => Promise<ProviderHealth> }>): Promise<Map<string, ProviderHealth>> {
  const cached = healthCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending ?? cached.value;
  const value = new Map<string, ProviderHealth>();
  const pending = Promise.all([...providers.entries()].map(async ([id, provider]) => value.set(id, await provider.health()))).then(() => value);
  healthCache.set(key, { expires: Date.now() + HEALTH_CACHE_MS, value, pending });
  try { return await pending; }
  finally {
    const latest = healthCache.get(key);
    if (latest?.pending === pending) delete latest.pending;
  }
}

function configFingerprint(profile: string, workspace: string, projectDir: string | null): string {
  const paths = [join(HARNESS_HOME, "config.toml"), join(HARNESS_HOME, "profiles", profile, "profile.toml")];
  if (projectDir) for (const name of ["config.toml", "config.yaml", "config.yml"]) paths.push(join(projectDir, name));
  return `${workspace}\0${paths.map((path) => { try { const stat = statSync(path); return `${path}:${stat.mtimeMs}:${stat.size}`; } catch { return `${path}:missing`; } }).join("|")}`;
}

async function discoverWebContext(profile: string, workspace: string): Promise<WebDiscovery> {
  const loaded = loadConfig(profile, workspace);
  const key = `${profile}\0${workspace}`;
  const fingerprint = configFingerprint(profile, workspace, loaded.projectDir);
  return discoveryCache.get(key, fingerprint, async () => {
    const fleet = await buildFleet(profile, workspace);
    const models = await fleetModels(fleet);
    const health = await cachedHealth(key, fleet.providers);
    const doc = findDelegationDoc(loaded.projectDir, HARNESS_HOME, profile);
    return { providers: fleet.providers, models, health, delegation: doc ? parseDelegation(doc.text, doc.path) : null, delegationPath: doc?.path ?? null };
  }, HEALTH_CACHE_MS);
}

async function buildWebContext(profile: string, session = new SessionStore(profile)): Promise<OrchestratorContext & { delegationPath: string | null }> {
  const workspace = activeWorkspace(profile);
  const discovered = await discoverWebContext(profile, workspace);
  const models = [...discovered.models];
  const s0 = loadSettings();
  for (const cm of s0.customModels ?? []) {
    const [prov, ...rest] = cm.id.split("/");
    const backend = discovered.providers.get(prov ?? "custom");
    if (models.some(model => model.id === cm.id)) continue;
    models.push({
      id: cm.id, model: rest.join("/") || cm.id, provider: prov ?? "custom",
      name: cm.display ?? cm.id,
      capabilities: { ...backend?.capabilities(rest.join("/")), coding: cm.coding ?? 7, reasoning: cm.reasoning ?? 7, context: cm.context ?? 128000, billing: (cm.billing as never) ?? "api", longContext: (cm.context ?? 0) > 400_000, tools: backend?.capabilities(rest.join("/")).tools === true },
    });
  }
  return {
    providers: discovered.providers,
    models,
    health: discovered.health,
    delegation: discovered.delegation,
    session,
    profile,
    delegationPath: discovered.delegationPath,
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
  /** How much CLI agents may do in the working folder (Settings → Agent file access). */
  agentAccess: "read-only" | "workspace" | "full";
  /** Let CLI agents edit the harness's own source (Settings → Self-evolve). */
  selfEvolve: boolean;
  /** DeepHarness source root; detected when the server runs from the repo, so the desktop app can find it. */
  selfSourceRoot: string;
}
const DEFAULT_SETTINGS: HarnessSettings = { astraAvailable: false, theme: "gold", workspaces: {}, customModels: [], hiddenModels: [], startModel: "", reasoningOff: false, agentAccess: "workspace", selfEvolve: false, selfSourceRoot: "" };
function loadSettings(): HarnessSettings {
  const path = join(HARNESS_HOME, "settings.json");
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s: HarnessSettings): void {
  writeFileSync(join(HARNESS_HOME, "settings.json"), JSON.stringify(s, null, 2), "utf8");
  // Settings can affect custom models and the active workspace.
  discoveryCache.clear();
  healthCache.clear();
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

// ---- Subscription logins (Settings → Accounts) ---------------------------
// Runs the official CLI login inside the profile's isolated env — the same
// dirs the claude-code / codex adapters use. Tokens stay owned by the CLIs.
type AuthProvider = "claude" | "chatgpt";
interface LoginRun { child: ChildProcess; url: string | null; output: string; done: boolean; exitCode: number | null }
const loginRuns = new Map<string, LoginRun>();
const LOGIN_TTL_MS = 10 * 60_000;

function authEnv(provider: AuthProvider, profile: string): NodeJS.ProcessEnv {
  const dir = join(HARNESS_HOME, "profiles", profile, provider === "claude" ? "claude" : "codex");
  mkdirSync(dir, { recursive: true });
  return provider === "claude" ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : { ...process.env, CODEX_HOME: dir };
}

function runCli(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { env, timeout: 15_000 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function authStatus(provider: AuthProvider, profile: string) {
  const run = loginRuns.get(`${profile}:${provider}`);
  const pending = !!run && !run.done;
  const env = authEnv(provider, profile);
  if (provider === "claude") {
    const r = await runCli("claude", ["auth", "status", "--json"], env);
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string };
      return { loggedIn: !!j.loggedIn, detail: j.loggedIn ? [j.email, j.authMethod].filter(Boolean).join(" · ") : "", pending };
    } catch {
      return { loggedIn: false, detail: (r.stderr || r.stdout).trim().slice(0, 160) || "claude CLI unavailable", pending };
    }
  }
  const r = await runCli("codex", ["login", "status"], env);
  const last = `${r.stdout}\n${r.stderr}`.trim().split("\n").pop() ?? "";
  return { loggedIn: r.code === 0, detail: r.code === 0 ? last : "", pending };
}

/** Spawn the CLI login; resolves once the sign-in URL appears (or after 8s). */
function startLogin(provider: AuthProvider, profile: string): Promise<LoginRun> {
  const key = `${profile}:${provider}`;
  const prev = loginRuns.get(key);
  if (prev && !prev.done) { try { prev.child.kill(); } catch { /* already gone */ } }
  const [cmd, args] = provider === "claude" ? ["claude", ["auth", "login"]] : ["codex", ["login"]];
  const child = spawn(cmd, args, { env: authEnv(provider, profile), stdio: ["pipe", "pipe", "pipe"] });
  const run: LoginRun = { child, url: null, output: "", done: false, exitCode: null };
  loginRuns.set(key, run);
  const killer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, LOGIN_TTL_MS);
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(run); } };
    const onData = (d: Buffer) => {
      run.output = (run.output + d.toString()).slice(-4000);
      const m = !run.url && run.output.match(/https:\/\/[^\s"'<>]+/);
      if (m) { run.url = m[0]; settle(); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => { run.done = true; run.output += `\n${e.message}`; clearTimeout(killer); settle(); });
    child.on("exit", (code) => { run.done = true; run.exitCode = code; clearTimeout(killer); settle(); });
    setTimeout(settle, 8000);
  });
}

// ---- Routines: CRUD store + heartbeat scheduler ---------------------------
interface Heartbeat { enabled: boolean; every: number; unit: "minutes" | "hours" | "days"; anchor?: string }
interface Routine {
  id: string;
  name: string;
  steps: string[];
  model: string;
  heartbeat?: Heartbeat;
  lastRun?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastSession?: string;
}
const ROUTINES_PATH = join(HARNESS_HOME, "routines.json");
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
const MIN_HEARTBEAT_MS = 5 * 60_000;
/** routine id → progress of its in-flight run */
const routineRuns = new Map<string, { step: number; sessionId: string }>();

function saveRoutines(rs: Routine[]): void {
  writeFileSync(ROUTINES_PATH, JSON.stringify({ routines: rs }, null, 2), "utf8");
}
function loadRoutines(): Routine[] {
  if (!existsSync(ROUTINES_PATH)) {
    const seed: Routine[] = [
      { id: "morning-triage", name: "Morning triage", steps: ["Summarize unread items and classify by urgency", "Draft replies for the simple ones locally"], model: "" },
      { id: "repo-review", name: "Repo review", steps: ["Plan the review approach", "Inspect changed files for defects", "Cross-model verify findings"], model: "" },
      { id: "deep-research", name: "Deep research", steps: ["Decompose the question", "Research across sources with a long-context model", "Synthesize with verification"], model: "kimi/k3" },
    ];
    saveRoutines(seed);
    return seed;
  }
  try {
    return (JSON.parse(readFileSync(ROUTINES_PATH, "utf8")) as { routines?: Routine[] }).routines ?? [];
  } catch {
    return [];
  }
}
/** Re-read before writing so run bookkeeping never clobbers an edit made mid-run. */
function patchRoutine(id: string, patch: Partial<Routine>): void {
  const rs = loadRoutines();
  const r = rs.find((x) => x.id === id);
  if (!r) return; // deleted while running
  Object.assign(r, patch);
  saveRoutines(rs);
}

function heartbeatMs(hb?: Heartbeat): number | null {
  if (!hb?.enabled) return null;
  const every = Math.max(1, Math.floor(Number(hb.every) || 1));
  return Math.max(MIN_HEARTBEAT_MS, every * (UNIT_MS[hb.unit] ?? UNIT_MS.hours));
}
/** Next due time: one interval after the later of the last run and when the schedule was set. */
function nextRunAt(r: Routine): number | null {
  const ms = heartbeatMs(r.heartbeat);
  if (ms === null) return null;
  const base = Math.max(Date.parse(r.lastRun ?? "") || 0, Date.parse(r.heartbeat?.anchor ?? "") || 0);
  return (base || Date.now()) + ms;
}

function normalizeRoutine(body: Partial<Routine>, prev?: Routine): Routine | string {
  const name = String(body.name ?? "").trim().slice(0, 120);
  const steps = Array.isArray(body.steps) ? body.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 50) : [];
  if (!name) return "name required";
  if (!steps.length) return "at least one step required";
  const unit = body.heartbeat?.unit;
  const hb: Heartbeat = {
    enabled: body.heartbeat?.enabled === true,
    every: Math.max(1, Math.min(10_000, Math.floor(Number(body.heartbeat?.every) || 1))),
    unit: unit === "minutes" || unit === "days" ? unit : "hours",
  };
  if (hb.enabled && hb.unit === "minutes" && hb.every < 5) return "minimum heartbeat is 5 minutes";
  const prevHb = prev?.heartbeat;
  const rescheduled = !prevHb?.enabled || prevHb.every !== hb.every || prevHb.unit !== hb.unit || !prevHb.anchor;
  if (hb.enabled) hb.anchor = rescheduled ? new Date().toISOString() : prevHb!.anchor;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "routine";
  return { ...prev, id: prev?.id ?? `${slug}-${randomUUID().slice(0, 6)}`, name, steps, model: String(body.model ?? "").trim(), heartbeat: hb };
}

/** Start a routine in the background: every step is one routed turn in a fresh session. */
function runRoutine(r: Routine, profile: string): string {
  const session = new SessionStore(profile);
  routineRuns.set(r.id, { step: 1, sessionId: session.sessionId });
  patchRoutine(r.id, { lastSession: session.sessionId });
  void (async () => {
    let error: string | undefined;
    try {
      const ts = () => new Date().toISOString();
      session.append({ v: 1, ts: ts(), kind: "user-message", text: `Routine · ${r.name}` }); // session title
      const ctx = await buildWebContext(profile);
      const settings = loadSettings();
      const pool = routedModels(ctx.models, settings, false);
      const workspace = activeWorkspace(profile);
      session.append({ v: 1, ts: ts(), kind: "artifact", path: workspace, note: "workspace" });
      if (r.model && !pool.some((m) => m.id === r.model)) throw new Error(`model ${r.model} is not available in profile ${profile}`);
      const pin = r.model || (settings.startModel && pool.some((m) => m.id === settings.startModel) ? settings.startModel : undefined);
      for (let i = 0; i < r.steps.length; i++) {
        routineRuns.set(r.id, { step: i + 1, sessionId: session.sessionId });
        const task = r.steps[i]!;
        session.append({ v: 1, ts: ts(), kind: "user-message", text: task });
        const history = session.messages().slice(1, -1); // skip the title turn
        const useTools = needsTools(task, session);
        const decision = route({ task, models: pool, health: ctx.health, delegation: ctx.delegation, pinnedModel: pin, requiresTools: useTools });
        const target = pool.find((m) => m.id === decision.selected);
        const request = { ...agentRequest(workspace, task), tools: useTools };
        const messages = target
          ? compileContext(task, target, { cwd: request.cwd, history, skillInstructions: toolsHint(), self: selfKnowledge(profile, request.cwd) })
          : [{ role: "user" as const, content: task }];
        const before = snapshotFiles(workspace);
        const stepStart = Date.now();
        const selfWatch = beginSelfWatch(profile, session.sessionId);
        const stepToolPaths: string[] = [];
        try {
          const result = await askRouted({ ...ctx, models: pool, session }, task, messages, {
            pinnedModel: pin,
            request,
            requiresTools: useTools,
            onEvent: (e) => { if (e.type === "tool-call") stepToolPaths.push(...toolCallPaths(e.arguments)); },
          });
          const outputs = pool.find(model => model.id === result.modelUsed)?.capabilities.tools ? detectArtifacts(workspace, before, stepStart, result.text, stepToolPaths) : [];
          for (const a of outputs) {
            session.append({ v: 1, ts: ts(), kind: "artifact", path: a.path, note: "output" });
          }
          if (!result.text.trim()) throw new Error(`step ${i + 1} returned no output (${result.modelUsed})`);
        } finally {
          try {
            const change = selfWatch?.finish();
            if (change) {
              session.append({ v: 1, ts: ts(), kind: "self-change", ...change });
              acknowledgeEvolution(change.root, change.afterCommit);
            }
            if (selfWatch) syncSelfChanges(selfWatch.root);
          } finally { selfWatch?.release(); }
        }
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    routineRuns.delete(r.id);
    patchRoutine(r.id, { lastRun: new Date().toISOString(), lastStatus: error ? "error" : "ok", lastError: error, lastSession: session.sessionId });
  })();
  return session.sessionId;
}

function heartbeatTick(): void {
  const now = Date.now();
  for (const r of loadRoutines()) {
    const next = nextRunAt(r);
    if (next === null || next > now || routineRuns.has(r.id)) continue;
    runRoutine(r, activeProfileName());
  }
}
setInterval(heartbeatTick, 30_000);

// ---- Agent access, attachments, artifacts ---------------------------------
const PROFILE_RE = /^[a-z0-9_-]+$/i;
const AGENT_TIMEOUT_MS = 20 * 60_000;
const MAX_UPLOAD = 25 * 1024 * 1024;

/** All adapters receive the working folder, selected access, and registered MCP servers. */
function agentRequest(workspace: string, task = "") {
  const s = loadSettings();
  const access: "read-only" | "workspace" | "full" = s.agentAccess === "read-only" || s.agentAccess === "full" ? s.agentAccess : "workspace";
  const root = s.selfEvolve && access !== "read-only" ? sourceRoot() : null;
  // The official DeepSeek sandbox has one writable root. Explicit self-evolve
  // requests use the source as that root without raising the selected access.
  const cwd = root && selfEvolutionIntent(task) ? root : workspace;
  return { cwd, access, mcpConfig: mcpConfigPath(), timeoutMs: AGENT_TIMEOUT_MS, addDirs: [] as string[] };
}

function needsSelfTools(task: string): boolean {
  return loadSettings().selfEvolve && selfEvolutionIntent(task);
}

function needsTools(task: string, session: SessionStore): boolean {
  return needsSelfTools(task) || taskRequiresTools(task) || session.all().some(event => event.kind === "tool-call" || event.kind === "tool-result");
}

// ---- Self-knowledge + self-evolve -----------------------------------------
const HARNESS_CLIENT: "web" | "desktop" = process.env.HARNESS_CLIENT === "desktop" ? "desktop" : "web";
/** Source root when this server runs from the repo; remembered so the compiled desktop app can find it too. */
const DETECTED_SOURCE_ROOT = findSourceRoot(here);
if (DETECTED_SOURCE_ROOT && loadSettings().selfSourceRoot !== DETECTED_SOURCE_ROOT) {
  const s = loadSettings();
  s.selfSourceRoot = DETECTED_SOURCE_ROOT;
  saveSettings(s);
}

function sourceRoot(): string | null {
  const saved = loadSettings().selfSourceRoot;
  if (saved && findSourceRoot(saved) === saved) return saved;
  return DETECTED_SOURCE_ROOT;
}

function selfKnowledge(profile: string, workspace: string): string {
  return buildSelfKnowledge({
    sourceRoot: sourceRoot(),
    profile,
    workspace,
    access: agentRequest(workspace).access,
    selfEvolve: !!loadSettings().selfEvolve,
    client: HARNESS_CLIENT,
  });
}

function git(root: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

/** Save a durable source checkpoint before allowing any self-evolve turn. */
function beginSelfWatch(profile: string, sessionId: string) {
  const settings = loadSettings();
  const root = sourceRoot();
  if (!settings.selfEvolve || settings.agentAccess === "read-only") return null;
  if (!root) throw new Error("Self-evolve needs a source folder. Configure it in Settings.");
  recoverAndSyncSelf();
  return beginEvolution(root, { profile, sessionId });
}

function syncSelfChanges(root: string): void {
  // Give chat completion a chance to render before checking/pushing Git history.
  setTimeout(() => { void syncEvolution(root).catch(() => { /* status retains a retryable failure */ }); }, 0);
}

/** Only self-changes a session actually recorded can be diffed or reverted. */
function findSelfChange(profile: string, sid: string, before: string, after: string): SelfChange | null {
  const log = join(HARNESS_HOME, "profiles", profile, "sessions", `${sid}.jsonl`);
  if (!existsSync(log)) return null;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.includes('"self-change"')) continue;
    try {
      const e = JSON.parse(line) as Partial<SelfChange> & { kind?: string };
      if (e.kind === "self-change" && e.before === before && e.after === after && e.root) {
        return { ...e, root: e.root, before, after, files: e.files ?? [] } as SelfChange;
      }
    } catch {
      // partial line
    }
  }
  return null;
}

/** Recover source edits left by an interrupted process, then retry pending sync. */
function recoverAndSyncSelf(): void {
  const root = sourceRoot();
  if (!root) return;
  try {
    const recovered = recoverEvolution(root);
    if (recovered.change && recovered.profile && PROFILE_RE.test(recovered.profile) && recovered.sessionId && isSessionId(recovered.sessionId)) {
      const session = new SessionStore(recovered.profile, recovered.sessionId);
      const known = session.all().some((event) => event.kind === "self-change" && event.after === recovered.change!.after);
      if (!known) session.append({ v: 1, ts: new Date().toISOString(), kind: "self-change", ...recovered.change });
      acknowledgeEvolution(root, recovered.change.afterCommit);
    } else if (recovered.change && !recovered.sessionId) {
      acknowledgeEvolution(root, recovered.change.afterCommit);
    }
    const status = evolutionStatus(root);
    if (!status.busy && status.localCommit && (status.sync === "pending" || status.sync === "error")) syncSelfChanges(root);
  } catch (err) {
    console.error("Self-evolve recovery:", (err as Error).message);
  }
}
setTimeout(recoverAndSyncSelf, 0);
setInterval(recoverAndSyncSelf, 60_000);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".zip": "application/zip",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const mimeFor = (p: string) => MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream";
const TEXT_EXTS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".js", ".jsx",
  ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".swift", ".kt", ".sql", ".sh", ".log", ".ini", ".svg",
]);
const uploadsDir = (workspace: string) => join(workspace, ".harness", "uploads");
const UPLOAD_PREFIX_RE = /^\d{8}-\d{6}-(\d+-)?/;

interface Attachment { path: string; name: string; size: number; type: string }
/** Only files the harness itself saved into this workspace's uploads folder are accepted. */
function validAttachments(raw: unknown, workspace: string): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const root = uploadsDir(workspace) + "/";
  const out: Attachment[] = [];
  for (const a of raw.slice(0, 20)) {
    const p = resolve(String((a as { path?: unknown } | null)?.path ?? ""));
    if (!p.startsWith(root) || !existsSync(p)) continue;
    const st = statSync(p);
    if (st.isFile()) out.push({ path: p, name: basename(p).replace(UPLOAD_PREFIX_RE, ""), size: st.size, type: mimeFor(p) });
  }
  return out;
}
/** Text files are inlined (capped); everything else is referenced by path for agents that can open it. */
function attachmentPrompt(atts: Attachment[]): { forModel: string; forHistory: string } {
  if (!atts.length) return { forModel: "", forHistory: "" };
  const model: string[] = [];
  const hist: string[] = [];
  let inlined = 0;
  for (const a of atts) {
    hist.push(`[Attached: ${a.name} — ${a.path}]`);
    const isText = TEXT_EXTS.has(extname(a.name).toLowerCase()) || a.type.startsWith("text/");
    if (isText && a.size <= 200_000 && inlined + a.size <= 400_000) {
      inlined += a.size;
      model.push(`--- Attached file: ${a.name} (saved at ${a.path}) ---\n${readFileSync(a.path, "utf8")}\n--- end of ${a.name} ---`);
    } else {
      model.push(`Attached file: ${a.name} — ${a.type}, ${Math.max(1, Math.round(a.size / 1024))} KB, saved at ${a.path}. Open it from disk if your tools allow.`);
    }
  }
  return { forModel: `\n\n${model.join("\n\n")}`, forHistory: `\n\n${hist.join("\n")}` };
}

const SNAPSHOT_SKIP = new Set(["node_modules", "dist", "build", "target", "Library", "Applications", "__pycache__", "venv"]);
/** path → mtime for visible files under the workspace (bounded depth, count and time). */
function snapshotFiles(root: string): Map<string, number> {
  const seen = new Map<string, number>();
  const deadline = Date.now() + 1500;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || seen.size > 20_000 || Date.now() > deadline) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SNAPSHOT_SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) { try { seen.set(full, statSync(full).mtimeMs); } catch { /* vanished */ } }
    }
  };
  walk(root, 0);
  return seen;
}

const ARTIFACT_PATH_RE = /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/[^\n"'`<>|*]*?\.(?:png|jpe?g|webp|gif|svg|pdf|md|txt|csv|json|html?|zip|docx|xlsx|pptx|mp4|mov|mp3|wav|m4a)(?![A-Za-z0-9])/gi;
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

const TOOL_PATH_KEYS = new Set(["file_path", "path", "notebook_path", "filepath", "filename", "output_path", "target_file", "new_path"]);

/** File paths named in an agent tool call (Claude Write/Edit/NotebookEdit, Codex file changes, MCP outputs). */
function toolCallPaths(argumentsJson: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (TOOL_PATH_KEYS.has(key) && value.length < 1024) out.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  try { walk(JSON.parse(argumentsJson)); } catch { /* not JSON */ }
  return out;
}

/** A session may only expose files it recorded as an attachment or an output. */
function recordedFile(profile: string, sid: string, path: string): boolean {
  if (!path) return false;
  const log = join(HARNESS_HOME, "profiles", profile, "sessions", `${sid}.jsonl`);
  if (!existsSync(log)) return false;
  const listed = readFileSync(log, "utf8").split("\n").some((line) => {
    if (!line.includes('"artifact"')) return false;
    try {
      const e = JSON.parse(line) as { kind?: string; path?: string; note?: string };
      return e.kind === "artifact" && e.path === path && (e.note === "output" || e.note === "attachment");
    } catch { return false; }
  });
  return listed && existsSync(path) && statSync(path).isFile();
}

/**
 * Files worth offering from a turn — only what the agent itself produced and pointed at:
 * paths its tools wrote, absolute paths it names in its answer (e.g. /gpt-image output),
 * and files changed in the working folder that the answer refers to by name. Background
 * churn in the folder (logs, caches, other apps) is never offered.
 */
function detectArtifacts(workspace: string, before: Map<string, number>, since: number, text: string, toolPaths: string[] = []): Attachment[] {
  const cutoff = since - 1000;
  const home = homedir();
  const found = new Set<string>();
  const eligible = (abs: string) => (abs.startsWith(home + "/") || abs.startsWith(workspace + "/")) && !/\/\./.test(abs);
  const fresh = (abs: string) => {
    try { const st = statSync(abs); return st.isFile() && st.mtimeMs >= cutoff; } catch { return false; }
  };
  for (const p of toolPaths) {
    const abs = p.startsWith("~/") ? join(home, p.slice(2)) : resolve(workspace, p);
    if (eligible(abs) && fresh(abs)) found.add(abs);
  }
  for (const m of text.matchAll(ARTIFACT_PATH_RE)) {
    for (const cand of new Set([m[0], safeDecode(m[0])])) {
      const abs = cand.startsWith("~/") ? join(home, cand.slice(2)) : resolve(cand);
      if (eligible(abs) && fresh(abs)) found.add(abs);
    }
  }
  if (text) {
    for (const [p, mtime] of snapshotFiles(workspace)) {
      const prev = before.get(p);
      if (mtime < cutoff || (prev !== undefined && mtime <= prev)) continue;
      const rel = p.slice(workspace.length + 1);
      const name = basename(p);
      if (text.includes(rel) || (name.length > 4 && text.includes(name))) found.add(p);
    }
  }
  const uploads = uploadsDir(workspace) + "/";
  const out: Attachment[] = [];
  for (const p of found) {
    if (p.startsWith(uploads)) continue;
    try { out.push({ path: p, name: basename(p), size: statSync(p).size, type: mimeFor(p) }); } catch { /* gone */ }
    if (out.length >= 24) break;
  }
  return out;
}

// ---- Tools & MCP registry (Tools & MCP → add / remove / hide) --------------
interface McpServer { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
interface ManualTool { name: string; command: string; description?: string }
interface ToolRegistry { tools: ManualTool[]; mcpServers: Record<string, McpServer>; hiddenTools: string[]; hiddenMcp: string[] }
const REGISTRY_PATH = join(HARNESS_HOME, "tools.json");
const MCP_CONFIG_PATH = join(HARNESS_HOME, "mcp.json");
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODEX_BLOCK_START = "# >>> harness mcp servers (managed by DeepHarness — edit in Tools & MCP)";
const CODEX_BLOCK_END = "# <<< harness mcp servers";

function loadRegistry(): ToolRegistry {
  const empty: ToolRegistry = { tools: [], mcpServers: {}, hiddenTools: [], hiddenMcp: [] };
  if (!existsSync(REGISTRY_PATH)) return empty;
  try { return { ...empty, ...(JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Partial<ToolRegistry>) }; } catch { return empty; }
}
/** Registry may hold MCP secrets (env), so every file it writes is owner-only. */
function saveRegistry(r: ToolRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(REGISTRY_PATH, 0o600);
  syncMcpConfigs(r);
}
function mcpConfigPath(): string | undefined {
  return Object.keys(loadRegistry().mcpServers).length && existsSync(MCP_CONFIG_PATH) ? MCP_CONFIG_PATH : undefined;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Claude reads mcp.json via --mcp-config; Codex gets a managed block in each profile's config.toml. */
function syncMcpConfigs(r: ToolRegistry): void {
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: r.mcpServers }, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(MCP_CONFIG_PATH, 0o600);
  const profilesDir = join(HARNESS_HOME, "profiles");
  let profiles: string[] = [];
  try { profiles = readdirSync(profilesDir); } catch { return; }
  const blockRe = new RegExp(`\\n?${escapeRe(CODEX_BLOCK_START)}[\\s\\S]*?${escapeRe(CODEX_BLOCK_END)}\\n?`);
  for (const p of profiles) {
    const codexHome = join(profilesDir, p, "codex");
    if (!existsSync(codexHome)) continue;
    const cfg = join(codexHome, "config.toml");
    const current = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
    const outside = current.replace(blockRe, "\n");
    // never redefine a server the profile already declares itself (duplicate TOML tables break codex)
    const taken = new Set([...outside.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)[\].]/gm)].map((m) => m[1]));
    const lines: string[] = [];
    for (const [name, s] of Object.entries(r.mcpServers)) {
      if (taken.has(name) || !MCP_NAME_RE.test(name)) continue;
      if (s.command) {
        lines.push(`[mcp_servers.${name}]`, `command = ${JSON.stringify(s.command)}`, `args = ${JSON.stringify(s.args ?? [])}`);
        const env = Object.entries(s.env ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (env.length) lines.push(`[mcp_servers.${name}.env]`, ...env.map(([k, v]) => `${k} = ${JSON.stringify(v)}`));
      } else if (s.url && s.type !== "sse") {
        lines.push(`[mcp_servers.${name}]`, `url = ${JSON.stringify(s.url)}`);
      } else continue;
      lines.push("");
    }
    if (!lines.length && !current.includes(CODEX_BLOCK_START)) continue;
    const block = lines.length ? `${CODEX_BLOCK_START}\n${lines.join("\n")}${CODEX_BLOCK_END}\n` : "";
    const base = outside.trimEnd();
    const next = base ? `${base}\n${block ? `\n${block}` : ""}` : block;
    if (next !== current) {
      writeFileSync(cfg, next, { encoding: "utf8", mode: 0o600 });
      chmodSync(cfg, 0o600);
    }
  }
}

/** Manual CLI tools are described to models so they can use them when shell access allows. */
function toolsHint(): string[] {
  const tools = loadRegistry().tools;
  if (!tools.length) return [];
  return [`CLI tools registered with this harness (usable when your environment allows shell commands):\n${tools.map((t) => `- ${t.name}: ${t.description || "no description"} — run as \`${t.command}\``).join("\n")}`];
}
function resolveCommand(command: string): string | null {
  const bin = command.trim().split(/\s+/)[0] ?? "";
  if (!bin) return null;
  if (bin.includes("/")) {
    const abs = bin.startsWith("~/") ? join(homedir(), bin.slice(2)) : resolve(bin);
    return existsSync(abs) ? abs : null;
  }
  return Bun.which(bin);
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".json": "application/json",
  ".css": "text/css", ".woff2": "font/woff2", ".js": "text/javascript",
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" },
});

function isLocalHost(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

Bun.serve({
  port: PORT,
  // Keep the dashboard local unless a developer explicitly overrides it.
  hostname: process.env.HARNESS_WEB_HOST || "127.0.0.1",
  idleTimeout: 255, // SSE streams idle while a CLI adapter waits; Bun default is 10s
  async fetch(req, server) {
    const url = new URL(req.url);

    if (!isLocalHost(url.host)) return json({ error: "local requests only" }, 403);
    if (url.pathname.startsWith("/api/")) {
      const origin = req.headers.get("origin");
      if ((origin && origin !== url.origin) || req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "cross-site request blocked" }, 403);
      if (url.pathname === "/api/health") return json({ ok: true, name: "agentic.harness", version: "0.1.0", activeTurns: activeTurns.size });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = join(WEB_ROOT,"index.html");
      return new Response(readFileSync(page, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const profile = url.searchParams.get("profile") ?? activeProfileName();

    if (url.pathname.startsWith("/api/") && !PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);

    if (url.pathname.startsWith("/assets/")) {
      const rel = url.pathname.slice("/assets/".length);
      if (rel.includes("..")) return json({ error: "bad path" }, 400);
      const file = join(WEB_ROOT,"assets", rel);
      if (!existsSync(file)) return json({ error: "not found" }, 404);
      return new Response(readFileSync(file), {
        headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
      });
    }

    if (url.pathname === "/brand.css") {
      return new Response(readFileSync(join(WEB_ROOT,"brand.css"), "utf8"), {
        headers: { "content-type": "text/css", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/meta") {
      const modelsMeta = JSON.parse(readFileSync(join(WEB_ROOT,"models-meta.json"), "utf8"));
      const verbs = JSON.parse(readFileSync(join(WEB_ROOT,"verbs.json"), "utf8"));
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

    if (url.pathname.startsWith("/api/auth/")) {
      if (!/^[a-z0-9_-]+$/i.test(profile)) return json({ error: "bad profile" }, 400);
      if (url.pathname === "/api/auth/status") {
        const [claude, chatgpt] = await Promise.all([authStatus("claude", profile), authStatus("chatgpt", profile)]);
        return json({ profile, claude, chatgpt });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { provider?: string };
        if (body.provider !== "claude" && body.provider !== "chatgpt") return json({ error: "provider must be claude or chatgpt" }, 400);
        const run = await startLogin(body.provider, profile);
        return json({ started: true, url: run.url, done: run.done, output: run.url ? "" : run.output.trim().slice(-300) });
      }
      if (url.pathname === "/api/auth/code" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { code?: string };
        const code = (body.code ?? "").trim();
        if (!code || code.length > 4096 || /[\r\n]/.test(code)) return json({ error: "paste the code shown on the sign-in page" }, 400);
        const run = loginRuns.get(`${profile}:claude`);
        if (!run || run.done || !run.child.stdin?.writable) return json({ error: "no sign-in is waiting — click Log in with Claude again" }, 409);
        const before = run.output.length;
        run.child.stdin.write(code + "\n");
        // Surface the CLI's reply (e.g. "Invalid code") instead of polling blind.
        for (let i = 0; i < 40 && run.output.length === before && !run.done; i++) await Bun.sleep(100);
        const reply = run.output.slice(before).replace(/Paste code here if prompted >/g, "").trim().slice(0, 200);
        if (/invalid|error|fail/i.test(reply)) return json({ error: reply }, 422);
        return json({ ok: true, message: reply });
      }
      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/api/soul") {
      const path = join(HARNESS_HOME, "soul.md");
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        if (typeof body.text !== "string") return json({ error: "text required" }, 400);
        if (body.text.length > 100_000) return json({ error: "soul.md is capped at 100k characters" }, 413);
        writeFileSync(path, body.text, "utf8");
        return json({ text: body.text, path });
      }
      return json({ text: existsSync(path) ? readFileSync(path, "utf8") : "", path });
    }

    if (url.pathname === "/api/skills") {
      return json({ skills: await scanSkills({ cwd: process.cwd(), harnessHome: HARNESS_HOME }) });
    }
    if (url.pathname === "/api/self" || url.pathname.startsWith("/api/self/")) {
      if (!PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
      if (url.pathname === "/api/self" && req.method === "PUT") {
        const body = (await req.json().catch(() => ({}))) as { sourceRoot?: string };
        const raw = String(body.sourceRoot ?? "").trim();
        const abs = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
        if (!raw || findSourceRoot(abs) !== abs) return json({ error: "that folder is not the agentic.harness source root" }, 400);
        const s = loadSettings();
        s.selfSourceRoot = abs;
        saveSettings(s);
      }
      if (url.pathname === "/api/self") {
        const root = sourceRoot();
        return json({
          sourceRoot: root,
          git: !!root && existsSync(join(root, ".git")),
          selfEvolve: !!loadSettings().selfEvolve,
          access: agentRequest(homedir()).access,
          client: HARNESS_CLIENT,
          evolution: root ? evolutionStatus(root) : null,
        });
      }
      if (url.pathname === "/api/self/sync" && req.method === "POST") {
        const root = sourceRoot();
        if (!root) return json({ error: "No source folder configured" }, 400);
        return json({ evolution: await syncEvolution(root) });
      }
      const q = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
      const sid = String(q.session ?? "");
      const before = String(q.before ?? "");
      const after = String(q.after ?? "");
      if (!/^[a-z0-9-]+$/i.test(sid) || !/^[0-9a-f]{40,64}$/.test(before) || !/^[0-9a-f]{40,64}$/.test(after)) {
        return json({ error: "bad request" }, 400);
      }
      const change = findSelfChange(profile, sid, before, after);
      if (!change) return json({ error: "no such self-change in that session" }, 404);
      if (url.pathname === "/api/self/diff") {
        const diff = git(change.root, ["diff", "--no-color", "--no-ext-diff", "--no-renames", before, after]).out;
        return new Response(diff.slice(0, 400_000) || "(no textual changes)", {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": "sandbox" },
        });
      }
      if (url.pathname === "/api/self/revert" && req.method === "POST") {
        if (change.root !== sourceRoot()) return json({ error: "This checkpoint belongs to a different source folder" }, 409);
        if (loadSettings().agentAccess === "read-only") return json({ error: "Agent file access is read-only" }, 403);
        try {
          const result = revertEvolution(change, { profile, sessionId: sid });
          new SessionStore(profile, sid).append({ v: 1, ts: new Date().toISOString(), kind: "self-revert", before, after, ...result });
          if (result.checkpoint) acknowledgeEvolution(change.root, result.checkpoint.afterCommit);
          syncSelfChanges(change.root);
          return json({ ...result, evolution: evolutionStatus(change.root) });
        } catch (err) {
          return json({ error: (err as Error).message }, 409);
        }
      }
      return json({ error: "not found" }, 404);
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      if (!PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
      if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD) return json({ error: "files are capped at 25 MB" }, 413);
      const safe = basename(url.searchParams.get("name") ?? "file").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || "file";
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > MAX_UPLOAD) return json({ error: "files are capped at 25 MB" }, 413);
      const dir = uploadsDir(activeWorkspace(profile));
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      let path = join(dir, `${stamp}-${safe}`);
      for (let n = 2; existsSync(path); n++) path = join(dir, `${stamp}-${n}-${safe}`);
      writeFileSync(path, bytes);
      return json({ path, name: safe, size: bytes.byteLength, type: mimeFor(path) });
    }

    // Open a chat file with its default app, or reveal it in Finder — on this Mac only.
    if (url.pathname === "/api/artifact/open" && req.method === "POST") {
      const ip = server.requestIP(req)?.address ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return json({ error: "only available on the Mac running the harness" }, 403);
      if (!PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
      const body = (await req.json().catch(() => ({}))) as { session?: string; path?: string; reveal?: boolean };
      const sid = String(body.session ?? "");
      const path = String(body.path ?? "");
      if (!/^[a-z0-9-]+$/i.test(sid) || !recordedFile(profile, sid, path)) return json({ error: "file not available" }, 404);
      Bun.spawn(["/usr/bin/open", ...(body.reveal ? ["-R"] : []), path], { stdout: "ignore", stderr: "ignore" });
      return json({ ok: true });
    }

    // Downloads are limited to files a session recorded as an attachment or output.
    if (url.pathname === "/api/artifact") {
      if (!PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
      const sid = url.searchParams.get("session") ?? "";
      const path = url.searchParams.get("path") ?? "";
      if (!/^[a-z0-9-]+$/i.test(sid) || !path) return json({ error: "bad request" }, 400);
      const log = join(HARNESS_HOME, "profiles", profile, "sessions", `${sid}.jsonl`);
      if (!existsSync(log)) return json({ error: "session not found" }, 404);
      const listed = readFileSync(log, "utf8").split("\n").some((line) => {
        if (!line.includes('"artifact"')) return false;
        try {
          const e = JSON.parse(line) as { kind?: string; path?: string; note?: string };
          return e.kind === "artifact" && e.path === path && (e.note === "output" || e.note === "attachment");
        } catch { return false; }
      });
      if (!listed || !existsSync(path) || !statSync(path).isFile()) return json({ error: "file not available" }, 404);
      const type = mimeFor(path);
      const previewable = /^(image|video|audio|text)\//.test(type) || type === "application/pdf" || type === "application/json";
      const inline = url.searchParams.get("inline") === "1" && previewable;
      const headers: Record<string, string> = {
        "content-type": type,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      // agent-made files never run script on the harness origin
      if (type !== "application/pdf") headers["content-security-policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
      return new Response(Bun.file(path), { headers });
    }

    if (url.pathname === "/api/tools" || url.pathname.startsWith("/api/tools/")) {
      if (!PROFILE_RE.test(profile)) return json({ error: "bad profile" }, 400);
      const reg = loadRegistry();
      if (url.pathname === "/api/tools" && req.method === "GET") {
        const [scanned, found] = await Promise.all([scanTools(), scanSkills({ cwd: activeWorkspace(profile), harnessHome: HARNESS_HOME })]);
        return json({
          tools: scanned.map((t) => ({ ...t, hidden: reg.hiddenTools.includes(t.name) })),
          manualTools: reg.tools.map((t) => { const path = resolveCommand(t.command); return { ...t, path, available: !!path }; }),
          // env values never leave the server — the UI only sees key names
          harnessMcp: Object.entries(reg.mcpServers).map(([name, s]) => ({
            name, type: s.type ?? (s.url ? "http" : "stdio"), command: s.command, args: s.args ?? [], url: s.url, envKeys: Object.keys(s.env ?? {}),
          })),
          discoveredMcp: found.filter((s) => s.type === "mcp").map((s) => ({
            name: s.name, source: s.source, importable: s.source.endsWith(".json"), inHarness: s.name in reg.mcpServers, hidden: reg.hiddenMcp.includes(s.name),
          })),
          mcpConfig: mcpConfigPath() ?? null,
        });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const nameParam = url.searchParams.get("name") ?? "";
      if (url.pathname === "/api/tools/tool" && req.method === "POST") {
        const name = String(body.name ?? "").trim();
        const command = String(body.command ?? "").trim();
        if (!/^[\w.-]{1,64}$/.test(name)) return json({ error: "name: letters, digits, dot, dash or underscore" }, 400);
        if (!command || command.length > 500) return json({ error: "command required" }, 400);
        reg.tools = reg.tools.filter((t) => t.name !== name).concat({ name, command, description: String(body.description ?? "").trim().slice(0, 300) || undefined });
        saveRegistry(reg);
        return json({ ok: true });
      }
      if (url.pathname === "/api/tools/tool" && req.method === "DELETE") {
        reg.tools = reg.tools.filter((t) => t.name !== nameParam);
        saveRegistry(reg);
        return json({ ok: true });
      }
      if (url.pathname === "/api/tools/mcp" && req.method === "POST") {
        const name = String(body.name ?? "").trim();
        if (!MCP_NAME_RE.test(name)) return json({ error: "name: letters, digits, dash or underscore only" }, 400);
        const server: McpServer = { type: body.type === "http" ? "http" : "stdio" };
        if (server.type === "stdio") {
          const command = String(body.command ?? "").trim();
          if (!command) return json({ error: "command required" }, 400);
          server.command = command;
          server.args = (Array.isArray(body.args) ? body.args : []).map(String).filter(Boolean).slice(0, 50);
        } else {
          const target = String(body.url ?? "").trim();
          if (!/^https?:\/\//.test(target)) return json({ error: "url must start with http:// or https://" }, 400);
          server.url = target;
        }
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries((body.env && typeof body.env === "object" ? body.env : {}) as Record<string, unknown>)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return json({ error: `bad env key: ${k}` }, 400);
          env[k] = String(v);
        }
        if (Object.keys(env).length) server.env = env;
        reg.mcpServers[name] = server;
        saveRegistry(reg);
        return json({ ok: true });
      }
      if (url.pathname === "/api/tools/mcp/import" && req.method === "POST") {
        const name = String(body.name ?? "");
        const source = String(body.source ?? "");
        const allowed = [join(homedir(), ".claude.json"), join(activeWorkspace(profile), ".mcp.json")];
        if (!MCP_NAME_RE.test(name) || !allowed.includes(source) || !existsSync(source)) {
          return json({ error: "can only import from ~/.claude.json or the working folder's .mcp.json" }, 400);
        }
        const cfg = (JSON.parse(readFileSync(source, "utf8")) as { mcpServers?: Record<string, McpServer> }).mcpServers?.[name];
        if (!cfg) return json({ error: `${name} not found in ${source}` }, 404);
        reg.mcpServers[name] = { type: cfg.type, command: cfg.command, args: cfg.args, env: cfg.env, url: cfg.url, headers: cfg.headers };
        saveRegistry(reg);
        return json({ ok: true });
      }
      if (url.pathname === "/api/tools/mcp" && req.method === "DELETE") {
        delete reg.mcpServers[nameParam];
        saveRegistry(reg);
        return json({ ok: true });
      }
      if (url.pathname === "/api/tools/hide" && req.method === "POST") {
        const name = String(body.name ?? "");
        const key = body.kind === "mcp" ? "hiddenMcp" : "hiddenTools";
        reg[key] = reg[key].filter((n) => n !== name).concat(body.hidden === false || !name ? [] : [name]);
        saveRegistry(reg);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }
    if (url.pathname === "/api/routines/run" && req.method === "POST") {
      if (!/^[a-z0-9_-]+$/i.test(profile)) return json({ error: "bad profile" }, 400);
      const r = loadRoutines().find((x) => x.id === url.searchParams.get("id"));
      if (!r) return json({ error: "routine not found" }, 404);
      if (routineRuns.has(r.id)) return json({ error: "already running" }, 409);
      return json({ started: true, sessionId: runRoutine(r, profile) });
    }
    if (url.pathname === "/api/routines") {
      if (req.method === "POST") {
        const r = normalizeRoutine((await req.json().catch(() => ({}))) as Partial<Routine>);
        if (typeof r === "string") return json({ error: r }, 400);
        const rs = loadRoutines();
        rs.push(r);
        saveRoutines(rs);
        return json(r);
      }
      if (req.method === "PUT" || req.method === "DELETE") {
        const rs = loadRoutines();
        const idx = rs.findIndex((x) => x.id === url.searchParams.get("id"));
        if (idx < 0) return json({ error: "routine not found" }, 404);
        if (req.method === "DELETE") {
          rs.splice(idx, 1);
          saveRoutines(rs);
          return json({ ok: true });
        }
        const r = normalizeRoutine((await req.json().catch(() => ({}))) as Partial<Routine>, rs[idx]);
        if (typeof r === "string") return json({ error: r }, 400);
        rs[idx] = r;
        saveRoutines(rs);
        return json(r);
      }
      return json({
        routines: loadRoutines().map((r) => {
          const run = routineRuns.get(r.id);
          const next = nextRunAt(r);
          return { ...r, running: !!run, runningStep: run?.step, nextRun: next ? new Date(next).toISOString() : undefined };
        }),
      });
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
      const body = (await req.json().catch(() => ({}))) as { task?: string; model?: string; sessionId?: string; escalate?: boolean; orchestrator?: boolean; noFallback?: boolean; tools?: boolean; attachments?: unknown };
      const task = (body.task ?? "").trim();
      if (!task) return json({ error: "task required" }, 400);
      const requestedSessionId = body.sessionId === undefined ? undefined : String(body.sessionId);
      if (requestedSessionId !== undefined && !isSessionId(requestedSessionId)) return json({ error: "bad session id" }, 400);
      if (requestedSessionId && !existsSync(sessionPath(profile, requestedSessionId))) return json({ error: "session not found" }, 404);
      const session = new SessionStore(profile, requestedSessionId);
      const turnKey = `${profile}:${session.sessionId}`;
      if (activeTurns.has(turnKey)) return json({ error: "a turn is already running for this session" }, 409);
      const attachments = validAttachments(body.attachments, activeWorkspace(profile));
      const attached = attachmentPrompt(attachments);
      const turnAbort = new AbortController();
      activeTurns.set(turnKey, turnAbort);
      const abortOnDisconnect = () => turnAbort.abort();
      req.signal.addEventListener("abort", abortOnDisconnect, { once: true });
      try {
        if (session.all().length === 0) session.append({ v: 1, ts: new Date().toISOString(), kind: "session-start", sessionId: session.sessionId, profile, cwd: activeWorkspace(profile) });
        session.append({ v: 1, ts: new Date().toISOString(), kind: "user-message", text: task + attached.forHistory });
        session.append({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: activeWorkspace(profile), note: "workspace" });
        for (const a of attachments) session.append({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: a.path, note: "attachment" });
      } catch (err) {
        activeTurns.delete(turnKey);
        req.signal.removeEventListener("abort", abortOnDisconnect);
        return json({ error: `could not persist session: ${(err as Error).message}` }, 500);
      }
      const history = session.messages().slice(0, -1);
      const workspace = activeWorkspace(profile);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let closed = false;
          const send = (obj: unknown) => {
            if (!closed && !turnAbort.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };
          // The session is durable before fleet setup; expose it even if setup fails.
          send({ t: "accepted", session: session.sessionId });
          // CLI agents can work silently for minutes; comment pings keep Bun from dropping the stream.
          const ping = setInterval(() => {
            try { if (!turnAbort.signal.aborted) controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* client went away */ }
          }, 15_000);
          let turnStart = 0;
          let before = new Map<string, number>();
          let prepared = false;
          const toolPaths: string[] = [];
          const emitArtifacts = (text: string) => {
            if (!prepared) return;
            for (const a of detectArtifacts(workspace, before, turnStart, text, toolPaths)) {
              session.append({ v: 1, ts: new Date().toISOString(), kind: "artifact", path: a.path, note: "output" });
              send({ t: "artifact", ...a });
            }
          };
          let selfWatch: ReturnType<typeof beginSelfWatch> = null;
          const emitSelfChange = () => {
            const watch = selfWatch;
            const change = watch?.finish();
            selfWatch = null;
            if (watch) syncSelfChanges(watch.root);
            if (!change) return;
            session.append({ v: 1, ts: new Date().toISOString(), kind: "self-change", ...change });
            acknowledgeEvolution(change.root, change.afterCommit);
            send({ t: "self-change", ...change });
          };
          try {
            const ctx = await buildWebContext(profile, session);
            if (turnAbort.signal.aborted) throw new Error("turn cancelled");
            const settings = loadSettings();
            const orchestratorJob = body.orchestrator === true;
            const pool = routedModels(ctx.models, settings, orchestratorJob);
            if (body.model && ORCHESTRATOR_ONLY_MODELS.has(body.model) && !(settings.astraAvailable && orchestratorJob)) {
              throw new Error("orchestrator-only model is gated off (enable in Settings, and mark the job as an orchestration)");
            }
            const effectivePin = body.model || (settings.startModel && pool.some((m) => m.id === settings.startModel) ? settings.startModel : undefined);
            const useTools = typeof body.tools === "boolean" ? body.tools : attachments.length > 0 || needsTools(task, session);
            const decision0 = route({ task, models: pool, health: ctx.health, delegation: ctx.delegation, pinnedModel: effectivePin, escalate: body.escalate, requiresTools: useTools });
            const target = pool.find((m) => m.id === decision0.selected);
            const request = { ...agentRequest(workspace, task), tools: useTools };
            if (turnAbort.signal.aborted) throw new Error("turn cancelled");
            const messages = target
              ? compileContext(task + attached.forModel, target, { cwd: request.cwd, history, skillInstructions: toolsHint(), self: selfKnowledge(profile, request.cwd) })
              : [{ role: "user" as const, content: task + attached.forModel }];
            if (turnAbort.signal.aborted) throw new Error("turn cancelled");
            turnStart = Date.now();
            before = snapshotFiles(workspace);
            selfWatch = beginSelfWatch(profile, session.sessionId);
            prepared = true;
            send({ t: "route", decision: decision0, session: session.sessionId });
            const routedCtx: OrchestratorContext = { ...ctx, models: pool };
            const result = await askRouted(routedCtx, task, messages, {
              request: { ...request, signal: turnAbort.signal },
              requiresTools: useTools,
              pinnedModel: effectivePin,
              escalate: body.escalate,
              noFallback: body.noFallback,
              onEvent: (e) => {
                if (e.type === "text-delta") send({ t: "delta", text: e.text });
                else if (e.type === "reasoning-delta" && !settings.reasoningOff) send({ t: "thinking", text: e.text });
                else if (e.type === "usage") send({ t: "usage", usage: e.usage });
                else if (e.type === "tool-call") {
                  toolPaths.push(...toolCallPaths(e.arguments));
                  send({ t: "tool", id: e.id, name: e.name });
                }
                else if (e.type === "tool-result") send({ t: "tool-result", id: e.id, name: e.name, isError: e.isError === true });
              },
            });
            for (const fb of result.fellBack) send({ t: "fallback", ...fb });
            if (pool.find(model => model.id === result.modelUsed)?.capabilities.tools) emitArtifacts(result.text);
            emitSelfChange();
            if (result.outcome === "completed") send({ t: "done", model: result.modelUsed, text: result.text, usage: result.usage });
            else if (result.outcome === "interrupted") send({ t: "interrupted", model: result.modelUsed, text: result.text, error: result.error, usage: result.usage });
            else send({ t: "error", message: result.error ?? "route failed", model: result.modelUsed });
          } catch (err) {
            try { emitArtifacts(""); } catch { /* best effort: files made before a failure still count */ }
            try { emitSelfChange(); } catch { /* best effort: self-changes before a failure stay reviewable */ }
            if (turnAbort.signal.aborted) session.append({ v: 1, ts: new Date().toISOString(), kind: "session-end", reason: "cancelled" });
            else send({ t: "error", message: (err as Error).message });
          } finally {
            selfWatch?.release();
            clearInterval(ping);
            activeTurns.delete(turnKey);
            req.signal.removeEventListener("abort", abortOnDisconnect);
            closed = true;
            try { controller.close(); } catch { /* stream cancelled by client */ }
          }
        },
        cancel() { turnAbort.abort(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    if (url.pathname === "/api/turn/cancel" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
      const sessionId = String(body.sessionId ?? "");
      if (!isSessionId(sessionId)) return json({ error: "bad session id" }, 400);
      const turn = activeTurns.get(`${profile}:${sessionId}`);
      if (!turn) return json({ error: "no active turn" }, 404);
      turn.abort();
      return json({ ok: true, sessionId });
    }

    if (url.pathname === "/api/sessions") return json({ sessions: listSessions(profile) });
    if (url.pathname === "/api/session" && req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[a-z0-9-]+$/i.test(id)) return json({ error: "bad id" }, 400);
      if (activeTurns.has(`${profile}:${id}`)) return json({ error: "stop this turn before deleting its session" }, 409);
      const { rmSync } = await import("node:fs");
      try { rmSync(join(HARNESS_HOME, "profiles", profile, "sessions", id + ".jsonl")); return json({ ok: true }); }
      catch { return json({ error: "not found" }, 404); }
    }
    if (url.pathname === "/api/session") {
      const id = url.searchParams.get("id") ?? "";
      if (!isSessionId(id)) return json({ error: "bad id" }, 400);
      if (!existsSync(sessionPath(profile, id))) return json({ error: "session not found" }, 404);
      const store = new SessionStore(profile, id);
      return json({ events: store.all() });
    }
    if (url.pathname === "/api/usage") return json({ usage: await usageSummary(profile) });

    return json({ error: "not found" }, 404);
  },
});

console.log(`Agentic Harness web → http://localhost:${PORT} (profile: ${activeProfileName()})`);
