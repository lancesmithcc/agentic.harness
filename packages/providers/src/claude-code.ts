/**
 * Claude Code subscription adapter (PRD §6, §9).
 *
 * Invokes the official `claude` CLI in non-interactive mode with
 * stream-json output. Authentication stays 100% owned by Claude Code —
 * we never scrape sessions, extract tokens, or touch auth files.
 *
 * Profile isolation: each profile gets its own CLAUDE_CONFIG_DIR, and each
 * account is authenticated independently via `harness auth claude`.
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

export function harnessError(
  code: HarnessError["code"],
  message: string,
  opts: Partial<HarnessError> = {},
): HarnessError {
  const err = new Error(message) as HarnessError;
  err.code = code;
  Object.assign(err, opts);
  return err;
}

const SEED_CAPS: Record<string, ModelCapabilities> = {
  default: { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 200000 },
  sonnet: { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 200000 },
  opus: { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 200000 },
  haiku: { coding: 8, reasoning: 7, tools: true, vision: true, billing: "subscription", context: 200000 },
  "opus-5": { coding: 10, reasoning: 10, tools: true, vision: true, billing: "subscription", context: 200000, thinking: true },
};

/** Flatten a conversation into a transcript claude -p can consume. */
function flatten(messages: HarnessRequest["messages"]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[System instructions]\n${m.content}`);
    else if (m.role === "user") parts.push(`[User]\n${m.content}`);
    else if (m.role === "assistant") parts.push(`[Assistant (earlier turn)]\n${m.content}`);
    else if (m.role === "tool") parts.push(`[Tool result]\n${m.content}`);
  }
  parts.push("[Assistant] Respond to the latest [User] message.");
  return parts.join("\n\n");
}

export class ClaudeCodeProvider implements ModelProvider {
  readonly id = "claude-code";
  readonly kind = "subscription-cli" as const;
  readonly configDir: string;

  constructor(profile: string) {
    this.configDir = join(HARNESS_HOME, "profiles", profile, "claude");
    if (!existsSync(this.configDir)) mkdirSync(this.configDir, { recursive: true });
  }

  async models(): Promise<Model[]> {
    // Claude Code manages its own model list interactively; expose stable
    // pass-through names. `--model` accepts these on the CLI.
    return Object.entries(SEED_CAPS).map(([m, caps]) => ({
      id: `${this.id}/${m}`,
      model: m,
      provider: this.id,
      name: m === "default" ? "Claude (subscription default)" : `Claude ${m}`,
      capabilities: caps,
    }));
  }

  capabilities(model: string): ModelCapabilities {
    return SEED_CAPS[model] ?? SEED_CAPS["default"]!;
  }

  async *generate(request: HarnessRequest): AsyncIterable<HarnessEvent> {
    const model = request.model.includes("/") ? request.model.split("/").slice(1).join("/") : request.model;
    const args = ["-p", flatten(request.messages), "--output-format", "stream-json", "--verbose"];
    // Account-level defaults can reference unavailable models (e.g. "opus 5"
    // -> 404), so always pass an explicit valid model.
    const MODEL_MAP: Record<string, string> = {
      default: "sonnet", sonnet: "sonnet", opus: "opus", haiku: "haiku",
      "opus-5": "opus",
    };
    args.push("--model", MODEL_MAP[model] ?? "sonnet");

    const child = spawn("claude", args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = Date.now();
    let full = "";
    let buf = "";
    let sawResult = false;
    const stderr: string[] = [];
    // CLI subprocesses must never hang the fallback chain: hard ceiling.
    const killer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 90_000);
    child.on("exit", () => clearTimeout(killer));

    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 20) stderr.push(d.toString());
    });

    const lineStream = async function* (proc: typeof child): AsyncGenerator<string> {
      let pending = "";
      for await (const chunk of proc.stdout) {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) yield line;
      }
      if (pending.trim()) yield pending;
    };

    try {
      for await (const line of lineStream(child)) {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = evt.type as string;
        if (type === "assistant") {
          const message = evt.message as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } | undefined;
          for (const block of message?.content ?? []) {
            if (block.type === "text" && block.text) {
              full += block.text;
              yield { type: "text-delta", text: block.text };
            } else if (block.type === "tool_use") {
              yield {
                type: "tool-call",
                id: block.id ?? "tool",
                name: block.name ?? "unknown",
                arguments: JSON.stringify(block.input ?? {}),
              };
            }
          }
        } else if (type === "result") {
          sawResult = true;
          const subtype = evt.subtype as string;
          if (subtype === "error_max_turns" || subtype === "error_during_execution") {
            yield {
              type: "error",
              error: harnessError("provider-error", String(evt.error ?? evt.result ?? "claude error"), {
                provider: this.id,
                retryable: true,
              }),
              fatal: false,
            };
          }
          const usageIn = evt.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          const usage: UsageReport | null = usageIn
            ? {
                inputTokens: usageIn.input_tokens,
                outputTokens: usageIn.output_tokens,
                totalTokens: (usageIn.input_tokens ?? 0) + (usageIn.output_tokens ?? 0),
                costUsd: typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : undefined,
                billing: "subscription",
              }
            : null;
          if (usage) yield { type: "usage", usage };
          yield { type: "model-call", model, provider: this.id, latencyMs: Date.now() - started };
          const resultText = (evt.result as string) ?? full;
          // Claude Code reports upstream failures as normal result text.
          if (/^API Error\b/.test(resultText.trim())) {
            const code: HarnessError["code"] = /401|authentication|revoked/i.test(resultText) ? "auth" : "provider-error";
            yield {
              type: "error",
              error: harnessError(code, resultText.slice(0, 200), { provider: this.id, model }),
              fatal: code === "auth",
            };
            return;
          }
          yield { type: "done", finishReason: evt.subtype as string | undefined, text: resultText };
        }
      }
      if (!sawResult) {
        const errText = stderr.join("").slice(0, 400);
        const code: HarnessError["code"] = /login|auth|credential|api key/i.test(errText) ? "auth" : "provider-error";
        yield {
          type: "error",
          error: harnessError(code, `claude produced no result${errText ? `; stderr: ${errText}` : ""}`, {
            provider: this.id,
            model,
          }),
          fatal: true,
        };
      }
    } catch (err) {
      yield {
        type: "error",
        error: harnessError("unknown", `claude CLI failed: ${(err as Error).message}; stderr: ${stderr.join("").slice(0, 400)}`, {
          provider: this.id,
        }),
        fatal: true,
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const { execFileSync } = await import("node:child_process");
      const version = execFileSync("claude", ["--version"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir },
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      return {
        provider: this.id,
        ok: true,
        detail: `${version}; config ${this.configDir} (login owned by Claude Code)`,
        modelsFound: Object.keys(SEED_CAPS).length,
        checkedAt,
      };
    } catch {
      return { provider: this.id, ok: false, detail: "claude CLI not found or failed", checkedAt };
    }
  }
}
