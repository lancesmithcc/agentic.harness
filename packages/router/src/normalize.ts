/**
 * Model name normalization: delegation.md speaks in human names
 * ("GLM-5.3 Flash", "Kimi K3", "Gemma 4 12B"); the fleet speaks in
 * qualified ids ("zai/glm-5.3-flash", "kimi/k3", "local/gemma-4-12b-it").
 */
import type { Model } from "@harness/core";

/** Normalize to a comparison key: lowercase, alphanumerics only. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Known alias seeds so common display names resolve even before discovery.
 * Values are qualified ids that must exist in the fleet to be used.
 */
const SEED_ALIASES: Array<[RegExp, string]> = [
  [/^claude(code|subscription)?$/, "claude-code/default"],
  [/^gpt5(5|5codex)?$/, "codex/gpt-5.5"],
  [/^codex$/, "codex/default"],
  [/^glm53flash$/, "zai/glm-5.3-flash"],
  [/^glm53$/, "zai/glm-5.3"],
  [/^deepseekv4\.?1?flash$/, "deepseek/deepseek-flash"],
  [/^deepseekv41flash$/, "deepseek/deepseek-flash"],
  [/^deepseekflash$/, "deepseek/deepseek-flash"],
  [/^deepseekv4pro$/, "deepseek/deepseek-v4-pro"],
  [/^kimik3(256k)?$/, "kimi/k3"],
  [/^kimi(k2)?coding$/, "kimi/kimi-for-coding"],
  [/^minimaxm3$/, "minimax/MiniMax-M3"],
  [/^minimaxm2\.?7$/, "minimax/MiniMax-M2.7"],
  // M2.6 was retired 2026-07; its documented successor is M2.7.
  [/^minimaxm26$/, "minimax/MiniMax-M2.7"],
  [/^gemma412b(it)?$/, "local/gemma-4-12b-it"],
  [/^gemma(local)?$/, "local/gemma-4-12b-it"],
  [/^openrouter$/, "openrouter/auto"],
  [/^gpt56sol$/, "codex/gpt-5.6-sol"],
  [/^gpt56terra$/, "codex/gpt-5.6-terra"],
  [/^gpt56luna$/, "codex/gpt-5.6-luna"],
  [/^claudeopus5$/, "claude-code/opus-5"],
  [/^gpt6astra$/, "codex/gpt-6-astra"],
];

function scoreMatch(nameKey: string, model: Model): number {
  const idKey = key(model.id);
  const bareKey = key(model.model);
  if (nameKey === idKey) return 100;
  if (nameKey === bareKey) return 90;
  if (idKey.includes(nameKey) || nameKey.includes(idKey)) return 60;
  if (bareKey.includes(nameKey) || nameKey.includes(bareKey)) return 50;
  // token overlap: "kimik3" vs "kimi/k3" -> tokens kimi, k3
  const toks = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !/^(the|model|pro|v\d)$/i.test(t));
  const a = new Set(toks(nameKey));
  const b = new Set(toks(model.model));
  const provider = toks(model.provider);
  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) overlap += 2;
    else if (provider.includes(t)) overlap += 1;
  }
  return overlap >= 3 ? 30 + overlap : overlap > 0 ? 10 + overlap : 0;
}

/**
 * Resolve a delegation.md model reference to a fleet model id.
 * Returns the best match above threshold, else null.
 */
export function resolveModelRef(ref: string, models: Model[]): Model | null {
  const k = key(ref);
  for (const [re, id] of SEED_ALIASES) {
    if (re.test(k)) {
      const hit = models.find((m) => m.id === id);
      if (hit) return hit;
    }
  }
  let best: Model | null = null;
  let bestScore = 0;
  for (const m of models) {
    const s = scoreMatch(k, m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return bestScore >= 30 ? best : null;
}
