/**
 * delegation.md parser (PRD §18) — the philosophical center of the harness.
 *
 * Two supported shapes, in one document:
 *
 * 1. YAML front matter with an explicit routing map:
 *    ---
 *    local_first: true
 *    max_parallel_agents: 5
 *    routing:
 *      architecture: [claude, codex, kimi-k3]
 *      implementation: [deepseek, kimi-k3, zai]
 *      simple: [gemma-local]
 *    ---
 *
 * 2. Human-readable rows (TSV like the live delegation.md, or a markdown
 *    pipe table):
 *    Model <tab> ⭐ Role <tab> Best For <tab> Avoid For
 *
 * Both shapes are optional and combinable; prose between them is ignored.
 */
import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskCategory } from "@harness/core";

export interface DelegationRow {
  /** Display name as written, e.g. "GLM-5.3 Flash". */
  model: string;
  starred: boolean;
  role: string;
  bestFor: string[];
  avoidFor: string[];
}

export interface DelegationDoc {
  frontmatter: {
    localFirst?: boolean;
    maxParallelAgents?: number;
    /** Category -> ordered list of model references (display names or ids). */
    routing: Partial<Record<TaskCategory, string[]>>;
    escalation?: string[];
  } | null;
  rows: DelegationRow[];
  sourcePath: string;
}

const CATEGORY_KEYS: Record<string, TaskCategory> = {
  simple: "simple",
  summarize: "simple",
  summarization: "simple",
  "general-coding": "general-coding",
  general: "general-coding",
  implementation: "general-coding",
  coding: "general-coding",
  "difficult-coding": "difficult-coding",
  difficult: "difficult-coding",
  hard: "difficult-coding",
  "long-context": "long-context",
  longcontext: "long-context",
  architecture: "architecture",
  research: "research",
  debugging: "debugging",
  debug: "debugging",
  review: "review",
  verification: "review",
  multimodal: "multimodal",
  vision: "multimodal",
  "office-production": "office-production",
  office: "office-production",
};

function splitList(cell: string): string[] {
  return cell
    .split(/[,;]|\band\b|\bor\b/i)
    .map((s) => s.trim().replace(/^[-*•]/, "").trim())
    .filter((s) => s.length > 1);
}

function cleanRole(cell: string): { role: string; starred: boolean } {
  const starred = cell.includes("⭐");
  const role = cell.replace(/⭐/g, "").replace(/\*\*/g, "").trim();
  return { role, starred };
}

/** Parse table rows out of a line-oriented buffer, TSV or markdown pipes. */
function parseRows(text: string): DelegationRow[] {
  const rows: DelegationRow[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    // markdown pipe table: | Model | Role | Best | Avoid |
    const isPipe = line.startsWith("|") && line.endsWith("|");
    // TSV: at least 3 tabs
    const tabs = line.split("\t");
    const cells = isPipe
      ? line.slice(1, -1).split("|").map((c) => c.trim())
      : tabs.length >= 3
        ? tabs.map((c) => c.trim())
        : null;
    if (!cells || cells.length < 3) continue;
    // Skip markdown separator rows like |---|---|
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const model = cells[0]!.replace(/\*\*/g, "").trim();
    if (!model || /^(model|name)$/i.test(model)) continue;
    const { role, starred } = cleanRole(cells[1] ?? "");
    rows.push({
      model,
      starred,
      role,
      bestFor: splitList(cells[2] ?? ""),
      avoidFor: splitList(cells[3] ?? ""),
    });
  }
  return rows;
}

export function parseDelegation(text: string, sourcePath = "delegation.md"): DelegationDoc {
  let frontmatter: DelegationDoc["frontmatter"] = null;
  let body = text;

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    try {
      const parsed = parseYaml(fm[1] ?? "") as Record<string, unknown>;
      const routingRaw = (parsed.routing ?? {}) as Record<string, unknown>;
      const routing: Partial<Record<TaskCategory, string[]>> = {};
      for (const [k, v] of Object.entries(routingRaw)) {
        const cat = CATEGORY_KEYS[k.toLowerCase()];
        if (cat && Array.isArray(v)) routing[cat] = v.map(String);
      }
      frontmatter = {
        localFirst: typeof parsed.local_first === "boolean" ? parsed.local_first : undefined,
        maxParallelAgents: typeof parsed.max_parallel_agents === "number" ? parsed.max_parallel_agents : undefined,
        routing,
        escalation: Array.isArray(parsed.escalation) ? (parsed.escalation as string[]).map(String) : undefined,
      };
      body = fm[2] ?? "";
    } catch {
      // malformed front matter: fall through, parse body only
      body = text;
    }
  }

  return { frontmatter, rows: parseRows(body), sourcePath };
}

/** Load delegation.md with the precedence: project .harness/ → profile → global. */
export function findDelegationDoc(
  projectDir: string | null,
  harnessHome: string,
  profile: string,
): { path: string; text: string } | null {
  const candidates = [
    projectDir ? join(projectDir, "delegation.md") : null,
    join(harnessHome, "profiles", profile, "delegation.md"),
    join(harnessHome, "delegation.md"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, text: readFileSync(p, "utf8") };
  }
  return null;
}
