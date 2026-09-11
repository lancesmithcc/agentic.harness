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
    const prompt = request.messages
      .map((m) =>
        m.role === "system"
          ? `[System instructions]\n${m.content}`
          : `[${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant (earlier turn)" : "Tool result"}]\n${m.content}`,
      )
      .join("\n\n");

    const args = ["exec", "--json", "--sandbox", this.sandbox];
    if (model && model !== "default") args.push("-m", model);
    args.push(prompt);

    const child = spawn("codex", args, {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = Date.now();
    let full = "";
    let sawError = false;
    const stderr: string[] = [];
    // CLI subprocesses must never hang the fallback chain: hard ceiling.
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 90_000);
    child.on("exit", () => clearTimeout(killer));
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 20) stderr.push(d.toString());
    });

    try {
      let pending = "";
      for await (const chunk of child.stdout) {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = evt.type as string;
          if (type === "item.completed") {
            const item = evt.item as { type?: string; text?: string } | undefined;
            if (item?.type === "agent_message" && item.text) {
              full += item.text;
              yield { type: "text-delta", text: item.text };
            }
          } else if (type === "item.started" || type === "item.updated") {
            // streaming fragments; final text arrives via item.completed
          } else if (type === "turn.completed") {
            const usageIn = evt.usage as
              | { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
              | undefined;
            const usage: UsageReport | null = usageIn
              ? {
                  inputTokens: (usageIn.input_tokens ?? 0) + (usageIn.cached_input_tokens ?? 0),
                  outputTokens: usageIn.output_tokens,
                  totalTokens: (usageIn.input_tokens ?? 0) + (usageIn.output_tokens ?? 0),
                  billing: "subscription",
                }
              : null;
            if (usage) yield { type: "usage", usage };
            yield { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started };
            yield { type: "done", finishReason: "stop", text: full };
          } else if (type === "error") {
            sawError = true;
            const msg = String(evt.message ?? "codex error");
            const code = /auth|login|401/i.test(msg) ? "auth" : /rate|429|quota/i.test(msg) ? "rate-limit" : "provider-error";
            yield { type: "error", error: harnessError(code, msg, { provider: this.id, model }), fatal: code === "auth" };
          }
        }
      }
      if (!sawError && !full) {
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
        type: "error",
        error: harnessError("unknown", `codex CLI failed: ${(err as Error).message}`, { provider: this.id }),
        fatal: true,
      };
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
