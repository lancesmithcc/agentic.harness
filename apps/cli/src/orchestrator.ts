/**
 * Orchestrator: one routed request with fallback (PRD §33), and multi-agent
 * delegation (PRD §21). The verification rule from delegation.md is enforced
 * here: a model must not verify its own major implementation when another
 * qualified model is available.
 */
import type {
  HarnessEvent,
  HarnessRequest,
  Model,
  ModelProvider,
  ProviderHealth,
  RoutingDecision,
  TurnOutcome,
} from "@harness/core";
import { jevDecider, route, resolveModelRef, routeAsync, taskRequiresTools } from "@harness/router";
import type { DelegationDoc } from "@harness/router";
import type { SessionStore } from "@harness/sessions";
import { recordUsage } from "@harness/sessions";
import { randomUUID } from "node:crypto";

export interface OrchestratorContext {
  providers: Map<string, ModelProvider>;
  models: Model[];
  health: Map<string, ProviderHealth>;
  delegation: DelegationDoc | null;
  session: SessionStore;
  profile: string;
}

export interface AskOptions {
  /** Per-call adapter options (working folder, access level, MCP config, timeout). */
  request?: Pick<HarnessRequest, "cwd" | "access" | "mcpConfig" | "timeoutMs" | "addDirs" | "signal" | "tools" | "profile">;
  pinnedModel?: string;
  escalate?: boolean;
  /** Override action-task detection when a caller knows tool execution is required. */
  requiresTools?: boolean;
  onEvent?: (e: HarnessEvent) => void;
  /** Stop after the first provider even if it emits a fatal error. */
  noFallback?: boolean;
}

export interface AskResult {
  decision: RoutingDecision;
  text: string;
  providerUsed: string;
  modelUsed: string;
  fellBack: Array<{ from: string; to: string; cause: string }>;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** `completed` requires a provider done event; never infer success from text. */
  outcome: TurnOutcome;
  /** Present when output was interrupted or no usable response completed. */
  error?: string;
}

/** Classify provider errors worth falling back for. */
function fallbackWorthy(e: HarnessEvent): string | null {
  if (e.type !== "error") return null;
  const code = e.error.code;
  if (code === "rate-limit") return `rate limit (${e.error.provider})`;
  if (code === "unavailable") return `${e.error.provider} unavailable`;
  if (code === "auth") return `${e.error.provider} auth failed`;
  if (e.fatal && code === "provider-error") return e.error.message.slice(0, 120);
  return null;
}

