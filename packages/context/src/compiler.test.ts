import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileContext, pickRelevantFiles } from "./compiler.ts";
import { buildSelfKnowledge, findSourceRoot, harnessInquiry, selfEvolutionIntent } from "./self.ts";
const model = { id: "local/test", model: "test", provider: "local", capabilities: { context: 4000 } };

describe("context integrity", () => {
  test("does not pull unrelated recent files, secrets or symlinks into a casual reply", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-context-"));
    try {
      writeFileSync(join(cwd, "notes.md"), "project detail");
      writeFileSync(join(cwd, "credentials.json"), "credential fixture");
      symlinkSync(join(cwd, "notes.md"), join(cwd, "linked.md"));
      expect(pickRelevantFiles("hello there", cwd)).toEqual([]);
      expect(pickRelevantFiles("review credentials.json and linked.md", cwd)).toEqual([]);
      expect(pickRelevantFiles("review notes.md", cwd)).toEqual(["notes.md"]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("keeps newest complete message pairs and signals omitted history", () => {
    const out = compileContext("current", model, { cwd: tmpdir(), includeGit: false, includeFiles: false, soul: "", replyStyle: "", history: [
      { role: "user", content: "x".repeat(30_000) }, { role: "assistant", content: "older answer" },
      { role: "user", content: "newer user" }, { role: "assistant", content: "newer answer" },
    ] });
    expect(out.some(m => m.content.includes("Earlier conversation was omitted"))).toBe(true);
    expect(out.filter(m => m.role !== "system").map(m => m.content)).toEqual(["newer user", "newer answer", "current"]);
  });
  test("zero recent turns excludes history", () => {
    const out = compileContext("current", model, { cwd: tmpdir(), includeGit: false, includeFiles: false, soul: "", replyStyle: "", recentTurns: 0, history: [{ role: "user", content: "old" }] });
    expect(out.some(m => m.content === "old")).toBe(false);
  });
  test("rejects oversized requests and standing instructions instead of silently losing them", () => {
    const opts = { cwd: tmpdir(), includeGit: false, includeFiles: false, soul: "", replyStyle: "", history: [] };
    expect(() => compileContext("x".repeat(9000), model, opts)).toThrow("exceed the selected model's context");
    expect(() => compileContext("current", model, { ...opts, soul: "x".repeat(9000) })).toThrow("exceed the selected model's context");
  });
  test("large project excerpts stay bounded while retaining recent conversation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-budget-"));
    try {
      writeFileSync(join(cwd, "project.md"), "reference ".repeat(2000));
      const out = compileContext("review project.md", model, { cwd, includeGit: false, maxFileChars: 12000, soul: "", replyStyle: "", history: [{ role: "user", content: "Keep the existing colors" }, { role: "assistant", content: "I will preserve those colors" }] });
      expect(out.some(m => m.content === "Keep the existing colors")).toBe(true);
      expect(out.map(m => m.content).join("").length).toBeLessThan(6000);
      expect(out.at(-1)?.content).toBe("review project.md");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("knows its identity and finds both legacy and renamed source roots", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-self-"));
    try {
      for (const name of ["deepharness", "agentic.harness"]) {
        writeFileSync(join(cwd, "package.json"), JSON.stringify({ name }));
        expect(findSourceRoot(cwd)).toBe(cwd);
      }
      const self = buildSelfKnowledge({ sourceRoot: null, workspace: cwd, profile: "home", client: "web", access: "read-only", selfEvolve: false });
      expect(self).toContain("Your name is agentic.harness.");
      expect(self).toContain("~/.deepharness");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("self-evolve grants source scope only for an explicit writable source task", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-self-evolve-"));
    try {
      const ordinary = buildSelfKnowledge({ sourceRoot: cwd, workspace: "/project", profile: "home", client: "web", access: "workspace", selfEvolve: true, task: "fix this app UI" });
      expect(ordinary).toContain("Self-evolve is armed only");
      expect(ordinary).toContain("selected working folder");
      expect(ordinary).not.toContain("create, edit, delete, or reorganize any source");
      expect(ordinary).not.toContain(cwd);

      const writable = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "web", access: "workspace", selfEvolve: true, task: "refactor the harness" });
      expect(writable).toContain("create, edit, delete, or reorganize any source");
      expect(writable).toContain("Whole-architecture rewrites are allowed");
      expect(writable).toContain("app control plane, not you");
      expect(writable).toContain("lancesmithcc/agentic.harness");
      expect(writable).toContain("restarting the Bun harness server");

      const desktop = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "desktop", access: "workspace", selfEvolve: true, task: "change agentic.harness UI" });
      expect(desktop).toContain("source edits do not change the running UI");
      expect(desktop).toContain("Rebuild and install the desktop bundle");

      const readOnly = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "web", access: "read-only", selfEvolve: true, task: "rewrite your own code" });
      expect(readOnly).toContain("overrides Self-evolve");
      expect(readOnly).toContain("do not edit files");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("recognizes only explicit requests to evolve the harness", () => {
    for (const task of [
      "rewrite your own code", "rewrite your own harness code in 'src/engine.ts'", "change agentic.harness UI",
      "fix agentic.harness’s UI", "fix harness history", "refactor the harness",
      "could you please edit agentic.harness server?", "will you fix the harness history?", "please rewrite your own source",
      "fix agentic.harness, not the project",
      "Self-evolve: in your own source, edit src/engine.ts so its exported version is 2 instead of 1.",
      "In agentic.harness, fix the chat toolbar", "For your own code, add a chat button",
      "Add a chat button to agentic.harness",
    ]) {
      expect(selfEvolutionIntent(task)).toBe(true);
    }
    for (const task of [
      "turn on self-evolve", "fix my app history", "update the project UI", "what is self evolution?", "summarize harness history",
      "rewrite this document", "don't rewrite your own code", "do not fix agentic.harness UI", "fix the test harness",
      "the user said 'fix harness history'", "how could we edit harness permissions?",
      "Can agentic.harness edit files?", "Explain how the harness can edit files",
      "Does agentic.harness change its own source?", "Should we fix the harness?",
    ]) {
      expect(selfEvolutionIntent(task)).toBe(false);
    }
  });

  test("allows explicit harness questions to receive read-only source context", () => {
    expect(harnessInquiry("How could we edit harness permissions?")).toBe(true);
    expect(harnessInquiry("Explain agentic.harness architecture")).toBe(true);
    expect(harnessInquiry("how could we edit this app?")).toBe(false);
    expect(harnessInquiry("how does this app work?")).toBe(false);
    expect(harnessInquiry("explain the test harness")).toBe(false);
    const sourceQuestion = buildSelfKnowledge({ sourceRoot: "/source", workspace: "/project", profile: "home", client: "web", access: "workspace", selfEvolve: true, task: "How could we edit harness permissions?" });
    expect(sourceQuestion).toContain("treat source access as read-only");
    expect(sourceQuestion).toContain("selected working folder as the working directory");
    expect(sourceQuestion).not.toContain("create, edit, delete, or reorganize any source");
  });

  test("ordinary prompts omit source maps and self-evolution directions", () => {
    const root = join(import.meta.dir, "../../..");
    const state = { sourceRoot: root, workspace: root, profile: "home", client: "desktop" as const, access: "workspace" as const, selfEvolve: true };
    const compact = buildSelfKnowledge({ ...state, contextWindow: 8192, task: "review the selected project" });
    expect(compact.length).toBeLessThan(2000);
    expect(compact).toContain("Your name is agentic.harness.");
    expect(compact).toContain("Selected working folder");
    expect(compact).not.toContain("Whole-architecture rewrites are allowed");
    expect(compact).not.toContain("apps/web");
  });
});
