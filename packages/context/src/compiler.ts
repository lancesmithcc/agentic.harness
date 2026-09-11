/**
 * Context Compiler (PRD §30): builds only the context each model needs.
 * Gathers user request, delegation rules, relevant files, recent
 * conversation, git diff, skill instructions and agent role — then trims
 * irrelevant material instead of dumping full history into every call.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, extname } from "node:path";
import type { HarnessMessage, Model } from "@harness/core";

export interface ContextOptions {
  cwd: string;
  /** Provider-neutral conversation history. */
  history: Array<{ role: "user" | "assistant"; content: string; model?: string }>;
  /** Include `git diff` + status snapshot. */
  includeGit?: boolean;
  /** Include up to N recent session events as compact transcript. */
  recentTurns?: number;
  /** Max chars of file content to include per file. */
  maxFileChars?: number;
  /** Optional skill instructions to inject. */
  skillInstructions?: string[];
  /** Agent role for multi-agent jobs (planner/developer/reviewer/...). */
  agentRole?: string;
  agentGoal?: string;
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".kt", ".sql", ".sh", ".toml",
  ".yaml", ".yml", ".json", ".md",
]);

function safeRun(cmd: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Heuristic file relevance: mentions in the request, recency, code-ness. */
export function pickRelevantFiles(request: string, cwd: string, limit = 6): string[] {
  const words = new Set(
    request.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2 && !CODE_EXTS.has(w)),
  );
  const out: Array<{ path: string; score: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length > 400) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "target") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (CODE_EXTS.has(extname(e.name))) {
        let score = 0;
        const rel = full.slice(cwd.length + 1);
        for (const w of words) if (rel.toLowerCase().includes(w)) score += 5;
        try {
          const st = statSync(full);
          if (Date.now() - st.mtimeMs < 1000 * 60 * 60 * 24) score += 2; // touched today
          if (st.size > 400_000) score -= 3; // huge files are usually locks/minified
        } catch {
          continue;
        }
        if (score > 0) out.push({ path: rel, score });
      }
    }
  };
  walk(cwd, 0);
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((f) => f.path);
}

export function compileContext(request: string, target: Model, opts: ContextOptions): HarnessMessage[] {
  const messages: HarnessMessage[] = [];
  const maxFileChars = opts.maxFileChars ?? 4000;
  const systemParts: string[] = [];

  if (opts.agentRole) {
    systemParts.push(
      `You are the "${opts.agentRole}" agent in a multi-model harness. ${opts.agentGoal ?? ""}`.trim(),
    );
  }

  // Delegation-aware behavior hint based on target capability class.
  if (target.capabilities.local) {
    systemParts.push("You are a local preprocessing model: be concise and factual; do not attempt complex engineering judgment.");
  }

  // Project grounding.
  const gitStatus = opts.includeGit !== false ? safeRun("git", ["status", "--short"], opts.cwd) : null;
  if (gitStatus) {
    const diff = safeRun("git", ["diff", "--stat"], opts.cwd) ?? "";
    systemParts.push(`Project git state:\n${gitStatus.slice(0, 2000)}\n${diff.slice(0, 1000)}`);
  }

  // Relevant files (small excerpts only).
  const files = pickRelevantFiles(request, opts.cwd);
  if (files.length) {
    const excerpts: string[] = [];
    for (const rel of files) {
      const abs = join(opts.cwd, rel);
      if (!existsSync(abs)) continue;
      try {
        const text = readFileSync(abs, "utf8").slice(0, maxFileChars);
        excerpts.push(`--- ${rel} ---\n${text}`);
      } catch {
        // binary or unreadable
      }
    }
    if (excerpts.length) systemParts.push(`Possibly relevant project files:\n${excerpts.join("\n\n")}`);
  }

  for (const s of opts.skillInstructions ?? []) systemParts.push(s);

  if (systemParts.length) messages.push({ role: "system", content: systemParts.join("\n\n") });

  // Recent conversation, trimmed per model context budget.
  const budget = target.capabilities.context ?? 128_000;
  const perTurn = 1200;
  const turns = Math.max(0, Math.min(opts.recentTurns ?? 8, Math.floor((budget * 0.25) / perTurn)));
  for (const m of opts.history.slice(-turns)) {
    messages.push({ role: m.role, content: m.content });
  }

  messages.push({ role: "user", content: request });
  return messages;
}
