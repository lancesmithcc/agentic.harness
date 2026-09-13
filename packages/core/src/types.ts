/**
 * DeepHarness core types.
 *
 * The universal provider interface (PRD §16): every provider — subscription
 * CLI adapters (Claude Code, Codex), direct API adapters (DeepSeek, Kimi,
 * Z.AI, MiniMax, OpenRouter) and local runtimes (llama.cpp, Ollama) —
 * implements ModelProvider and is interchangeable at the routing layer.
 */

/** A single conversation turn in the provider-neutral session format. */
export interface HarnessMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images attached to the message (base64 or file path) for vision models. */
  images?: string[];
  name?: string;
}

/** A request built by the Context Compiler and handed to a provider. */
export interface HarnessRequest {
  /** Provider-qualified model id, e.g. "zai/glm-5.3-flash". */
  model: string;
  messages: HarnessMessage[];
  /** Max tokens the model may emit. */
  maxTokens?: number;
  temperature?: number;
  /** Provider-native extras merged at the adapter edge (e.g. reasoning effort). */
  options?: Record<string, unknown>;
  /** Who asked: "user" | agent role name ("planner", "reviewer", ...). */
  agentRole?: string;
  /** Human-readable description of the job, used in logs and routing records. */
  taskLabel?: string;
  /** Working folder for agentic adapters (CLI agents run here). */
  cwd?: string;
  /** File/tool autonomy for agentic adapters. Adapters default to "read-only". */
  access?: "read-only" | "workspace" | "full";
  /** Claude-style MCP JSON config file to load (CLI agents). */
  mcpConfig?: string;
  /** Hard ceiling for one call in ms (CLI adapters default to 90s). */
  timeoutMs?: number;
  /** Extra folders agentic adapters may use beyond cwd (self-evolve adds the harness source root). */
  addDirs?: string[];
  /** Cancels this request. Providers must stop their transport and subprocesses. */
  signal?: AbortSignal;
  /** Use the shared agent/tool runtime instead of a direct token stream. */
  tools?: boolean;
  /** Profile namespace for an adapter's isolated runtime state. */
  profile?: string;
}

/** Streaming events emitted by every provider generate() call. */
export type HarnessEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      arguments: string;
    }
  | { type: "tool-result"; id: string; name: string; content: string; isError?: boolean }
  | { type: "usage"; usage: UsageReport }
  | { type: "model-call"; model: string; provider: string; latencyMs: number }
  | { type: "done"; finishReason?: string; text: string }
  | { type: "error"; error: HarnessError; fatal: boolean };

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Monetary cost in USD if computable; omitted for subscription/local. */
  costUsd?: number;
  /** "subscription" | "coding-plan" | "api" | "local" | "unknown" */
  billing?: string;
}

/** Normalized provider failure so the router can apply fallback policy. */
export interface HarnessError extends Error {
  code:
    | "unavailable" // provider down / not installed / not logged in
    | "auth" // bad or missing credential
    | "rate-limit" // 429 / plan quota
    | "context-length" // request exceeds model window
    | "provider-error" // upstream 5xx, malformed response
    | "aborted" // caller cancelled
    | "unknown";
  provider?: string;
  model?: string;
  /** True when a retry against the same provider might succeed. */
  retryable?: boolean;
  status?: number;
}

/** Terminal state for one routed model attempt. */
export type TurnOutcome = "completed" | "interrupted" | "failed";

export interface ModelCapabilities {
  /** 0-10 subjective capability scores; sourced from config, refined over time. */
  coding?: number;
  reasoning?: number;
  summarization?: number;
  vision?: boolean;
  tools?: boolean;
  longContext?: boolean;
  /** Context window in tokens, when known. */
  context?: number;
  local?: boolean;
  /** True when nothing leaves this machine. */
  private?: boolean;
  /** USD per 1M output tokens, when known; 0 for local. */
  cost?: number;
  /** Billing class used by usage-aware routing. */
  billing?: "subscription" | "coding-plan" | "api" | "local";
  /** Model is a thinking/reasoning-first model. */
  thinking?: boolean;
}

