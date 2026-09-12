/**
 * Self-knowledge: a compact description of agentic.harness itself — what it is, what it can do,
 * where its source lives and how that source is laid out — added to every session so the
 * agent can explain itself and, when Settings → Self-evolve is on, change its own code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, extname, join } from "node:path";

export interface SelfState {
  /** Monorepo root of the harness source, or null when this runtime has no source (compiled app). */
  sourceRoot: string | null;
  profile: string;
  workspace: string;
  access: "read-only" | "workspace" | "full";
  selfEvolve: boolean;
  client: "web" | "cli" | "desktop";
}

/**
 * True only for an explicit request to modify agentic.harness itself. The web
 * server uses this to make the source tree the native agent workspace while
 * preserving the selected access mode; ordinary project work stays in its
 * configured workspace.
 */
export function selfEvolutionIntent(task: string): boolean {
  const text = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/\bself[ -]?evolve\b/.test(text)) return true;
  if (/\b(?:rewrite|change|edit|update|fix|repair|refactor|implement|reorganize)\s+(?:your\s+(?:own\s+)?(?:code|source)|own\s+source|agentic\.harness(?:\s+(?:ui|server|app|code|source))?|the\s+harness)\b/.test(text)) return true;
  return /\b(?:create|delete|rewrite|change|edit|update|fix|repair|refactor|implement|reorganize)\b/.test(text)
    && /\b(?:yourself|your\s+own\s+(?:code|source)|own\s+source|self|harness|agentic\.harness)\b/.test(text);
}

/** Walk up from `start` to the agentic.harness monorepo root (package.json named "deepharness"). */
export function findSourceRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "agentic.harness" || pkg.name === "deepharness") return dir;
    } catch {
      // no package.json at this level
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Stable one-liners for the files an agent most often needs; others fall back to their header comment. */
const DESCRIBE: Record<string, string> = {
  "apps/web/src/server.ts": "web server: HTTP API + SSE chat (/api/ask), settings, logins, soul.md, routines + heartbeat scheduler, uploads/artifacts, Tools & MCP registry, self-evolve checkpoints",
  "apps/web/index.html": "the entire web UI (vanilla JS): chat, attachments, artifacts, routines, settings, tools pages",
  "apps/web/brand.css": "design system and all UI styling (agentic brand, light and dark)",
  "apps/cli/src/index.ts": "`harness` CLI commands (ask, status, profile, auth, usage, session)",
  "apps/cli/src/orchestrator.ts": "askRouted: one routed call with the fallback chain; multi-agent pipeline",
  "apps/desktop/src-tauri/src/main.rs": "agentic.harness macOS app shell (Tauri): splash, starts or reuses harness-server, downloads, external links",
  "packages/context/src/compiler.ts": "builds each model's messages: soul.md, self-knowledge, git state, relevant files, trimmed history",
  "packages/context/src/self.ts": "this self-knowledge block and the source-map generator",
  "packages/core/src/types.ts": "shared types: HarnessRequest, streaming events, model capabilities, session events",
  "packages/core/src/config.ts": "HARNESS_HOME, profiles and config precedence",
  "packages/core/src/secrets.ts": "macOS Keychain secrets",
  "packages/providers/src/registry.ts": "assembles the provider fleet for a profile",
  "packages/providers/src/deepseek-harness.ts": "official DeepSeek Harness SDK adapter (Node bridge, scoped permissions, MCP patches)",
  "packages/providers/runtime/deepseek-bridge.mjs": "Node-side DeepSeek SDK bridge: streamed events, local MCP-to-Cordis patch translation",
  "packages/providers/src/claude-code.ts": "Claude Code CLI adapter (subscription; permission modes, --add-dir, MCP config)",
  "packages/providers/src/codex.ts": "Codex CLI adapter (ChatGPT subscription; sandbox modes)",
  "packages/providers/src/openai-compat.ts": "streaming client shared by OpenAI-compatible APIs (reasoning and <think> splitting)",
  "packages/providers/src/local.ts": "local models: llama.cpp, Ollama, LM Studio, MLX",
  "packages/router/src/router.ts": "task router: capability scoring, delegation rules, fallbacks",
  "packages/router/src/delegation.ts": "delegation.md parser",
  "packages/router/src/classify.ts": "task classifier",
  "packages/sessions/src/store.ts": "session event log (JSONL) and usage records",
  "packages/skills/src/scan.ts": "discovers agent skills and MCP servers",
  "packages/tools/src/scan.ts": "discovers CLI tools on PATH",
  "packages/profiles/src/auth.ts": "profile switching and isolated subscription logins",
};

function listSource(root: string): string[] {
  const out: string[] = [];
  const addFile = (rel: string) => {
    try {
      if (statSync(join(root, rel)).isFile()) out.push(rel);
    } catch {
      // not present in this checkout
    }
  };
  const addDir = (relDir: string, exts: string[]) => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && exts.includes(extname(e.name)) && !/\.test\.|\.d\.ts$/.test(e.name)) out.push(`${relDir}/${e.name}`);
    }
  };
  addFile("apps/web/index.html");
  addFile("apps/web/brand.css");
  addDir("apps/web/src", [".ts"]);
  addDir("apps/cli/src", [".ts"]);
  addDir("apps/desktop/src-tauri/src", [".rs"]);
  let packages: Dirent[] = [];
  try {
    packages = readdirSync(join(root, "packages"), { withFileTypes: true });
  } catch {
    // no packages folder
  }
  for (const p of packages) if (p.isDirectory()) addDir(`packages/${p.name}/src`, [".ts"]);
  return out.sort();
}

