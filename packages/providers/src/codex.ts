/**
 * Codex (ChatGPT subscription) adapter (PRD §7, §8).
 *
 * Invokes `codex exec --json`. Authentication is owned by the Codex CLI,
 * isolated per profile through CODEX_HOME:
 *   ~/.deepharness/profiles/<profile>/codex
 * Independent login per profile via `harness auth codex`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_HOME } from "@harness/core";
import type {
  ModelProvider,
  Model,
  ModelCapabilities,
  ProviderHealth,
  HarnessRequest,
  HarnessEvent,
  UsageReport,
  HarnessError,
} from "@harness/core";
import { harnessError } from "./claude-code.ts";

const SEED_CAPS: Record<string, ModelCapabilities> = {
  "gpt-5.5": { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 400000 },
  "gpt-5.5-codex": { coding: 10, reasoning: 9, tools: true, billing: "subscription", context: 400000 },
  "gpt-5.6-sol": { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 400000, thinking: true },
  "gpt-5.6-terra": { coding: 9, reasoning: 9, tools: true, vision: true, billing: "subscription", context: 400000 },
  "gpt-5.6-luna": { coding: 7, reasoning: 7, tools: true, billing: "subscription", context: 128000 },
  // Orchestrator-only; gated by settings, never a worker.
  "gpt-6-astra": { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 1000000, thinking: true, longContext: true },
  default: { coding: 10, reasoning: 10, tools: true, billing: "subscription", context: 400000 },
};

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly kind = "subscription-cli" as const;
  readonly codexHome: string;
  /** Sandbox policy passed to codex exec. Default keeps reads only. */
  sandbox: "read-only" | "workspace-write" | "danger-full-access" = "read-only";

  constructor(profile: string) {
    this.codexHome = join(HARNESS_HOME, "profiles", profile, "codex");
    if (!existsSync(this.codexHome)) mkdirSync(this.codexHome, { recursive: true });
  }

  async models(): Promise<Model[]> {
    return Object.entries(SEED_CAPS).map(([m, caps]) => ({
      id: `${this.id}/${m}`,
      model: m,
      provider: this.id,
      name: m === "default" ? "Codex (subscription default)" : m,
      capabilities: caps,
    }));
  }

  capabilities(model: string): ModelCapabilities {
    return SEED_CAPS[model] ?? SEED_CAPS["default"]!;
  }

  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const model = request.model.includes("/") ? request.model.split("/").slice(1).join("/") : request.model;
    if (request.signal?.aborted) {
      yield { type: "error", error: harnessError("aborted", "codex request cancelled before start", { provider: this.id, model }), fatal: true };
      return;
    }
    const prompt = request.messages
      .map((m) =>
        m.role === "system"
          ? `[System instructions]\n${m.content}`
          : `[${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant (earlier turn)" : "Tool result"}]\n${m.content}`,
      )
      .join("\n\n");

    // Autonomy follows the request; MCP servers come from the profile's
    // config.toml (the harness manages a block there from Tools & MCP).
    const sandbox = request.access === "full" ? "danger-full-access" : request.access === "workspace" ? "workspace-write" : this.sandbox;
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox];
    if (request.cwd && existsSync(request.cwd)) args.push("--cd", request.cwd);
    for (const dir of request.addDirs ?? []) if (existsSync(dir)) args.push("--add-dir", dir);
    if (model && model !== "default") args.push("-m", model);
    args.push(prompt);

    const child = spawn("codex", args, {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const started = Date.now();
    let full = "";
    let sawError = false;
    let sawDone = false;
    let cancelled = false;
    let exitCode: number | null = null;
    const stderr: string[] = [];
    // CLI subprocesses must never hang the fallback chain: hard ceiling.
    const killer = setTimeout(() => {
      cancelled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, request.timeoutMs ?? 90_000);
    child.on("exit", () => clearTimeout(killer));
    const onAbort = () => {
      cancelled = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // Some child CLIs ignore SIGTERM while waiting on a transport. Reap it.
      setTimeout(() => { if (child.exitCode === null) try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 1_000).unref();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("exit", (code) => { exitCode = code; });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 20) stderr.push(d.toString());
    });

    try {
      const decoder = new TextDecoder();
      let pending = "";
      const parseLine = (line: string): HarnessEvent[] => {
        if (!line.trim()) return [];
        let evt: Record<string, unknown>;
        try { evt = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
        const type = evt.type as string;
        if (type === "item.completed") {
          const item = evt.item as { id?: string; type?: string; text?: string; changes?: Array<{ path?: string; kind?: string }> } | undefined;
          if (item?.type === "agent_message" && item.text) { full += item.text; return [{ type: "text-delta", text: item.text }]; }
          if (item?.type === "file_change" && item.changes?.length) return [{ type: "tool-call", id: item.id ?? "file_change", name: "file_change", arguments: JSON.stringify({ changes: item.changes }) }];
        } else if (type === "turn.completed") {
          sawDone = true;
          const raw = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const usage: UsageReport | null = raw ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, totalTokens: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0), billing: "subscription" } : null;
          return [
            ...(usage ? [{ type: "usage" as const, usage }] : []),
            { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started },
            { type: "done", finishReason: "stop", text: full },
          ];
        } else if (type === "turn.failed" || type === "error") {
          sawError = true;
          const msg = String(evt.error ?? evt.message ?? "codex error");
          const code = /auth|login|401/i.test(msg) ? "auth" : /rate|429|quota/i.test(msg) ? "rate-limit" : "provider-error";
          return [{ type: "error", error: harnessError(code, msg, { provider: this.id, model }), fatal: code === "auth" }];
        }
        return [];
      };
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) for (const event of parseLine(line)) yield event;
      }
      pending += decoder.decode();
      for (const event of parseLine(pending)) yield event;
      await closed;
      if (cancelled) {
        yield { type: "error", error: harnessError("aborted", "codex request cancelled", { provider: this.id, model }), fatal: true };
      } else if (!sawError && (!sawDone || exitCode !== 0)) {
        const detail = stderr.join("").slice(0, 400);
        yield { type: "error", error: harnessError("provider-error", `codex exited ${exitCode ?? "before completion"}${detail ? `; stderr: ${detail}` : ""}`, { provider: this.id, model, retryable: true }), fatal: true };
      } else if (!sawError && !full) {
        const errText = stderr.join("").slice(0, 400);
        const code: HarnessError["code"] = /login|auth|not logged in/i.test(errText) ? "auth" : "provider-error";
        yield {
          type: "error",
          error: harnessError(code, `codex produced no output${errText ? `; stderr: ${errText}` : ""}`, {
            provider: this.id,
            retryable: true,
          }),
          fatal: code === "auth",
        };
      }
    } catch (err) {
      yield {
        type: "error", error: harnessError(cancelled ? "aborted" : "unknown", `codex CLI failed: ${(err as Error).message}`, { provider: this.id }),
        fatal: true,
      };
    } finally {
      clearTimeout(killer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const authFile = join(this.codexHome, "auth.json");
    try {
      const { execFileSync } = await import("node:child_process");
      const version = execFileSync("codex", ["--version"], {
        env: { ...process.env, CODEX_HOME: this.codexHome },
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      const loggedIn = existsSync(authFile);
      return {
        provider: this.id,
        ok: loggedIn,
        detail: loggedIn
          ? `${version}; logged in (CODEX_HOME=${this.codexHome})`
          : `${version}; not logged in — run: harness auth codex`,
        modelsFound: Object.keys(SEED_CAPS).length,
        checkedAt,
      };
    } catch {
      return { provider: this.id, ok: false, detail: "codex CLI not found", checkedAt };
    }
  }
}
