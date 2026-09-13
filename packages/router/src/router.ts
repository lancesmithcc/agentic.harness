/**
 * Task Router (PRD §19, §20, §33). Combines:
 *   - delegation.md (front-matter routing map and Best For / Avoid For rows)
 *   - capability scores per category
 *   - provider availability
 *   - billing preference (local → subscription/coding-plan → api) as tiebreaker
 * and always produces an ordered fallback chain, never a single point of
 * failure. Escalation moves UP the chain; unavailability falls back along it.
 */
import type { Model, ModelCapabilities, ProviderHealth, RoutingDecision, TaskCategory } from "@harness/core";
import type { DelegationDoc } from "./delegation.ts";
import { resolveModelRef } from "./normalize.ts";
import { classifyTask } from "./classify.ts";

export interface RouteInput {
  task: string;
  models: Model[];
  health: Map<string, ProviderHealth>;
  delegation: DelegationDoc | null;
  contextTokens?: number;
  /** Manual pin: qualified model id. Skips routing, still builds fallbacks. */
  pinnedModel?: string;
  /** Force escalation one step up the ladder. */
  escalate?: boolean;
  /** Require an adapter that can actually execute tools/files for this task. */
  requiresTools?: boolean;
}

const CATEGORY_CAP_KEY: Partial<Record<TaskCategory, "coding" | "reasoning" | "summarization">> = {
  "general-coding": "coding",
  "difficult-coding": "coding",
  "long-context": "reasoning",
  architecture: "reasoning",
  research: "reasoning",
  debugging: "reasoning",
  review: "reasoning",
  simple: "summarization",
  "office-production": "reasoning",
  multimodal: "reasoning",
};

const BILLING_RANK: Record<string, number> = { local: 0, subscription: 1, "coding-plan": 1, api: 2 };

const NO_CAPS: ModelCapabilities = {};

/** Rank models for a category using capabilities + billing preference. */
function capabilityRank(models: Model[], category: TaskCategory): Model[] {
  const capKey = CATEGORY_CAP_KEY[category];
  return [...models].sort((a, b) => {
    const ca = a.capabilities ?? NO_CAPS;
    const cb = b.capabilities ?? NO_CAPS;
    let diff = 0;
    if (capKey) diff = (cb[capKey] ?? 5) - (ca[capKey] ?? 5);
    if (diff === 0) diff = (cb.reasoning ?? 5) - (ca.reasoning ?? 5);
    if (diff === 0 && category === "long-context") {
      // Big windows win for long-context work; symmetric comparator.
      const da = (ca.context ?? 0) > 500_000 ? 1 : 0;
      const db = (cb.context ?? 0) > 500_000 ? 1 : 0;
      diff = db - da;
    }
    if (diff === 0) diff = (BILLING_RANK[ca.billing ?? "api"] ?? 2) - (BILLING_RANK[cb.billing ?? "api"] ?? 2);
    if (diff === 0) diff = (ca.cost ?? 1) - (cb.cost ?? 1);
    return diff;
  });
}

/** Light stemmer so "refactors" matches "refactor", "debugging" matches "debug". */
function stem(w: string): string {
  if (w.endsWith("ies") && w.length > 6) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 6) {
    const base = w.slice(0, -3);
    return base.length > 2 && base.at(-1) === base.at(-2) ? base.slice(0, -1) : base;
  }
  if (w.endsWith("es") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("s") && w.length > 4) return w.slice(0, -1);
  return w;
}

/** Text-only chat adapters may draft code but cannot inspect or change a workspace. */
export function taskRequiresTools(task: string): boolean {
  const action = /\b(?:implement|fix|patch|refactor|modify|edit|update|run(?:ning)?\s+(?:tests?|build|command)|test(?:ing)?|build|deploy|commit)\b/i;
  const inspect = /\b(?:read|inspect|list|search|find|grep|open)\b[\s\S]{0,80}\b(?:files?|folders?|director(?:y|ies)|repo(?:sitory)?|workspace|source|codebase|project)\b/i;
  const runtime = /\b(?:use|call|run|execute|install|configure)\b[\s\S]{0,48}\b(?:mcp|tool(?:s)?|shell|terminal|command(?:s)?)\b|\b(?:self[ -]?evolve|own[ -]?source)\b/i;
  return action.test(task) || inspect.test(task) || runtime.test(task);
}

