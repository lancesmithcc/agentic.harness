/**
 * Jev — TypeSafe's System One decision model (https://docs.typesafe.ai).
 *
 * Jev answers *typed* questions about a piece of state and returns a probability
 * distribution, not prose. That makes it a better classifier than the keyword
 * heuristic and a safer one than a chat model: there is nothing to parse, every
 * answer carries a confidence, and one call answers several questions at once.
 *
 * It decides *what kind of work this is*; delegation.md and the capability
 * ranking still decide *which model does it*. When Jev is unconfigured,
 * unreachable, or unsure, routing silently falls back to `classifyTask`.
 */
import { SecretStore, type TaskCategory } from "@harness/core";
import type { Classification } from "./classify.ts";
import { classifyTask } from "./classify.ts";

export interface JevConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** Answers below this confidence are discarded in favour of the heuristic. */
  minConfidence: number;
  timeoutMs: number;
}

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
/** The API returns the probability on `noul`; `value` is accepted defensively. */
interface JevNoulAnswer { type: "noul"; noul?: number; value?: number }
type JevAnswer = JevChoiceAnswer | JevNoulAnswer | { type: "score"; score: number; confidence: number };

interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** What each category means, in the words Jev scores the task against. */
const CATEGORY_CRITERIA: Record<Exclude<TaskCategory, "unknown">, string> = {
  simple: "Summarizing, classifying, extracting, renaming, tagging, or another short mechanical transform",
  "general-coding": "Ordinary coding: add a feature, write a function, endpoint, component, script, or test",
  "difficult-coding": "Hard implementation: algorithms, concurrency, performance work, security-critical or multi-file changes",
  "long-context": "Work spanning an entire repository, book, transcript, or another very large body of material at once",
  architecture: "System design, trade-off analysis, migration planning, or another high-level structural decision",
  research: "Investigating, surveying, comparing options, or synthesizing sources into an answer",
  debugging: "Finding the cause of a bug, crash, failing test, or behaviour that is already wrong",
  review: "Reviewing or critiquing existing code, a diff, or a proposal; giving a second opinion",
  multimodal: "Work whose subject is an image, screenshot, video, or other non-text medium",
  "office-production": "Producing a business document: report, deck, memo, spreadsheet, or similar deliverable",
};

const MAX_STATE_CHARS = 6_000;
const MAX_CACHE_ENTRIES = 64;

export function jevConfig(env: NodeJS.ProcessEnv = process.env, apiKey?: string): JevConfig {
  const min = Number(env.JEV_MIN_CONFIDENCE);
  const timeout = Number(env.JEV_TIMEOUT_MS);
  return {
    apiKey: (apiKey ?? env.JEV_API_KEY)?.trim() || undefined,
    baseUrl: (env.JEV_BASE_URL?.trim() || "https://api.typesafe.ai/v1").replace(/\/$/, ""),
    model: env.JEV_MODEL?.trim() || "jev-latest",
    minConfidence: Number.isFinite(min) && min >= 0 && min <= 1 ? min : 0.5,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 8_000,
  };
}

export interface JevClassification extends Classification {
  /** Set when Jev answered; the router records it as the classifier of record. */
  jev?: { category: TaskCategory; confidence: number; requiresTools?: boolean; usedFallback: boolean };
}

export class JevDecider {
  private readonly cache = new Map<string, JevClassification>();

  constructor(private readonly config: JevConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.apiKey) && process.env.HARNESS_DECISION_ENGINE !== "off";
  }

  /**
   * Classify a task with Jev, falling back to the keyword heuristic whenever
   * Jev is off, fails, or answers below the confidence floor. Never throws:
   * routing must work offline.
   */
  async classify(task: string, opts: { contextTokens?: number } = {}): Promise<JevClassification> {
    const heuristic = classifyTask(task, opts);
    const state = task.trim().slice(0, MAX_STATE_CHARS);
    if (!this.enabled || !state) return heuristic;

    const cached = this.cache.get(state);
    if (cached) return cached;

    let response: JevResponse;
    try {
      response = await this.ask(state, {
        category: {
          type: "choice",
          instructions: "What kind of work does this request actually require?",
          criteria: CATEGORY_CRITERIA,
        },
        requires_tools: {
          type: "noul",
          instructions: "Answering this request well requires reading, writing, or running something on the user's computer.",
          criteria: {
            true: "The request needs files read or changed, commands run, or tools called",
            false: "The request can be answered with text alone, from knowledge and conversation",
          },
        },
      });
    } catch {
      return heuristic;
    }

    const answer = response.answers?.category;
    if (!answer || answer.type !== "choice" || !(answer.choice in CATEGORY_CRITERIA)) return heuristic;
    const category = answer.choice as TaskCategory;
    const confidence = Number(answer.confidence);
    const tools = response.answers?.requires_tools;
    const toolProbability = tools?.type === "noul" ? Number(tools.noul ?? tools.value) : NaN;
    const requiresTools = Number.isFinite(toolProbability) ? toolProbability >= 0.5 : undefined;

    // A low-confidence pick is worse than the heuristic, but the tool answer is
    // still useful, so it survives the fallback.
    const unsure = !Number.isFinite(confidence) || confidence < this.config.minConfidence;
    const result: JevClassification = unsure
      ? {
        ...heuristic,
        signals: [...heuristic.signals, `jev: "${category}" below the ${this.config.minConfidence} confidence floor`],
        jev: { category, confidence: Number.isFinite(confidence) ? confidence : 0, requiresTools, usedFallback: true },
      }
      : {
        category,
        confidence,
        signals: [`jev: "${category}" at ${confidence.toFixed(2)} confidence`],
        estimatedContextTokens: opts.contextTokens,
        jev: { category, confidence, requiresTools, usedFallback: false },
      };
    this.remember(state, result);
    return result;
  }

  async ask(state: string | object, questions: Record<string, unknown>): Promise<JevResponse> {
    if (!this.config.apiKey) throw new Error("Jev is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: this.config.model, questions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`jev http ${response.status}`);
      return await response.json() as JevResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, value: JevClassification): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}

export const JEV_CATEGORY_CRITERIA = CATEGORY_CRITERIA;

/**
 * One decider per profile. The key comes from the environment first, then the
 * profile's Keychain entry (`harness secret set jev`), matching how every other
 * provider credential resolves.
 */
const deciders = new Map<string, JevDecider>();

/** Drop memoized deciders so a key saved while running takes effect at once. */
export function resetJevDeciders(): void {
  deciders.clear();
}

export function jevDecider(profile: string): JevDecider {
  const existing = deciders.get(profile);
  if (existing) return existing;
  let stored: string | null = null;
  try { stored = new SecretStore(profile).get("jev"); } catch { stored = null; }
  const created = new JevDecider(jevConfig(process.env, stored ?? undefined));
  deciders.set(profile, created);
  return created;
}