export async function askRouted(
  ctx: OrchestratorContext,
  task: string,
  messages: Parameters<ModelProvider["generate"]>[0]["messages"],
  opts: AskOptions = {},
): Promise<AskResult> {
  // A follow-up after tool work needs the same executable runtime even when
  // its wording is conversational (for example, "now run it again").
  const priorToolWork = ctx.session.all().some((event) => event.kind === "tool-call" || event.kind === "tool-result");
  const inferredTools = opts.requiresTools ?? (taskRequiresTools(task) || priorToolWork);
  const useTools = opts.request?.tools ?? inferredTools;
  const decision = await routeAsync({
    task,
    models: ctx.models,
    health: ctx.health,
    delegation: ctx.delegation,
    pinnedModel: opts.pinnedModel,
    escalate: opts.escalate,
    requiresTools: useTools,
  }, jevDecider(opts.request?.profile ?? ctx.profile));
  ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "routing", decision });
  if (decision.selected === "none") throw new Error(decision.reason.slice(-2).join("; ") || "no available model can handle this task");

  const chain = [decision.selected, ...decision.fallbacks];
  const fellBack: AskResult["fellBack"] = [];
  let lastError = "no provider succeeded";

  for (const modelId of chain) {
    if (modelId === "none") continue;
    const providerId = modelId.split("/")[0]!;
    const provider = ctx.providers.get(providerId);
    if (!provider) continue;

    const turnId = randomUUID();
    const textChunks: string[] = [];
    let completedText: string | undefined;
    let fatalCause: string | null = null;
    // A provider error that is not fallback-worthy (a 402, a malformed request)
    // used to vanish, leaving the turn looking like an unexplained empty stream.
    let lastProviderError: string | null = null;
    let sawDone = false;
    let sawTool = false;
    let cancelled = false;
    const usage: AskResult["usage"] = {};

    try {
      for await (const evt of provider.generate({ ...opts.request, tools: useTools, profile: opts.request?.profile ?? ctx.profile, cwd: opts.request?.cwd ?? process.cwd(), model: modelId, messages, taskLabel: task })) {
        switch (evt.type) {
          case "text-delta":
            // Persist before forwarding: an abrupt process exit can lose at
            // most the current provider event, never an already-visible one.
            ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "assistant-delta", turnId, text: evt.text, provider: providerId, model: modelId });
            textChunks.push(evt.text);
            break;
          case "done":
            sawDone = true;
            completedText = evt.text || undefined;
            break;
          case "tool-call":
            // A tool call is observable work. Re-running another model after
            // it can duplicate a write or lose required tool state.
            sawTool = true;
            ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "tool-call", id: evt.id, name: evt.name, arguments: evt.arguments, turnId, provider: providerId, model: modelId });
            break;
          case "tool-result":
            // Results can reveal an executed side effect even if the provider
            // omitted its call event. Journal before notifying the UI.
            sawTool = true;
            ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "tool-result", id: evt.id, name: evt.name, content: evt.content.slice(0, 32_768), isError: evt.isError, turnId, provider: providerId, model: modelId });
            break;
          case "usage":
            // Agentic SDKs can report usage once per tool/model step. Keep the
            // complete turn total rather than showing only the final step.
            if (evt.usage.inputTokens !== undefined) usage.inputTokens = (usage.inputTokens ?? 0) + evt.usage.inputTokens;
            if (evt.usage.outputTokens !== undefined) usage.outputTokens = (usage.outputTokens ?? 0) + evt.usage.outputTokens;
            if (evt.usage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + evt.usage.costUsd;
            void recordUsage(ctx.profile, providerId, modelId, evt.usage);
            ctx.session.append({
              v: 1,
              ts: new Date().toISOString(),
              kind: "usage",
              usage: evt.usage,
              provider: providerId,
              model: modelId,
            });
            break;
          default:
            break;
        }
        opts.onEvent?.(evt);
        if (evt.type === "error" && evt.error.code !== "aborted") {
          lastProviderError = `${evt.error.message}`.slice(0, 200);
        }
        const cause = fallbackWorthy(evt);
        if (evt.type === "error" && evt.error.code === "aborted") {
          cancelled = true;
          fatalCause = evt.error.message || "request cancelled";
          break;
        }
        if (cause && evt.type === "error" && (evt.fatal || evt.error.code === "rate-limit")) {
          fatalCause = cause;
          break;
        }
      }
    } catch (err) {
      cancelled = opts.request?.signal?.aborted === true;
      fatalCause = (err as Error).message.slice(0, 120);
    }

    const text = completedText || textChunks.join("");

    // Preserve anything the user has already seen even when a stream ends
    // badly. This is also the record used when a caller resumes a session.
    if (text) {
      ctx.session.append({
        v: 1, ts: new Date().toISOString(), kind: "assistant-text", text,
        provider: providerId, model: modelId, turnId,
      });
    }
    const persistOutcome = (outcome: Exclude<TurnOutcome, "completed">, error: string) => {
      ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "turn-outcome", provider: providerId, model: modelId, outcome, error });
    };
    if (cancelled) {
      const error = fatalCause ?? "request cancelled";
      const outcome: Exclude<TurnOutcome, "completed"> = text ? "interrupted" : "failed";
      persistOutcome(outcome, error);
      return { decision, text, providerUsed: providerId, modelUsed: modelId, fellBack, usage, outcome, error };
    }

    if (fatalCause) {
      // Never discard or repeat a response/tool sequence by falling back
      // after a provider has made visible progress.
      if (text || sawTool) {
        const outcome: Exclude<TurnOutcome, "completed"> = text ? "interrupted" : "failed";
        persistOutcome(outcome, fatalCause);
        return { decision, text, providerUsed: providerId, modelUsed: modelId, fellBack, usage, outcome, error: fatalCause };
      }
      if (opts.noFallback || chain.indexOf(modelId) === chain.length - 1) {
        // No response was produced and no safe route remains.
        throw new Error(`all routes failed; last error: ${fatalCause}`);
      }
      const next = chain[chain.indexOf(modelId) + 1];
      if (!next) throw new Error(`route failed at ${modelId}: ${fatalCause}`);
      fellBack.push({ from: modelId, to: next, cause: fatalCause });
      ctx.session.append({
        v: 1,
        ts: new Date().toISOString(),
        kind: "fallback",
        from: modelId,
        to: next,
        cause: fatalCause,
      });
      continue;
    }
    if (sawDone && text) {
      return { decision, text, providerUsed: providerId, modelUsed: modelId, fellBack, usage, outcome: "completed" };
    }
    if (text || sawTool) {
      const error = "provider stream ended without a completion event";
      const outcome: Exclude<TurnOutcome, "completed"> = text ? "interrupted" : "failed";
      persistOutcome(outcome, error);
      return { decision, text, providerUsed: providerId, modelUsed: modelId, fellBack, usage, outcome, error };
    }
    // Report why the stream was empty when the provider said why, and honour
    // noFallback here exactly as the error path above does.
    const emptyCause = lastProviderError ?? "empty output";
    lastError = lastProviderError ? `${modelId}: ${lastProviderError}` : `${modelId} produced no output`;
    persistOutcome("failed", lastError);
    const next = opts.noFallback ? undefined : chain[chain.indexOf(modelId) + 1];
    if (!next) break;
    fellBack.push({ from: modelId, to: next, cause: emptyCause });
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------
// Multi-agent delegation (PRD §21)
// ---------------------------------------------------------------------------