/** Generic words that must never match a delegation phrase on their own. */
const GENERIC_WORDS = new Set([
  "work", "works", "code", "coding", "task", "tasks", "file", "files", "build",
  "make", "write", "simple", "short", "long", "quick", "small", "large", "big",
  "thing", "things", "stuff", "this", "that", "them", "then", "when", "where",
]);

function rowMatches(task: string, phrases: string[]): boolean {
  const t = task.toLowerCase();
  return phrases.some((p) => {
    const words = p.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|when|are|you|its?|has|more|until|independent|testing)$/i.test(w));
    if (words.length === 0) return false;
    const stems = words.map(stem);
    const hits = stems.filter((s) => t.includes(s)).length;
    // Single-stem phrases need a specific word ("debug", "refactor") — never
    // a lone generic one like "work" or "code".
    if (stems.length === 1) {
      const s = stems[0]!;
      return hits >= 1 && s.length >= 5 && !GENERIC_WORDS.has(s);
    }
    return hits >= Math.max(2, Math.ceil(stems.length * 0.6));
  });
}

/**
 * Quoted/backticked passages are the OBJECT of a task ("classify this:
 * '...tests...'"), not the instruction — strip them before matching so
 * embedded words don't steer routing.
 */
function stripQuoted(task: string): string {
  return task.replace(/(['"`])[^'"`\n]{3,}\1/g, "$1…$1");
}

export function route(input: RouteInput): RoutingDecision {
  const { task, models, health, delegation } = input;
  const matchText = stripQuoted(task);
  const reason: string[] = [];
  const needsTools = input.requiresTools ?? taskRequiresTools(task);

  // Manual pin: respect it, build fallbacks around it.
  if (input.pinnedModel) {
    const pinned = models.find((m) => m.id === input.pinnedModel || m.model === input.pinnedModel);
    if (pinned) {
      if (needsTools && pinned.capabilities?.tools !== true) {
        return { task, category: "unknown", selected: "none", reason: [`${pinned.id} provides text replies only; select an agent with file/tool execution for this task`], fallbacks: [], confidence: 1, classifiedBy: "manual-pin" };
      }
      const ranked = capabilityRank(models.filter((m) => m.id !== pinned.id && health.get(m.provider)?.ok !== false && (!needsTools || m.capabilities?.tools === true)), "general-coding");
      // Diverse fallbacks: one model per provider before siblings.
      const diverse: string[] = [];
      const siblings: string[] = [];
      for (const m of ranked) {
        if (m.provider === pinned.provider) siblings.push(m.id);
        else if (!diverse.some((id) => id.split("/")[0] === m.provider)) diverse.push(m.id);
      }
      return {
        task,
        category: "unknown",
        selected: pinned.id,
        reason: ["manually pinned"],
        fallbacks: [...diverse.slice(0, 3), ...siblings.slice(0, 1)],
        confidence: 1,
        classifiedBy: "manual-pin",
      };
    }
    reason.push(`pinned model ${input.pinnedModel} not in fleet; routing normally`);
  }

  const classification = classifyTask(matchText, { contextTokens: input.contextTokens });
  const category = classification.category;
  reason.push(...classification.signals.map((s) => `signal: ${s}`));

  let ordered: Model[] = [];
  let classifiedBy: RoutingDecision["classifiedBy"] = "heuristic";

  // 1) Explicit front-matter routing map wins when present for the category.
  const fmList = delegation?.frontmatter?.routing?.[category];
  if (fmList?.length) {
    const resolvedPairs = fmList.map((ref) => ({ ref, model: resolveModelRef(ref, models) }));
    const resolved = resolvedPairs.map((x) => x.model).filter((m): m is Model => m !== null);
    const unresolved = resolvedPairs.filter((x) => x.model === null).map((x) => x.ref);
    const rest = capabilityRank(
      models.filter((m) => !resolved.some((r) => r.id === m.id)),
      category,
    );
    ordered = [...resolved, ...rest];
    classifiedBy = "delegation-frontmatter";
    reason.push(`delegation.md front-matter routing for "${category}"`);
    for (const u of unresolved) reason.push(`(could not resolve "${u}" in fleet)`);
  } else {
    // 2) Capability ranking as the base order.
    ordered = capabilityRank(models, category);
    reason.push(`ranked by capability for "${category}"`);
  }

  // 3) delegation.md rows: Best For boosts, Avoid For penalizes.
  if (delegation?.rows.length) {
    // ⭐ default production worker gets a standing boost for ordinary work.
    const starredRow = delegation.rows.find((r) => r.starred && /default production worker/i.test(r.role));
    for (const row of delegation.rows) {
      const target = resolveModelRef(row.model, models);
      if (!target || !ordered.includes(target)) continue;
      const isDefaultWorker = row === starredRow && (category === "general-coding" || category === "unknown");
      if (rowMatches(matchText, row.bestFor) || isDefaultWorker) {
        const idx = ordered.indexOf(target);
        if (idx > 0) {
          ordered.splice(idx, 1);
          ordered.unshift(target);
        }
        reason.push(`delegation.md: ${row.model} listed for this kind of work (${row.role})`);
      }
      if (rowMatches(matchText, row.avoidFor)) {
        const idx = ordered.indexOf(target);
        if (idx >= 0 && idx < ordered.length - 1) {
          ordered.splice(idx, 1);
          ordered.push(target);
          reason.push(`delegation.md: ${row.model} should avoid this kind of work`);
        }
      }
    }
  }

  // 4) local_first preference: bump local models for simple work.
  if (delegation?.frontmatter?.localFirst && (category === "simple" || category === "unknown")) {
    const locals = ordered.filter((m) => m.capabilities?.local);
    if (locals.length) {
      ordered = [...locals, ...ordered.filter((m) => !m.capabilities?.local)];
      reason.push("local_first: local models preferred for this task class");
    }
  }

  // 5) Availability: split healthy from unhealthy; never select unhealthy.
  let available: Model[] = [];
  const unavailable: Model[] = [];
  for (const m of ordered) {
    const h = health.get(m.provider);
    // Unknown health counts as available; explicit ok=false does not.
    if (h && !h.ok) unavailable.push(m);
    else available.push(m);
  }
  for (const m of unavailable) reason.push(`${m.id} unavailable (${health.get(m.provider)?.detail})`);

  if (needsTools) {
    const executable = available.filter((m) => m.capabilities?.tools === true);
    available = executable;
    reason.push(executable.length
      ? "task requires file/tool execution; text-only adapters excluded"
      : "task requires file/tool execution, but no executable adapter is available");
  }

  // 6) Escalation: prefer the strongest tier — local and low-capability
  //    models move behind stronger ones (bounded reorder, never a loop).
  if (input.escalate && available.length > 1) {
    const before = available[0]?.id;
    const capKey = CATEGORY_CAP_KEY[category] ?? "coding";
    const strong = available.filter((m) => {
      const c = m.capabilities ?? NO_CAPS;
      return !c.local && (((c[capKey] as number | undefined) ?? 0) > 7 || (c.reasoning ?? 0) > 7);
    });
    if (strong.length > 0) {
      const strongIds = new Set(strong.map((m) => m.id));
      available = [...strong, ...available.filter((m) => !strongIds.has(m.id))];
      reason.push(`escalated: ${before} → ${available[0]?.id}`);
    }
  }

  const selected = available[0];
  if (!selected) {
    return {
      task,
      category,
      selected: "none",
      reason: [...reason, "no available models"],
      fallbacks: [],
      confidence: 0,
      classifiedBy,
    };
  }

  // Fallback diversity: one model per provider first — falling back to a
  // sibling of the failed provider is rarely useful. Siblings follow after.
  const seenProviders = new Set([selected.provider]);
  const diverse: string[] = [];
  const siblings: string[] = [];
  for (const m of available.slice(1)) {
    if (seenProviders.has(m.provider)) siblings.push(m.id);
    else {
      seenProviders.add(m.provider);
      diverse.push(m.id);
    }
  }
  const fallbacks = [...diverse.slice(0, 3), ...siblings.slice(0, 1)];

  return {
    task,
    category,
    selected: selected.id,
    reason,
    fallbacks,
    confidence: classification.confidence,
    classifiedBy,
    escalated: input.escalate,
  };
}
