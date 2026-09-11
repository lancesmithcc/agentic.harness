import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type SkillEntry = {
  name: string;
  source: string;
  type: "agent-skill" | "mcp";
  path?: string;
  description?: string;
};

function skillDescription(skillFile: string): string | undefined {
  try {
    const text = readFileSync(skillFile, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      return line.slice(0, 160);
    }
  } catch {
    // unreadable skill file -> no description
  }
  return undefined;
}

function findSkillFile(dir: string): string | undefined {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        return join(dir, entry.name);
      }
    }
  } catch {
    // unreadable directory -> no skill here
  }
  return undefined;
}

function scanAgentSkills(roots: string[]): SkillEntry[] {
  const found = new Map<string, SkillEntry>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let children: Dirent[];
    try {
      children = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const dir = join(root, child.name);
      const skillFile = findSkillFile(dir);
      if (!skillFile) continue;
      const entry: SkillEntry = {
        name: basename(dir),
        source: root,
        type: "agent-skill",
        path: dir,
      };
      const description = skillDescription(skillFile);
      if (description !== undefined) entry.description = description;
      found.set(entry.name, entry); // later roots win on name conflicts
    }
  }
  return [...found.values()];
}

function mcpServerNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const servers = (value as Record<string, unknown>).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  return Object.keys(servers);
}

function scanMcpServers(cwd: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const jsonFiles = [join(homedir(), ".claude.json"), join(cwd, ".mcp.json")];
  for (const file of jsonFiles) {
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      for (const name of mcpServerNames(parsed)) {
        entries.push({ name, source: file, type: "mcp" });
      }
    } catch {
      // parse error -> skip file silently
    }
  }
  const toml = join(homedir(), ".codex", "config.toml");
  if (existsSync(toml)) {
    try {
      const text = readFileSync(toml, "utf8");
      const re = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const name = match[1];
        if (name) entries.push({ name, source: toml, type: "mcp" });
      }
    } catch {
      // unreadable config -> skip
    }
  }
  return entries;
}

export async function scanSkills(opts: { cwd: string; harnessHome: string }): Promise<SkillEntry[]> {
  const roots = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".zcode", "cli", "skills"),
    join(opts.harnessHome, "skills"),
    join(opts.cwd, ".harness", "skills"),
    join(opts.cwd, ".claude", "skills"),
  ];
  return [...scanAgentSkills(roots), ...scanMcpServers(opts.cwd)];
}
