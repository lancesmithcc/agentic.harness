/**
 * Orchestrator: one routed request with fallback (PRD §33), and multi-agent
 * delegation (PRD §21). The verification rule from delegation.md is enforced
 * here: a model must not verify its own major implementation when another
 * qualified model is available.
 */
import type {
  HarnessEvent,
  Model,
  ModelProvider,
  ProviderHealth,
  RoutingDecision,
} from "@harness/core";
import { route, resolveModelRef } from "@harness/router";
import type { DelegationDoc } from "@harness/router";
import type { SessionStore } from "@harness/sessions";
import { recordUsage } from "@harness/sessions";

export interface OrchestratorContext {
  providers: Map<string, ModelProvider>;
  models: Model[];
  health: Map<string, ProviderHealth>;
  delegation: DelegationDoc | null;
  session: SessionStore;
  profile: string;
}

export interface AskOptions {
  pinnedModel?: string;
  escalate?: boolean;
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
  const decision = route({
    task,
    models: ctx.models,
    health: ctx.health,
    delegation: ctx.delegation,
    pinnedModel: opts.pinnedModel,
    escalate: opts.escalate,
  });
  ctx.session.append({ v: 1, ts: new Date().toISOString(), kind: "routing", decision });

  const chain = [decision.selected, ...decision.fallbacks];
  const fellBack: AskResult["fellBack"] = [];
  let lastError = "no provider succeeded";

  for (const modelId of chain) {
    if (modelId === "none") continue;
    const providerId = modelId.split("/")[0]!;
    const provider = ctx.providers.get(providerId);
    if (!provider) continue;

    let text = "";
    let fatalCause: string | null = null;
    let sawDone = false;
    const usage: AskResult["usage"] = {};

    try {
      for await (const evt of provider.generate({ model: modelId, messages, taskLabel: task })) {
        opts.onEvent?.(evt);
        switch (evt.type) {
          case "text-delta":
            text += evt.text;
            break;
          case "done":
            sawDone = true;
            text = evt.text || text;
            break;
          case "usage":
            Object.assign(usage, {
              inputTokens: evt.usage.inputTokens,
              outputTokens: evt.usage.outputTokens,
              costUsd: evt.usage.costUsd,
            });
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
        const cause = fallbackWorthy(evt);
        if (cause && evt.type === "error" && (evt.fatal || evt.error.code === "rate-limit")) {
          fatalCause = cause;
          break;
        }
      }
    } catch (err) {
      fatalCause = (err as Error).message.slice(0, 120);
    }

    if (fatalCause && (opts.noFallback || chain.indexOf(modelId) === chain.length - 1)) {
      // No more fallbacks — surface the failure.
      throw new Error(`all routes failed; last error: ${fatalCause}`);
    }
    if (fatalCause) {
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
    if (sawDone || text) {
      ctx.session.append({
        v: 1,
        ts: new Date().toISOString(),
        kind: "assistant-text",
        text,
        provider: providerId,
        model: modelId,
      });
      return { decision, text, providerUsed: providerId, modelUsed: modelId, fellBack, usage };
    }
    lastError = `${modelId} produced no output`;
    const next = chain[chain.indexOf(modelId) + 1];
    if (next) {
      fellBack.push({ from: modelId, to: next, cause: "empty output" });
      continue;
    }
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
