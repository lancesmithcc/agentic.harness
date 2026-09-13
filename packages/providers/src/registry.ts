/**
 * Provider registry: assembles the fleet for a profile from config +
 * secrets, applying capability overrides. This is the single place the
 * rest of the harness obtains ModelProvider instances.
 */
import { loadConfig, resolveSecret, type ProfileConfig } from "@harness/core";
import type { Model, ModelProvider } from "@harness/core";
import { ClaudeCodeProvider } from "./claude-code.ts";
import { CodexProvider } from "./codex.ts";
import { LocalProvider, detectLocalEndpoints, type LocalEndpoint } from "./local.ts";
import { DeepSeekProvider } from "./deepseek.ts";
import { DeepSeekHarnessProvider } from "./deepseek-harness.ts";
import { ZAIProvider } from "./zai.ts";
import { KimiProvider } from "./kimi.ts";
import { MiniMaxProvider } from "./minimax.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { OpenAIProvider } from "./openai.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";
class ConfiguredAPIProvider extends OpenAICompatProvider {}

export interface Fleet {
  profile: string;
  providers: Map<string, ModelProvider>;
  config: ProfileConfig;
}

async function boundedModels(provider: ModelProvider, timeoutMs: number): Promise<Model[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<Model[]>([
      provider.models(),
      new Promise<Model[]>((_, reject) => { timer = setTimeout(() => reject(new Error(`${provider.id} model discovery timed out`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const API_PROVIDER_FACTS: Record<string, { envVar: string; make: (key: string | null) => OpenAICompatProvider }> = {
  deepseek: { envVar: "DEEPSEEK_API_KEY", make: (k) => new DeepSeekProvider(k) },
  zai: { envVar: "ZAICODINGPLAN_KEY", make: (k) => new ZAIProvider(k) },
  kimi: { envVar: "KIMI_API_KEY", make: (k) => new KimiProvider(k) },
  minimax: { envVar: "MINIMAX_API_KEY", make: (k) => new MiniMaxProvider(k) },
  openrouter: { envVar: "OPENROUTER_API_KEY", make: (k) => new OpenRouterProvider(k) },
  openai: { envVar: "OPENAI_KEY", make: (k) => new OpenAIProvider(k) },
};

/** Build against the caller's workspace so .harness provider overrides apply. */
export async function buildFleet(profileName?: string, cwd?: string): Promise<Fleet> {
  const { loadConfig: lc, activeProfileName } = await import("@harness/core");
  const profile = profileName ?? activeProfileName();
  const loaded = lc(profile, cwd);
  const config = loaded.profile;
  const providers = new Map<string, ModelProvider>();

  // Subscription CLI adapters — always present; auth owned by their CLIs.
  providers.set("claude-code", new ClaudeCodeProvider(profile));
  providers.set("codex", new CodexProvider(profile));

  // API providers from profile config (enabled by default if a key resolves).
  for (const [id, facts] of Object.entries(API_PROVIDER_FACTS)) {
    const pc = config.providers[id];
    if (pc && pc.enabled === false) continue;
    const { SecretStore } = await import("@harness/core");
    const apiKey = pc?.apiKey
      ? resolveSecret(pc.apiKey, facts.envVar)
      : (process.env[facts.envVar] ?? new SecretStore(profile).get(id) ?? null);
    if (!apiKey && !pc) continue; // not configured at all
    const provider = facts.make(apiKey);
    if (pc?.baseUrl) provider.configureEndpoint(pc.baseUrl);
    providers.set(id, provider);
  }

  // Explicitly configured OpenAI-compatible endpoints join the same fleet.
  for (const [id, pc] of Object.entries(config.providers)) {
    if (id in API_PROVIDER_FACTS || ["claude-code", "codex", "deepseek-harness", "local"].includes(id) || !pc.enabled || !pc.baseUrl) continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error("Invalid custom provider id");
    const apiKey = pc.apiKey ? resolveSecret(pc.apiKey) : null;
    const seed = Object.fromEntries((pc.models?.include ?? []).map(model => [model, { coding: 6, reasoning: 6 }]));
    providers.set(id, new ConfiguredAPIProvider(id, pc.baseUrl.replace(/\/+$/, ""), { apiKey, billing: "api", capabilitiesSeed: seed }));
  }

  // Dedicated DeepSeek route retains its provider-native SDK adapter. Other
  // APIs use the same SDK execution loop through the pi-ai provider adapter.
  const deepseekHarnessConfig = config.providers["deepseek-harness"];
  if (deepseekHarnessConfig?.enabled !== false) {
    const { SecretStore } = await import("@harness/core");
    const keyRef = deepseekHarnessConfig?.apiKey ?? config.providers.deepseek?.apiKey;
    const deepseekKey = keyRef
      ? resolveSecret(keyRef, "DEEPSEEK_API_KEY")
      : (process.env.DEEPSEEK_API_KEY ?? new SecretStore(profile).get("deepseek-harness") ?? new SecretStore(profile).get("deepseek") ?? null);
    if (deepseekKey || deepseekHarnessConfig) providers.set("deepseek-harness", new DeepSeekHarnessProvider(profile, deepseekKey));
  }

  // Local endpoints: configured ones first, then autodetected.
  const localEndpoints: LocalEndpoint[] = [...(config.local?.endpoints ?? [])];
  const detected = await detectLocalEndpoints();
  for (const d of detected) {
    if (!localEndpoints.some((e) => e.url.replace(/\/$/, "") === d.url.replace(/\/$/, ""))) {
      localEndpoints.push(d);
    }
  }
  if (localEndpoints.length > 0) {
    providers.set("local", new LocalProvider(localEndpoints[0]!));
  }

  return { profile, providers, config };
}

/** Model discovery is best-effort: one bad provider must not stall the UI. */
export async function fleetModels(fleet: Fleet, options: { timeoutMs?: number } = {}): Promise<Model[]> {
  const all: Model[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  await Promise.all(
    [...fleet.providers.values()].map(async (p) => {
      try {
        const models = await boundedModels(p, timeoutMs);
        // Apply capability overrides from profile config.
        const overrides = fleet.config.capabilityOverrides ?? {};
        for (const m of models) {
          const ov = overrides[m.model] ?? overrides[m.id];
          if (ov) m.capabilities = { ...m.capabilities, ...(ov as object) };
          all.push(m);
        }
      } catch {
        // provider unavailable — health() will report it
      }
    }),
  );
  return all;
}