export interface AgentJob {
  role: string;
  task: string;
  /** Preferred model reference from delegation.md; routed if omitted. */
  modelRef?: string;
}

export interface AgentResult {
  role: string;
  modelUsed: string;
  text: string;
}

/**
 * Run a planner → workers → reviewer pipeline. The reviewer is routed to a
 * DIFFERENT provider than the implementer whenever the fleet allows
 * (delegation.md: models must not verify their own major work).
 */
export async function runPipeline(
  ctx: OrchestratorContext,
  task: string,
  opts: { onAgentStart?: (role: string, model: string) => void } = {},
): Promise<{ plan: AgentResult; workers: AgentResult[]; review: AgentResult }> {
  // 1) Planner — architecture-tier model.
  const plan = await runJob(ctx, { role: "planner", task: `Plan the following work. Output a short numbered list of implementation steps, no code:\n\n${task}` }, opts);
  const workerRoles = extractSteps(plan.text).slice(0, 4);

  // 2) Workers — one routed call per step (general-coding tier).
  const workers: AgentResult[] = [];
  for (const step of workerRoles) {
    const r = await runJob(
      ctx,
      {
        role: "developer",
        task: `Implement this step of a larger task. Return only the concrete work product (code/diff/commands), concise:\n\nStep: ${step}\n\nOverall task: ${task}\n\nPlan:\n${plan.text.slice(0, 2000)}`,
      },
      opts,
    );
    workers.push(r);
  }

  // 3) Reviewer — must differ from the dominant worker provider.
  const workerProviders = new Set(workers.map((w) => w.modelUsed.split("/")[0] ?? ""));
  const exclude = [...workerProviders];
  const reviewDecision = pickReviewer(ctx, exclude);
  const review = await runJob(
    ctx,
    {
      role: "reviewer",
      task: `Review these implementation steps for correctness, completeness, and risk. Be specific and brief. You did NOT write this code, so verify assumptions:\n\n${workers.map((w) => `## ${w.role} (${w.modelUsed})\n${w.text.slice(0, 3000)}`).join("\n\n")}`,
    },
    opts,
    reviewDecision,
  );
  return { plan, workers, review };
}

async function runJob(
  ctx: OrchestratorContext,
  job: AgentJob,
  opts: { onAgentStart?: (role: string, model: string) => void },
  forceModelId?: string,
): Promise<AgentResult> {
  const pinned = job.modelRef ? resolveRefToId(job.modelRef, ctx.models) : undefined;
  const result = await askRouted(
    ctx,
    `${job.role}: ${job.task}`,
    [{ role: "user", content: job.task }],
    { pinnedModel: forceModelId ?? pinned },
  );
  const modelUsed = result.modelUsed;
  opts.onAgentStart?.(job.role, modelUsed);
  return { role: job.role, modelUsed, text: result.text };
}

function resolveRefToId(ref: string, models: Model[]): string | undefined {
  return resolveModelRef(ref, models)?.id;
}

function extractSteps(planText: string): string[] {
  return planText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]\s|^[-*]\s/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s*|^[-*]\s*/, ""))
    .filter((l) => l.length > 3)
    .slice(0, 6);
}

function pickReviewer(ctx: OrchestratorContext, excludeProviders: string[]): string | undefined {
  const ranked = [...ctx.models]
    .filter((m) => !excludeProviders.includes(m.provider) && (m.capabilities.reasoning ?? 0) >= 8)
    .sort((a, b) => (b.capabilities.reasoning ?? 0) - (a.capabilities.reasoning ?? 0));
  return ranked[0]?.id;
}
