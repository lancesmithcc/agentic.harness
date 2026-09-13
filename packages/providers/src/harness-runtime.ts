/** Shared boundary for the pinned official DeepSeek Harness SDK runtime. */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getHarnessHome } from "@harness/core";
import type { HarnessEvent, HarnessRequest, ModelCapabilities } from "@harness/core";
import { harnessError } from "./claude-code.ts";

export const DSH_VERSION = "0.1.5-rc.2";
export type HarnessApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface RuntimeRoute {
  /** SDK provider route. `deepseek-official` uses the SDK's built-in route. */
  provider: string;
  model: string;
  baseUrl?: string;
  /** Never serialized: passed only as AGENTIC_PROVIDER_API_KEY to the child. */
  apiKey?: string | null;
  headers?: Record<string, string>;
  capabilities?: ModelCapabilities;
  billing?: string;
  api?: HarnessApi;
}
export interface RuntimeHealth { ok: boolean; detail: string }

const nodePath = () => process.env.HARNESS_NODE_PATH || (existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : "node");
const bridgePath = () => process.env.HARNESS_DSH_BRIDGE || fileURLToPath(new URL("../runtime/deepseek-bridge.mjs", import.meta.url));
const cleanChildEnv = (apiKey?: string | null): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) if (process.env[key]) env[key] = process.env[key];
  // Local OpenAI-compatible servers still need a credential shape in pi-ai.
  if (apiKey) env.AGENTIC_PROVIDER_API_KEY = apiKey;
  return env;
};

export async function runtimeHealth(route: RuntimeRoute): Promise<RuntimeHealth> {
  if (!route.apiKey && route.billing !== "local") return { ok: false, detail: `${route.provider} API key required` };
  if (!existsSync(bridgePath())) return { ok: false, detail: "SDK bridge missing; rebuild the desktop app" };
  return new Promise(resolve => execFile(nodePath(), ["--version"], { timeout: 2500 }, (error, stdout) => {
    const [major = 0, minor = 0] = stdout.trim().replace(/^v/, "").split(".").map(Number);
    const ok = !error && (major >= 24 || (major === 22 && minor >= 19));
    resolve({ ok, detail: ok ? `official SDK ${DSH_VERSION} · files, shell, plugins` : "Node 22.19 or 24+ required" });
  }));
}

/**
 * Run a route through DSH's native agent loop. The route credential is sent via
 * the child's narrowly-scoped environment and never through stdin, argv, or a
 * Cordis patch. Callers select this only for a tool-enabled request.
 */
export async function* generateHarness(request: HarnessRequest, options: { profile: string; route: RuntimeRoute }): AsyncIterable<HarnessEvent> {
  const { profile, route } = options;
  if (request.signal?.aborted) { yield { type: "error", error: harnessError("aborted", "request cancelled"), fatal: true }; return; }
  const cwd = resolve(request.cwd ?? process.cwd());
  const needsExtraScope = request.addDirs?.some(dir => { const rel = relative(cwd, resolve(dir)); return rel === ".." || rel.startsWith("../") || isAbsolute(rel); });
  if (request.access !== "full" && needsExtraScope) {
    yield { type: "error", error: harnessError("provider-error", "DeepSeek Harness SDK does not support additional workspace directories"), fatal: true }; return;
  }
  const env = cleanChildEnv(route.apiKey ?? (route.billing === "local" ? "local-placeholder" : undefined));
  const child = spawn(nodePath(), [bridgePath()], { env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  void exited.catch(() => {});
  let stderr = "", aborted = false, timedOut = false, done: Extract<HarnessEvent, { type: "done" }> | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); force ??= setTimeout(() => child.kill("SIGKILL"), 12_000); } };
  const abort = () => { aborted = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs ?? 20 * 60_000);
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) abort();
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1200); });
  child.stdin.on("error", () => {});
  // apiKey intentionally absent. The bridge receives only public route settings.
  child.stdin.end(JSON.stringify({
    messages: request.messages, cwd, access: request.access ?? "read-only",
    addDirs: request.addDirs, mcpConfig: request.mcpConfig, maxTokens: request.maxTokens,
    home: join(getHarnessHome(), "profiles", profile, "harness-runtime"),
    route: { provider: route.provider, model: route.model, baseUrl: route.baseUrl, headers: route.headers, billing: route.billing ?? "api", api: route.api ?? "openai-completions", contextWindow: route.capabilities?.context, maxTokens: request.maxTokens },
  }));
  const started = Date.now(); let pending = ""; const decoder = new TextDecoder();
  const parse = (line: string): HarnessEvent | null => {
    if (!line.trim()) return null;
    const event = JSON.parse(line) as HarnessEvent & { message?: string };
    if (event.type === "error") throw new Error(String(event.message));
    if (event.type === "done") { done = event; return null; }
    if (["text-delta", "reasoning-delta", "tool-call", "tool-result", "usage"].includes(event.type)) return event;
    throw new Error("invalid SDK bridge event");
  };
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) { const event = parse(line); if (event) yield event; }
    }
    const last = parse(pending + decoder.decode()); if (last) yield last;
    const code = await exited;
    if (aborted || timedOut) throw new Error(aborted ? "request cancelled" : "DeepSeek Harness timed out");
    if (code !== 0 || !done) throw new Error(`DeepSeek Harness did not complete${stderr ? `: ${stderr}` : ""}`);
    yield { type: "model-call", provider: route.provider, model: route.model, latencyMs: Date.now() - started };
    yield done;
  } catch (error) {
    yield { type: "error", error: harnessError(aborted ? "aborted" : "provider-error", (error as Error).message, { provider: route.provider, model: route.model }), fatal: true };
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener("abort", abort); stop(); await exited.catch(() => {}); if (force) clearTimeout(force);
  }
}
