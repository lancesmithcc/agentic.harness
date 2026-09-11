/**
 * Task classifier (PRD §19 inputs). Keyword heuristic first; a local model
 * (Gemma) can be asked to refine ambiguous cases — cheap, private routing
 * assistance per PRD §15.
 */
import type { TaskCategory } from "@harness/core";

export interface Classification {
  category: TaskCategory;
  confidence: number;
  signals: string[];
  /** Estimated useful context in tokens (heuristic). */
  estimatedContextTokens?: number;
}

interface Rule {
  category: TaskCategory;
  weight: number;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "simple",
    weight: 1,
    patterns: [
      /\bsummar(y|ize|ise)\b/i, /\btl;?dr\b/i, /\bclassif(y|ication)\b/i, /\bextract\b/i,
      /\btag(ging)?\b/i, /\btranscrib/, /\bdiariz/, /\bcleanup\b/i, /\brename\b/i,
      /\bsimple transform/i, /\blist\b.*\bfiles?\b/i,
    ],
  },
  {
    category: "debugging",
    weight: 2,
    patterns: [/\bdebug\b/i, /\bfix (this|the) (bug|error|failure|crash)/i, /\bstack ?trace\b/i, /\broot ?cause\b/i, /\bwhy (is|does|did)/i, /\bnot working\b/i, /\btest.{0,20}fail/i, /\bflaky\b/i],
  },
  {
    category: "architecture",
    weight: 2,
    patterns: [/\barchitect/i, /\bdesign (the|a) (system|api|schema|service)/i, /\brefactor (the )?(whole|entire|authentication|system)/i, /\bmigration plan/i, /\bdecompos/i, /\bhigh[- ]level (plan|design)/i, /\btrade[- ]?offs?\b/i, /\bdecide between\b/i],
  },
  {
    category: "long-context",
    weight: 2,
    patterns: [/\b(whole|entire|all) (repo|repository|codebase|code base)\b/i, /\bevery file\b/i, /\bcross[- ]?(repo|file|document)\b/i, /\bentire (book|transcript|log)/i, /\bmillion tokens?\b/i, /\bhuge (context|source set)/i],
  },
  {
    category: "research",
    weight: 1.5,
    patterns: [/\bresearch\b/i, /\bsurvey\b/i, /\bcompare .*(vs|versus|against)\b/i, /\bliterature\b/i, /\bsources?\b.*\bsynthes/i, /\bdeep dive\b/i, /\bscientific\b/i],
  },
  {
    category: "review",
    weight: 1.5,
    patterns: [/\b(code )?review\b/i, /\breview (this|the) (patch|diff|pr|code)\b/i, /\bverify (the|this) (implementation|change)/i, /\bsecond opinion\b/i, /\bcritique\b/i],
  },
  {
    category: "multimodal",
    weight: 2,
    patterns: [/\bimage(s)?\b/i, /\bscreenshot/i, /\bvideo\b/i, /\brender(ing)?\b/i, /\bvisual\b/i, /\bfigure\b/i, /\.(png|jpe?g|webp|gif|mp4|mov)\b/i],
  },
  {
    category: "office-production",
    weight: 1.5,
    patterns: [/\b(ms ?word|word docs?|excel|powerpoint|ppt|docx|xlsx|pptx|spreadsheet)\b/i, /\breport draft/i, /\bdeck\b/i, /\bmemo\b/i, /\bbusiness deliverable/i],
  },
  {
    category: "difficult-coding",
    weight: 1.5,
    patterns: [/\brefactor\b/i, /\bimplement (the )?(auth|authentication|engine|compiler|parser|runtime)/i, /\balgorithm\b/i, /\boptimiz/i, /\bconcurren(t|cy)\b/i, /\bdistributed\b/i, /\bsecurity[- ]critical/i, /\bhard\b.*\bbug\b/i, /\bmulti[- ]file\b/i],
  },
  {
    category: "general-coding",
    weight: 1,
    patterns: [/\b(build|write|add|create|implement) .*(feature|function|endpoint|component|script|module|test)/i, /\bcode\b/i, /\bapi\b/i, /\bfunction\b/i, /\bbug\b/i, /\btypescript|\bpython|\breact|\bnode\b/i],
  },
];

export function classifyTask(task: string, opts: { contextTokens?: number } = {}): Classification {
  const scores = new Map<TaskCategory, number>();
  const signals: string[] = [];
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(task)) {
        scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
        signals.push(`"${p.source}" → ${rule.category}`);
      }
    }
  }
  if (opts.contextTokens && opts.contextTokens > 150_000) {
    scores.set("long-context", (scores.get("long-context") ?? 0) + 3);
    signals.push(`context ~${Math.round(opts.contextTokens / 1000)}k tokens → long-context`);
  }

  let category: TaskCategory = "unknown";
  let top = 0;
  let second = 0;
  for (const [cat, s] of scores) {
    if (s > top) {
      second = top;
      top = s;
      category = cat;
    } else if (s > second) second = s;
  }
  const confidence = top === 0 ? 0.2 : Math.min(0.95, 0.45 + (top - second) * 0.18 + Math.min(top, 4) * 0.05);
  return { category, confidence, signals, estimatedContextTokens: opts.contextTokens };
}
