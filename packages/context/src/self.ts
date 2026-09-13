/**
 * Self-knowledge: a compact description of agentic.harness itself — what it is, what it can do,
 * where its source lives and how that source is laid out — added to every session so the
 * agent can explain itself and, when Settings → Self-evolve is on, change its own code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SelfState {
  /** Monorepo root of the harness source, or null when this runtime has no source (compiled app). */
  sourceRoot: string | null;
  profile: string;
  workspace: string;
  access: "read-only" | "workspace" | "full";
  selfEvolve: boolean;
  client: "web" | "cli" | "desktop";
  /** Current user task, used only to decide whether source-specific context is warranted. */
  task?: string;
  /** Retained for call-site compatibility with model-context settings. */
  contextWindow?: number;
}

/**
 * True only for an explicit request to modify agentic.harness itself. The web
 * server uses this to make the source tree the native agent workspace while
 * preserving the selected access mode; ordinary project work stays in its
 * configured workspace.
 */
export function selfEvolutionIntent(task: string): boolean {
  // Quoted text often reports an instruction rather than making one. Remove
  // paired quoted spans, but leave the surrounding request (and quoted file
  // paths) intact so `rewrite your own code in "src/engine.ts"` still works.
  const text = task.toLowerCase().replace(/(?:"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’)/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return false;
  // A toggle, a negated mutation, or a reference to a test/project harness must never
  // make a project request run from the agent source tree.
  if (/\b(?:test(?:ing)?|project)\s+harness\b/.test(text)) return false;
  const action = "(?:rewrite|change|edit|update|fix|repair|refactor|implement|reorganize|create|delete|add)";
  const directRequest = new RegExp(`^(?:can|could|would|will)\\s+(?:you|we)\\s+(?:please\\s+)?${action}\\b`).test(text);
  if (!directRequest && /^(?:how|what|why|where|when|which|explain|describe|summarize|tell me|show me|is|are|does|do|can|could|would|will|should)\b/.test(text)) return false;
  if (new RegExp(`\\b(?:don't|do not|never|avoid)\\s+(?:please\\s+)?${action}\\b`).test(text)) return false;
  const selfTarget = "(?:your(?: own)?(?: harness)? (?:code|source)|own source|agentic\\.harness(?:['’]s)?(?: (?:ui|server|app|code|source|history))?|the harness(?: (?:ui|server|app|code|source|history))?|harness (?:ui|server|app|code|source|history))";
  return new RegExp(`\\b${action}\\s+${selfTarget}\\b`).test(text)
    || new RegExp(`\\b(?:in|for)\\s+${selfTarget}\\s*[:,]\\s*${action}\\b`).test(text)
    || new RegExp(`\\b${action}\\b[^.!?]{0,80}\\b(?:in|of|for|to)\\s+(?:agentic\\.harness|your own (?:code|source))\\b`).test(text);
}

/** A direct, non-mutating question about agentic.harness may receive source context. */
export function harnessInquiry(task: string): boolean {
  const text = task.toLowerCase().replace(/(?:"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’)/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /\b(?:test(?:ing)?|project)\s+harness\b/.test(text)) return false;
  return /\b(?:agentic\.harness|(?:the )?harness)\b/.test(text)
    && /\b(?:how|what|why|where|can|could|would|should|does|explain|describe|architecture|work|edit|change|modify)\b/.test(text);
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

const CLIENT_NAMES: Record<SelfState["client"], string> = {
  web: "the web UI (Bun server in apps/web)",
  cli: "the `harness` CLI (apps/cli)",
  desktop: "the agentic.harness macOS app (Tauri shell running the compiled web server)",
};

export function buildSelfKnowledge(state: SelfState): string {
  const task = state.task ?? "";
  const changingSelf = selfEvolutionIntent(task);
  const askingAboutHarness = changingSelf || harnessInquiry(task);
  const applyTiming = state.client === "desktop"
    ? `This is the packaged desktop app: source edits do not change the running UI, server, providers, or native shell. Rebuild and install the desktop bundle using apps/desktop/README.md, then relaunch the app for every source change to take effect.`
    : `This is a source-run client: apps/web/index.html and brand.css take effect after page reload; server, provider, router, and package changes require restarting the Bun harness server.`;
  const parts = [
    `Your name is agentic.harness. You are the user's local multi-model agent runtime.`,
    `Current profile: ${state.profile}. Selected working folder: ${state.workspace}. Treat it as the default referent and scope for every ordinary request. Do not switch to agentic.harness source merely because Self-evolve is on or the task mentions an app, code, UI, history, or a harness project.`,
    `Agent file access: ${state.access}. Self-evolve: ${state.selfEvolve ? "on" : "off"}. Only claim execution after actual tool results. Preserve ~/.deepharness user data unless the user explicitly asks to change it.`,
  ];

  if (askingAboutHarness && state.sourceRoot) {
    parts.push(
      `This task explicitly concerns agentic.harness. Its source is available at ${state.sourceRoot}; read only relevant files for an explanation. Unless this is an explicit modification request, keep the selected working folder as the working directory and treat source access as read-only.`,
    );
  } else if (askingAboutHarness) {
    parts.push(
      `This task explicitly concerns agentic.harness, but no source folder is configured. Describe only what this context supports.`,
    );
  }

  if (state.selfEvolve && state.sourceRoot && changingSelf) {
    parts.push(
      [
        `## Explicit self-evolution request`,
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
  } else if (changingSelf && state.selfEvolve) {
    parts.push(`Self-evolve is on, but no source folder is configured. This task cannot modify agentic.harness from this runtime.`);
  } else if (changingSelf) {
    parts.push(
      `This is an explicit request to modify agentic.harness, but Self-evolve is off. Do not modify its source. Tell the user to enable the chat 🧬 Self-evolve control; read-only access still overrides it.`,
    );
  } else if (state.selfEvolve) {
    parts.push(`Self-evolve is armed only for an explicit request to modify agentic.harness. This ordinary task remains scoped to the selected working folder.`);
  }
  return parts.join("\n\n");
}
