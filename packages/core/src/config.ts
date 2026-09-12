/**
 * Configuration loading with the precedence chain (PRD §28):
 *   project rules (.harness/) → profile rules → global rules (~/.deepharness/)
 */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Resolve at the storage boundary so isolated callers can supply a home. */
export function getHarnessHome(): string {
  return process.env.HARNESS_HOME ?? join(homedir(), ".deepharness");
}
// Legacy path remains compatible; the product identity is agentic.harness.
export const HARNESS_HOME = getHarnessHome();

export const SecretRefSchema = z.string().refine((s) => s.startsWith("keychain://") || s.startsWith("env://"), {
  message: "secret must be keychain://<name> or env://<NAME>",
});

/** Accept both camelCase and TOML-style snake_case keys. */
const normalizeKeys = z.preprocess((obj) => {
  if (obj === null || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  if ("api_key" in out && !("apiKey" in out)) out.apiKey = out.api_key;
  if ("base_url" in out && !("baseUrl" in out)) out.baseUrl = out.base_url;
  return out;
}, z.object({
  enabled: z.boolean().default(true),
  apiKey: SecretRefSchema.optional(),
  baseUrl: z.string().url().optional(),
  models: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      discovery: z.enum(["automatic", "manual"]).default("automatic"),
    })
    .partial()
    .optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}));

export const ProviderConfigSchema = normalizeKeys;

export const LocalEndpointSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  model: z.string().optional(),
  kind: z.enum(["ollama", "llamacpp", "lmstudio", "mlx", "openai-compat"]).optional(),
});

export const ProfileConfigSchema = z.object({
  profile: z
    .object({
      name: z.string().default("unknown"),
      description: z.string().optional(),
      /** "strict" | "normal" tool permission policy (PRD §25). */
      policy: z.enum(["strict", "normal"]).default("normal"),
    })
    .default({ name: "unknown", policy: "normal" }),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  local: z
    .object({
      endpoints: z.array(LocalEndpointSchema).default([]),
    })
    .default({ endpoints: [] }),
  /** Model preferences: qualified ids, e.g. ["zai/glm-5.3-flash"]. */
  defaults: z
    .object({
      model: z.string().optional(),
      delegationPath: z.string().optional(),
    })
    .partial()
    .optional(),
  capabilityOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

function readTomlOrYaml(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".toml")) return parseToml(text) as Record<string, unknown>;
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return parseYaml(text) as Record<string, unknown>;
  return null;
}

/** Deep-merge b over a (b wins), plain-object recursion. */
export function deepMerge<T>(a: T, b: unknown): T {
  if (b === undefined) return a;
  if (a === null || typeof a !== "object" || Array.isArray(a)) return b as T;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b as T;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface LoadedConfig {
  global: ProfileConfig | null;
  profile: ProfileConfig;
  profileName: string;
  project: Record<string, unknown> | null;
  projectDir: string | null;
}

/**
 * Load config for a profile with project-level overrides merged last.
 * Throws ZodError with a readable message when a config file is invalid.
 */
export function loadConfig(profileName: string, cwd = process.cwd()): LoadedConfig {
  const globalRaw = readTomlOrYaml(join(HARNESS_HOME, "config.toml"));
  const global = globalRaw ? ProfileConfigSchema.parse(globalRaw) : null;

  const profilePath = join(HARNESS_HOME, "profiles", profileName, "profile.toml");
  const profileRaw = readTomlOrYaml(profilePath);
  const profile = ProfileConfigSchema.parse(
    global && profileRaw ? deepMerge(global, profileRaw) : (profileRaw ?? global ?? {}),
  );
  // Name always comes from the directory, not the file.
  profile.profile.name = profileName;

  // Project config: walk up from cwd looking for .harness/config.{toml,yaml,yml}
  let dir = resolve(cwd);
  let project: Record<string, unknown> | null = null;
  let projectDir: string | null = null;
  for (;;) {
    const configDir = join(dir, ".harness");
    const found = ["config.toml", "config.yaml", "config.yml"].find((f) => existsSync(join(configDir, f)));
    if (found) {
      project = readTomlOrYaml(join(configDir, found));
      projectDir = configDir;
      break;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  if (project) {
    // Project overrides only touch defaults/providers/local today.
    const merged = deepMerge(profile, project);
    return { global, profile: ProfileConfigSchema.parse(merged), profileName, project, projectDir };
  }
  return { global, profile, profileName, project: null, projectDir: null };
}

export function ensureHarnessHome(): void {
  for (const p of [
    HARNESS_HOME,
    join(HARNESS_HOME, "profiles", "home"),
    join(HARNESS_HOME, "profiles", "work"),
    join(HARNESS_HOME, "skills"),
    join(HARNESS_HOME, "tools"),
    join(HARNESS_HOME, "logs"),
  ]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/** The active profile: env var beats state file. */
export function activeProfileName(): string {
  const env = process.env.HARNESS_PROFILE;
  if (env === "home" || env === "work") return env;
  const stateFile = join(HARNESS_HOME, "active-profile");
  if (existsSync(stateFile)) {
    const name = readFileSync(stateFile, "utf8").trim();
    if (name === "home" || name === "work") return name;
  }
  return "home";
}

export function setActiveProfileName(name: string): void {
  if (name !== "home" && name !== "work") throw new Error(`unknown profile: ${name}`);
  ensureHarnessHome();
  writeFileSync(join(HARNESS_HOME, "active-profile"), name, "utf8");
}
