import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "dh-"));

let parseDelegation!: typeof import("./delegation.ts")["parseDelegation"];

beforeAll(async () => {
  ({ parseDelegation } = await import("./delegation.ts"));
});

describe("parseDelegation", () => {
  test("parses TSV rows with starred role and comma lists", () => {
    const text =
      "GLM-5.3 Flash\t⭐ **Default production worker**\tCoding, research\tFinal judgment on the hardest problems";
    const { rows } = parseDelegation(text);
    expect(rows[0].model).toBe("GLM-5.3 Flash");
    expect(rows[0].starred).toBe(true);
    expect(rows[0].role).toBe("Default production worker");
    expect(rows[0].bestFor).toContain("Coding");
    expect(rows[0].bestFor).toContain("research");
    expect(rows[0].avoidFor).toContain("Final judgment on the hardest problems");
  });

  test("parses markdown pipe table and unbolds names", () => {
    const text = [
      "| Model | Role | Best For | Avoid For |",
      "|---|---|---|---|",
      "| GLM-5.3 Flash | **Default worker** | Coding, research | Hard problems |",
      "| Claude Code | **Architect** | Architecture, planning | Simple tasks |",
    ].join("\n");
    const { rows } = parseDelegation(text);
    expect(rows.length).toBe(2);
    expect(rows[0].model).not.toContain("**");
    expect(rows[1].model).not.toContain("**");
  });

  test("parses YAML front matter", () => {
    const text = [
      "---",
      "local_first: true",
      "max_parallel_agents: 5",
      "routing:",
      "  architecture: [claude, codex, kimi-k3]",
      "  simple: [gemma-local]",
      "---",
      "",
      "# Delegation Rules",
    ].join("\n");
    const result = parseDelegation(text);
    expect(result.frontmatter.localFirst).toBe(true);
    expect(result.frontmatter.maxParallelAgents).toBe(5);
    expect(result.frontmatter.routing.architecture.length).toBe(3);
    expect(result.frontmatter.routing.simple).toEqual(["gemma-local"]);
  });

  test("ignores prose and heading lines", () => {
    const text = [
      "# Delegation Rules",
      "This is prose that should be ignored.",
      "Just some narrative about how the team works.",
      "GLM-5.3 Flash\t⭐ **Role**\tCoding\tHard problems",
    ].join("\n");
    const { rows } = parseDelegation(text);
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("GLM-5.3 Flash");
  });

  test("malformed front matter does not throw and body still parses", () => {
    const text = [
      "---",
      "foo: [",
      "---",
      "GLM-5.3 Flash\t⭐ **Role**\tCoding\tHard problems",
    ].join("\n");
    const result = parseDelegation(text);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0].model).toBe("GLM-5.3 Flash");
  });
});
