import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";
let mod!: typeof import("./config.ts");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dh-"));
  process.env.HARNESS_HOME = home;

  writeFileSync(join(home, "config.toml"), `[profile]\nname = "g"\n`);
  mkdirSync(join(home, "profiles", "home"), { recursive: true });
  writeFileSync(
    join(home, "profiles", "home", "profile.toml"),
    `[providers.deepseek]\napi_key = "keychain://harness/home/deepseek"\n`,
  );
  mkdirSync(join(home, "project", ".harness"), { recursive: true });
  writeFileSync(join(home, "project", ".harness", "config.toml"), `[defaults]\nmodel = "kimi/k3"\n\n[providers.deepseek]\nenabled = false\n`);

  mod = await import("./config.ts");
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  test("deepMerge merges nested objects", () => {
    const r = mod.deepMerge(
      { a: { b: 1, c: 2 }, x: 1 },
      { a: { c: 3, d: 4 }, y: 2 },
    );
    expect(r).toEqual({ a: { b: 1, c: 3, d: 4 }, x: 1, y: 2 });
  });

  test("ProfileConfigSchema normalizes snake_case api_key and defaults enabled to true", () => {
    const parsed: any = mod.ProfileConfigSchema.parse({
      profile: { name: "t" },
      providers: { deepseek: { api_key: "keychain://harness/home/deepseek" } },
    });
    expect(parsed.providers.deepseek.apiKey).toBe("keychain://harness/home/deepseek");
    expect(parsed.providers.deepseek.enabled).toBe(true);
  });

  test("ProfileConfigSchema.parse({}) defaults policy to normal", () => {
    const parsed: any = mod.ProfileConfigSchema.parse({});
    expect(parsed.profile.policy).toBe("normal");
  });

  test("loadConfig merges project defaults", () => {
    const cfg: any = mod.loadConfig("home", join(home, "project"));
    expect(cfg.profile.defaults.model).toBe("kimi/k3");
    expect(cfg.profile.providers.deepseek.enabled).toBe(false);
    expect(cfg.projectDir.endsWith(".harness")).toBe(true);
  });
});
