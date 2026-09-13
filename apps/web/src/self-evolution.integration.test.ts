import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root: string, source: string, data: string, base: string;
let child: ReturnType<typeof Bun.spawn>;
const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const request = async (path: string, body?: unknown, method = "POST") => fetch(base + path, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agentic-self-http-"));
  source = join(root, "source"); data = join(root, "data");
  const bin = join(root, "bin"), workspace = join(root, "workspace");
  for (const dir of [source, data, bin, workspace, join(source, "src")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "agentic.harness" }));
  writeFileSync(join(source, "src", "engine.ts"), "export const version = 1;\n");
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  git("add", "."); git("commit", "-m", "fixture");
  // A real provider subprocess protocol with deterministic local file edits.
  // No network, credentials, user source, or installed app is involved.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='--version'){console.log('codex-cli 0.154.0');process.exit(0)}\nif(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}\nconst cwd=a[a.indexOf('--cd')+1];\nif(!cwd || !a.includes('workspace-write')) throw new Error('Expected scoped source workspace');\nconst text=await Bun.file(cwd+'/src/engine.ts').text();\nawait Bun.write(cwd+'/src/engine.ts',text.replace('= 1','= 2'));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:[{path:cwd+'/src/engine.ts',kind:'update'}]}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Updated harness source.'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));\n`, { mode: 0o755 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const profile = join(data, "profiles", "home"); mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "profile.toml"), ["[profile]", 'name="home"', ...["deepseek", "deepseek-harness", "openai", "zai", "kimi", "minimax", "openrouter"].flatMap(p => [`[providers.${p}]`, "enabled=false"])].join("\n"));
  writeFileSync(join(data, "settings.json"), JSON.stringify({ selfSourceRoot: source, agentAccess: "workspace", workspaces: { home: workspace } }));
  const port = 34_000 + Math.floor(Math.random() * 2000); base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], { cwd: workspace, stdout: "ignore", stderr: "pipe", env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, HARNESS_HOME: data, HARNESS_PROFILE: "home", HARNESS_WEB_PORT: String(port) } });
  for (let i = 0; i < 100; i++) {
    try { if ((await request("/api/health")).ok) break; } catch {}
    await Bun.sleep(50);
  }
  const configured = await request("/api/self", { sourceRoot: source }, "PUT");
  expect(configured.status).toBe(200);
});
afterAll(async () => { child?.kill(); if (child) await child.exited; if (root) rmSync(root, { recursive: true, force: true }); });

test("own-source writes produce durable commits, survive reload, and rollback appends history", async () => {
  const head = git("rev-parse", "HEAD");
  const response = await request("/api/ask", { task: "Rewrite your own harness code in src/engine.ts", model: "codex/default", selfEvolve: true, noFallback: true });
  const raw = await response.text();
  const events = raw.split("\n\n").filter(s => s.startsWith("data:")).map(s => JSON.parse(s.slice(5)));
  expect(events.at(-1)?.t).toBe("done");
  const change = events.find(e => e.t === "self-change");
  expect(change?.files).toContainEqual({ status: "M", path: "src/engine.ts" });
  expect(git("show", `${change.beforeCommit}:src/engine.ts`)).toContain("= 1");
  expect(git("show", `${change.afterCommit}:src/engine.ts`)).toContain("= 2");
  expect(git("rev-parse", "HEAD")).toBe(head);
  const sid = events.find(e => e.t === "accepted").session;
  const saved = await (await request(`/api/session?id=${sid}`)).json();
  expect(saved.events.filter((e: any) => e.kind === "self-change")).toHaveLength(1);
  const status = await (await request("/api/self")).json();
  expect(status.evolution.localCommit).toBe(change.afterCommit);
  expect(status.evolution.sync).not.toBe("synced");
  const diff = await request(`/api/self/diff?session=${sid}&before=${change.before}&after=${change.after}`);
  expect(await diff.text()).toContain("+export const version = 2;");
  const rollback = await (await request("/api/self/revert", { session: sid, before: change.before, after: change.after })).json();
  expect(rollback.reverted).toEqual(["src/engine.ts"]);
  expect(rollback.checkpoint.afterCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(source, "src/engine.ts"), "utf8")).toContain("= 1");
  expect(git("merge-base", "--is-ancestor", change.afterCommit, rollback.checkpoint.afterCommit)).toBe("");
  expect(git("rev-parse", "HEAD")).toBe(head);
}, 30_000);
