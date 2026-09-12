/** The official DeepSeek Harness SDK runtime, distinct from text-only API chat. */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getHarnessHome } from "@harness/core";
import type { HarnessEvent, HarnessRequest, Model, ModelCapabilities, ModelProvider, ProviderHealth } from "@harness/core";
import { harnessError } from "./claude-code.ts";

export const DSH_VERSION = "0.1.5-rc.2";
const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
const nodePath = () => process.env.HARNESS_NODE_PATH || (existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : "node");
const bridgePath = () => process.env.HARNESS_DSH_BRIDGE || fileURLToPath(new URL("../runtime/deepseek-bridge.mjs", import.meta.url));

export class DeepSeekHarnessProvider implements ModelProvider {
  readonly id = "deepseek-harness";
  readonly kind = "api" as const;
  constructor(private profile: string, private apiKey?: string | null) {}
  capabilities(model: string): ModelCapabilities {
    return { coding: 9, reasoning: model.endsWith("pro") ? 9 : 8, tools: true, context: 128000, billing: "api", thinking: true };
  }
  async models(): Promise<Model[]> {
    return models.map(model => ({ id: `${this.id}/${model}`, model, provider: this.id, name: `DeepSeek Harness · ${model.endsWith("pro") ? "Pro" : "Flash"}`, capabilities: this.capabilities(model) }));
  }
  async health(): Promise<ProviderHealth> {
    const result = (ok: boolean, detail: string): ProviderHealth => ({ provider: this.id, ok, detail, checkedAt: new Date().toISOString() });
    if (!this.apiKey && !process.env.DEEPSEEK_API_KEY) return result(false, "DeepSeek API key required");
    if (!existsSync(bridgePath())) return result(false, "SDK bridge missing; rebuild the desktop app");
    return new Promise(resolve => execFile(nodePath(), ["--version"], { timeout: 2500 }, (error, stdout) => {
      const [major = 0, minor = 0] = stdout.trim().replace(/^v/, "").split(".").map(Number);
      const ok = !error && (major >= 24 || (major === 22 && minor >= 19));
      resolve(result(ok, ok ? `official SDK ${DSH_VERSION} · files, shell, plugins` : "Node 22.19 or 24+ required"));
    }));
  }
  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const model = request.model.split("/").at(-1)!;
    if (request.signal?.aborted) {
      yield { type: "error", error: harnessError("aborted", "request cancelled"), fatal: true }; return;
    }
    // MCP configuration is translated into a per-launch Cordis patch by the
    // Node bridge. The SDK itself only carries the patch path at launch.
    const cwd = resolve(request.cwd ?? process.cwd());
    const needsExtraScope = request.addDirs?.some(dir => {
      const rel = relative(cwd, resolve(dir));
      return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
    });
    if (request.access !== "full" && needsExtraScope) {
      yield { type: "error", error: harnessError("provider-error", "DeepSeek Harness SDK does not support additional workspace directories"), fatal: true }; return;
    }
    if (!models.includes(model)) {
      yield { type: "error", error: harnessError("unavailable", `unsupported DeepSeek Harness model: ${model}`), fatal: true }; return;
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) if (process.env[key]) env[key] = process.env[key];
    env.DEEPSEEK_API_KEY = this.apiKey ?? process.env.DEEPSEEK_API_KEY;
    const child = spawn(nodePath(), [bridgePath()], { env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    // Attach immediately: a failed spawn must not become an unhandled rejection.
    void exited.catch(() => {});
    let stderr = "", aborted = false, timedOut = false, done: Extract<HarnessEvent, { type: "done" }> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 12_000);
    };
    const abort = () => { aborted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs ?? 20 * 60_000);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1200); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ messages: request.messages, model, cwd: request.cwd ?? process.cwd(), access: request.access ?? "read-only", mcpConfig: request.mcpConfig, maxTokens: request.maxTokens, home: join(getHarnessHome(), "profiles", this.profile, "deepseek-runtime") }));
    const started = Date.now();
    let pending = "";
    const decoder = new TextDecoder();
    const parse = (line: string): HarnessEvent | null => {
      if (!line.trim()) return null;
      const e = JSON.parse(line);
      if (e.type === "error") throw new Error(String(e.message));
      if (e.type === "done") { done = e; return null; }
      if (["text-delta", "reasoning-delta", "tool-call", "usage"].includes(e.type)) return e;
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
      yield { type: "model-call", provider: this.id, model, latencyMs: Date.now() - started };
      yield done;
    } catch (error) {
      yield { type: "error", error: harnessError(aborted ? "aborted" : "provider-error", (error as Error).message, { provider: this.id, model }), fatal: true };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      stop();
      await exited.catch(() => {});
      if (force) clearTimeout(force);
    }
  }
}
