import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

export type ToolEntry = {
  name: string;
  path: string;
  version?: string;
  available: boolean;
};

const TOOL_NAMES: string[] = [
  "git",
  "gh",
  "node",
  "bun",
  "npm",
  "python3",
  "pip3",
  "ffmpeg",
  "ffprobe",
  "magick",
  "convert",
  "docker",
  "colima",
  "claude",
  "codex",
  "opencode",
  "ollama",
  "curl",
  "jq",
  "sqlite3",
  "rg",
  "fzf",
  "playwright",
];

function pathDirs(): string[] {
  const raw = process.env.PATH ?? "";
  return raw.split(delimiter).filter((dir) => dir.length > 0);
}

function findExecutable(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable / missing -> keep looking
    }
  }
  return undefined;
}

function runFlag(bin: string, flag: string): string | undefined {
  try {
    const res = spawnSync(bin, [flag], {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.error) return undefined;
    const out = res.stdout ?? "";
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) return line.slice(0, 80);
    }
  } catch {
    // never fail the scan on version errors
  }
  return undefined;
}

function readVersion(bin: string): string | undefined {
  return runFlag(bin, "--version") ?? runFlag(bin, "-v");
}

export async function scanTools(): Promise<ToolEntry[]> {
  const dirs = pathDirs();
  const entries: ToolEntry[] = [];
  for (const name of TOOL_NAMES) {
    const resolved = findExecutable(name, dirs);
    const entry: ToolEntry = {
      name,
      path: resolved ?? "",
      available: resolved !== undefined,
    };
    if (resolved !== undefined) {
      const version = readVersion(resolved);
      if (version !== undefined) entry.version = version;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}
