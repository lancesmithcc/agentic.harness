/**
 * Local-first secrets via macOS Keychain (PRD §26).
 *
 * Logical names: harness/<profile>/<provider>, e.g. harness/home/deepseek.
 * Config files only ever hold references: keychain://harness/home/deepseek
 * or env://DEEPSEEK_API_KEY. Secrets never live in delegation.md, repos,
 * or plaintext config.
 *
 * Claude Code and Codex subscription credentials stay owned by their
 * official clients — this module never touches those.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SERVICE_PREFIX = "harness";

function security(args: string[]): string {
  return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export class SecretStore {
  constructor(private profile: string) {}

  /** Keychain service name for a provider key in this profile. */
  serviceName(provider: string): string {
    return `${SERVICE_PREFIX}/${this.profile}/${provider}`;
  }

  set(provider: string, value: string): void {
    execFileSync(
      "security",
      ["add-generic-password", "-a", "deepharness", "-s", this.serviceName(provider), "-w", value, "-U"],
      { stdio: "ignore" },
    );
  }

  get(provider: string): string | null {
    try {
      const out = security(["find-generic-password", "-a", "deepharness", "-s", this.serviceName(provider), "-w"]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  delete(provider: string): boolean {
    try {
      execFileSync("security", ["delete-generic-password", "-a", "deepharness", "-s", this.serviceName(provider)], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  list(): string[] {
    try {
      const out = security(["dump-keychain"]);
      const names = new Set<string>();
      const re = /"svce"<blob>="harness\/[^"]+"/g;
      for (const m of out.matchAll(re)) {
        const svce = m[0].split('"')[3] ?? "";
        if (svce.startsWith(`${SERVICE_PREFIX}/${this.profile}/`)) {
          names.add(svce.slice(`${SERVICE_PREFIX}/${this.profile}/`.length));
        }
      }
      return [...names].sort();
    } catch {
      return [];
    }
  }
}

/**
 * Resolve a secret reference ("keychain://harness/home/deepseek" or
 * "env://DEEPSEEK_API_KEY") to its value, or null when unavailable.
 * Plain values pass through (discouraged — config lint warns about them).
 */
export function resolveSecret(ref: string | undefined, fallbackEnv?: string): string | null {
  if (!ref) return fallbackEnv ? (process.env[fallbackEnv] ?? null) : null;
  if (ref.startsWith("env://")) return process.env[ref.slice("env://".length)] ?? null;
  if (ref.startsWith("keychain://")) {
    const path = ref.slice("keychain://".length); // harness/<profile>/<provider>
    const parts = path.split("/");
    if (parts.length !== 3) return null;
    const store = new SecretStore(parts[1]!);
    return store.get(parts[2]!);
  }
  if (ref.startsWith("file://")) {
    try {
      return readFileSync(ref.slice("file://".length), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  return ref; // plaintext passthrough
}