function headerLine(text: string): string {
  for (const line of text.split("\n").slice(0, 12)) {
    const m = line.match(/^\s*(?:\/\*\*|\*|\/\/)\s*(.+?)\s*(?:\*\/)?$/);
    if (m && m[1] && /[A-Za-z]{3}/.test(m[1]) && !m[1].startsWith("FILE:")) return m[1].slice(0, 120);
  }
  return "";
}

const mapCache = new Map<string, { at: number; text: string }>();

/** One line per source file (path, size, purpose). Cached for a minute so every turn stays cheap. */
export function sourceMap(root: string): string {
  const hit = mapCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.text;
  const lines: string[] = [];
  for (const rel of listSource(root)) {
    let text = "";
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const count = text.split("\n").length;
    if (count < 6) continue; // barrel re-exports
    const what = DESCRIBE[rel] ?? headerLine(text);
    lines.push(`- ${rel} (${count} lines)${what ? ` — ${what}` : ""}`);
  }
  const out = lines.join("\n");
  mapCache.set(root, { at: Date.now(), text: out });
  return out;
}

const CLIENT_NAMES: Record<SelfState["client"], string> = {
  web: "the web UI (Bun server in apps/web)",
  cli: "the `harness` CLI (apps/cli)",
  desktop: "the agentic.harness macOS app (Tauri shell running the compiled web server)",
};

export function buildSelfKnowledge(state: SelfState): string {
  const applyTiming = state.client === "desktop"
    ? `This is the packaged desktop app: source edits do not change the running UI, server, providers, or native shell. Rebuild and install the desktop bundle using apps/desktop/README.md, then relaunch the app for every source change to take effect.`
    : `This is a source-run client: apps/web/index.html and brand.css take effect after page reload; server, provider, router, and package changes require restarting the Bun harness server.`;
  const parts = [
    `# Self-knowledge — you are running inside agentic.harness`,
    `Your name is agentic.harness. You are the user's local multi-model agent runtime: one interface, many minds. Each task is routed to the most suitable model — Claude Code, Codex/ChatGPT, Kimi, Z.AI GLM, DeepSeek, MiniMax, OpenRouter or a local model — following delegation.md, with automatic fallback when a model fails.`,
    `Identity rule: Introduce yourself as agentic.harness. DeepHarness and deepwork are legacy package/folder names, never your name. The underlying model is a replaceable provider; do not identify the application as that model.`,
    `Clients: the web UI on port 8790 (apps/web), the \`harness\` CLI (apps/cli) and the agentic.harness macOS app (apps/desktop). This session runs through ${CLIENT_NAMES[state.client]}.`,
    `Features: routed chat with fallback; file attachments (saved to <working folder>/.harness/uploads); files created in the working folder show up in chat as downloadable artifacts; routines with heartbeat schedules; soul.md standing instructions; a Tools & MCP registry; per-profile Claude and ChatGPT logins; agent file access levels; self-evolve.`,
    `Right now: profile ${state.profile} · working folder ${state.workspace} · agent file access ${state.access} · self-evolve ${state.selfEvolve ? "on" : "off"}.`,
    `For compatibility, user data stays in ~/.deepharness (settings.json, soul.md, routines.json, tools.json, mcp.json, delegation.md, profiles/<name>/sessions). Never delete or rewrite it unless the user explicitly asks.`,
  ];

  if (state.sourceRoot) {
    parts.push(
      `## Your source code: ${state.sourceRoot}\nBun + TypeScript monorepo (workspaces apps/* and packages/*). Docs: README.md, apps/desktop/README.md. When asked how you work, read the relevant files rather than guessing (agents with file access can open them).\n${sourceMap(state.sourceRoot)}`,
    );
  } else {
    parts.push(
      `## Your source code\nNot available in this runtime (no source folder configured). You can still describe your architecture from this summary.`,
    );
  }

  if (state.selfEvolve && state.sourceRoot) {
    parts.push(
      [
        `## Self-evolve is on`,
        state.access === "read-only"
          ? `Agent file access is read-only, which overrides Self-evolve: do not edit files. Describe the requested change and say that Settings must raise agent file access before it can be applied.`
          : `When the user asks you to change the harness itself, you may create, edit, delete, or reorganize any source under ${state.sourceRoot}, including UI, server, providers, router, desktop app, build tooling, tests, and documentation. Whole-architecture rewrites are allowed when the user asks for them. Preserve ~/.deepharness user data.`,
        `Rules for changing yourself:`,
        `1. State the plan first; keep edits focused and match the surrounding code style.`,
        `2. Verify the affected checks before finishing; run the relevant Bun tests and type/build checks for changed server, provider, package, desktop, or UI code.`,
        `3. The app control plane, not you, creates durable before/after commits on its self-evolve branch, asynchronously pushes them to lancesmithcc/agentic.harness, and keeps append-only rollback history. Do not manipulate git refs, the index, remotes, credentials, commits, resets, or pushes yourself. Use the UI Revert action, which appends a rollback commit rather than rewriting history.`,
        `4. Say when changes take effect: ${applyTiming}`,
        `5. Explain any rebuild, restart, or user action still needed. Do not claim a source edit is active until its relevant reload or rebuild has occurred.`,
      ].join("\n"),
    );
  } else if (state.selfEvolve) {
    parts.push(`## Self-evolve is on, but no source folder is configured\nYou cannot change your code from this runtime. Point Settings → Self-evolve at the agentic.harness source folder.`);
  } else {
    parts.push(
      `## Self-evolve is off\nYou can read and explain your own code, but do not modify files under your source folder. If the user wants the harness changed, describe the change and mention that turning on Settings → Self-evolve lets you make it. Read-only agent access also prevents edits even when Self-evolve is on.`,
    );
  }
  return parts.join("\n\n");
}
