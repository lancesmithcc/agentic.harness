/** Optional paid smoke test: actual DeepSeek source edit in a disposable repository. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY in the process environment first.");
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundle = join(repo, "apps/desktop/src-tauri/target/release/bundle/macos/agentic.harness.app/Contents");
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(Number(process.env.HARNESS_SELF_QA_PORT || 0), "127.0.0.1", resolve); });
const port = reservation.address().port, base = `http://127.0.0.1:${port}`;
await new Promise(resolve => reservation.close(resolve));
const temp = mkdtempSync(join(tmpdir(), "agentic-live-evolution-"));
const source = join(temp, "source"), home = join(temp, "data"), workspace = join(temp, "workspace");
for (const dir of [source, home, workspace, join(source, "src"), join(home, "profiles", "home")]) mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
writeFileSync(join(source, "package.json"), JSON.stringify({ name: "agentic.harness", type: "module" }));
writeFileSync(join(source, "src/engine.ts"), "export const version = 1;\n");
const projectMarker = `PROJECT-${crypto.randomUUID()}`;
writeFileSync(join(workspace, "PROJECT.txt"), projectMarker + "\n");
git("init"); git("config", "user.name", "Self-evolve verification"); git("config", "user.email", "verification@example.test"); git("add", "."); git("commit", "-m", "fixture baseline");
writeFileSync(join(home, "profiles/home/profile.toml"), ["[profile]", 'name="home"', ...["deepseek", "openai", "openrouter", "kimi", "minimax", "zai", "claude-code", "codex"].flatMap(p => [`[providers.${p}]`, "enabled=false"])].join("\n"));
writeFileSync(join(home, "settings.json"), JSON.stringify({ selfSourceRoot: source, agentAccess: "workspace", workspaces: { home: workspace } }));
const child = spawn(join(bundle, "MacOS/harness-server"), [], {
  cwd: workspace, stdio: ["ignore", "ignore", "pipe"],
  env: { HOME: temp, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HARNESS_HOME: home, HARNESS_PROFILE: "home", HARNESS_WEB_PORT: String(port), HARNESS_WEB_ROOT: join(bundle, "Resources/web"), HARNESS_DSH_BRIDGE: join(bundle, "Resources/dsh-runtime/deepseek-bridge.mjs"), HARNESS_NODE_PATH: join(bundle, "Resources/dsh-runtime/node/bin/node"), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY },
});
let stderr = "";
child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
const started = Date.now();
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Packaged harness failed to start: " + stderr);
  const result = await fetch(base + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ task: "Self-evolve: in your own source, edit src/engine.ts so its exported version is 2 instead of 1. Change only that file. Read it back to verify; give a short completion message. This is a disposable verification fixture.", model: "deepseek-harness/deepseek-v4-flash", selfEvolve: true, noFallback: true }) });
  const events = (await result.text()).split("\n\n").filter(x => x.startsWith("data:")).map(x => JSON.parse(x.slice(5)));
  if (events.at(-1)?.t !== "done") throw new Error("Self-evolve failed: " + JSON.stringify(events.filter(e => e.t === "error")));
  const change = events.find(e => e.t === "self-change");
  if (!change || !readFileSync(join(source, "src/engine.ts"), "utf8").includes("version = 2")) throw new Error("No verified source checkpoint");
  if (!git("show", `${change.beforeCommit}:src/engine.ts`).includes("version = 1")) throw new Error("Missing before checkpoint");
  const sid = events.find(e => e.t === "accepted").session;
  const ordinary = await fetch(base + "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ task: "For this app, read PROJECT.txt in the selected working folder. Reply only with its exact contents and the selected working folder. Do not change files.", sessionId: sid, model: "deepseek-harness/deepseek-v4-flash", noFallback: true }) });
  const followup = (await ordinary.text()).split("\n\n").filter(x => x.startsWith("data:")).map(x => JSON.parse(x.slice(5)));
  const answer = followup.find(e => e.t === "done")?.text ?? "";
  if (!answer.includes(projectMarker) || !answer.includes(workspace) || followup.some(e => e.t === "self-change")) throw new Error("Ordinary follow-up did not stay in the chat's selected project");
  if (git("rev-parse", "self-evolve") !== change.afterCommit) throw new Error("Ordinary project task created a source checkpoint");
  const context = await fetch(base + "/api/session?id=" + sid).then(r => r.json());
  if (context.workspace !== workspace || context.selfEvolve !== true) throw new Error("Self-evolve changed the chat's remembered project");
  const restored = await fetch(base + "/api/self/revert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: sid, before: change.before, after: change.after }) }).then(r => r.json());
  if (!restored.checkpoint?.afterCommit || !readFileSync(join(source, "src/engine.ts"), "utf8").includes("version = 1")) throw new Error("Rollback did not restore original source");
  git("merge-base", "--is-ancestor", change.afterCommit, restored.checkpoint.afterCommit);
  console.log(JSON.stringify({ ok: true, provider: "deepseek-harness", access: "workspace", elapsedMs: Date.now() - started, toolCalls: events.filter(e => e.t === "tool").length, changedFiles: change.files.map(f => f.path), ordinaryFollowup: true, chatWorkspacePreserved: true, beforeCommit: change.beforeCommit, afterCommit: change.afterCommit, rollbackCommit: restored.checkpoint.afterCommit, remote: "none; disposable fixture" }, null, 2));
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("close", resolve); });
  rmSync(temp, { recursive: true, force: true });
}
