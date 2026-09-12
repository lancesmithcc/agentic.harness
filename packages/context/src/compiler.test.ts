import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileContext, pickRelevantFiles } from "./compiler.ts";
import { buildSelfKnowledge, findSourceRoot, selfEvolutionIntent } from "./self.ts";
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
      expect(self).toContain("DeepHarness and deepwork are legacy");
      expect(self).toContain("~/.deepharness");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("self-evolve grants complete source scope but read-only access still wins", () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-self-evolve-"));
    try {
      const writable = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "web", access: "workspace", selfEvolve: true });
      expect(writable).toContain("create, edit, delete, or reorganize any source");
      expect(writable).toContain("Whole-architecture rewrites are allowed");
      expect(writable).toContain("app control plane, not you");
      expect(writable).toContain("lancesmithcc/agentic.harness");
      expect(writable).toContain("restarting the Bun harness server");

      const desktop = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "desktop", access: "workspace", selfEvolve: true });
      expect(desktop).toContain("source edits do not change the running UI");
      expect(desktop).toContain("Rebuild and install the desktop bundle");

      const readOnly = buildSelfKnowledge({ sourceRoot: cwd, workspace: cwd, profile: "home", client: "web", access: "read-only", selfEvolve: true });
      expect(readOnly).toContain("overrides Self-evolve");
      expect(readOnly).toContain("do not edit files");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test("recognizes only explicit requests to evolve the harness", () => {
    for (const task of ["rewrite your own code", "change agentic.harness UI", "fix harness history", "turn on self-evolve", "refactor the harness"]) {
      expect(selfEvolutionIntent(task)).toBe(true);
    }
    for (const task of ["fix my app history", "update the project UI", "what is self evolution?", "summarize harness history", "rewrite this document"]) {
      expect(selfEvolutionIntent(task)).toBe(false);
    }
  });
});
