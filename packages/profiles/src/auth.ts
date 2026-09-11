/**
 * Profile operations: switching, isolated subscription logins (PRD §5, §8, §9).
 *
 * `harness auth claude` / `harness auth codex` launch the official CLIs'
 * interactive login with the profile-isolated environment variables set —
 * the harness never touches auth files or tokens itself.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_HOME } from "@harness/core";

export interface ProfileInfo {
  name: string;
  exists: boolean;
  path: string;
  hasClaudeConfig: boolean;
  hasCodexHome: boolean;
}

export function profileInfo(name: string): ProfileInfo {
  const path = join(HARNESS_HOME, "profiles", name);
  return {
    name,
    exists: existsSync(path),
    path,
    hasClaudeConfig: existsSync(join(path, "claude")),
    hasCodexHome: existsSync(join(path, "codex")),
  };
}

/**
 * Run an interactive login for a subscription provider inside the profile's
 * isolated environment. Resolves when the child exits.
 */
export function loginSubscription(
  provider: "claude" | "codex",
  profile: string,
): Promise<number> {
  const home = join(HARNESS_HOME, "profiles", profile);
  if (!existsSync(home)) mkdirSync(home, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  let command: string;
  let args: string[];
  if (provider === "claude") {
    env.CLAUDE_CONFIG_DIR = join(home, "claude");
    command = "claude";
    args = ["/login"];
  } else {
    env.CODEX_HOME = join(home, "codex");
    command = "codex";
    args = ["login"];
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => {
      console.error(`${command} CLI not found. Install it first.`);
      resolve(1);
    });
  });
}