export interface Model {
  /** Fully-qualified id: "<provider>/<model>", e.g. "kimi/kimi-for-coding". */
  id: string;
  /** Bare model id as the provider knows it. */
  model: string;
  provider: string;
  /** Display name, e.g. "GLM 5.3 Flash". */
  name?: string;
  capabilities: ModelCapabilities;
}

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  /** e.g. "logged in", "key present", "not installed", "429 quota". */
  detail: string;
  modelsFound?: number;
  checkedAt: string;
}

/**
 * The one interface every provider implements (PRD §16).
 */
export interface ModelProvider {
  readonly id: string;
  readonly kind: "subscription-cli" | "api" | "local";
  models(): Promise<Model[]>;
  capabilities(model: string): ModelCapabilities;
  generate(request: HarnessRequest): AsyncIterable<HarnessEvent>;
  health(): Promise<ProviderHealth>;
}

/** Routing decision emitted by the Task Router (PRD §19). */
export interface RoutingDecision {
  task: string;
  category: TaskCategory;
  selected: string; // qualified model id
  reason: string[];
  fallbacks: string[]; // qualified model ids, in order
  confidence: number; // 0-1
  escalated?: boolean;
  classifiedBy: "heuristic" | "local-model" | "manual-pin" | "delegation-frontmatter";
}

export type TaskCategory =
  | "simple" // summarization, classification, extraction, transforms
  | "general-coding"
  | "difficult-coding"
  | "long-context"
  | "architecture"
  | "research"
  | "debugging"
  | "review"
  | "multimodal"
  | "office-production"
  | "unknown";

/** Session lifecycle events persisted as JSONL (PRD §29). */
export type SessionEvent =
  | { v: 1; ts: string; kind: "session-start"; sessionId: string; profile: string; cwd: string }
  | { v: 1; ts: string; kind: "user-message"; text: string }
  | {
      v: 1;
      ts: string;
      kind: "routing";
      decision: RoutingDecision;
    }
  | { v: 1; ts: string; kind: "model-call"; provider: string; model: string; latencyMs: number }
  /** Durable streamed text. A later assistant-text with this turnId commits it. */
  | { v: 1; ts: string; kind: "assistant-delta"; turnId: string; text: string; provider: string; model: string }
  | { v: 1; ts: string; kind: "assistant-text"; text: string; provider: string; model: string; turnId?: string }
  /** Records a non-successful terminal state so restored history is honest. */
  | { v: 1; ts: string; kind: "turn-outcome"; provider: string; model: string; outcome: Exclude<TurnOutcome, "completed">; error?: string }
  | { v: 1; ts: string; kind: "tool-call"; id: string; name: string; arguments: string; turnId?: string; provider?: string; model?: string }
  | { v: 1; ts: string; kind: "tool-result"; id: string; name: string; content: string; isError?: boolean; turnId: string; provider: string; model: string }
  | { v: 1; ts: string; kind: "usage"; usage: UsageReport; provider: string; model: string }
  | {
      v: 1;
      ts: string;
      kind: "fallback";
      from: string;
      to: string;
      cause: string;
    }
  | { v: 1; ts: string; kind: "artifact"; path: string; note?: string }
  | { v: 1; ts: string; kind: "session-end"; reason: string }
  /** The agent changed the harness's own source this turn (git tree checkpoints before/after). */
  | { v: 1; ts: string; kind: "self-change"; root: string; before: string; after: string; beforeCommit?: string; afterCommit?: string; branch?: string; repoUrl?: string; files: Array<{ status: string; path: string }> }
  | { v: 1; ts: string; kind: "self-revert"; before: string; after: string; reverted: string[]; skipped: string[]; checkpoint?: { beforeCommit?: string; afterCommit?: string; branch?: string; repoUrl?: string } };
