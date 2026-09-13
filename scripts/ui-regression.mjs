#!/usr/bin/env node
/**
 * Browser regression checks for the standalone web UI. It never starts the
 * harness server or reads a real profile: this tiny HTTP server supplies only
 * deterministic fake API/SSE responses.
 *
 * Run: node scripts/ui-regression.mjs
 * Requires a locally installed Playwright package and browser binary.
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { throw new Error("ui-regression requires a local Playwright installation"); }

const webRoot = new URL("../apps/web/", import.meta.url).pathname;
const qaRoot = new URL("../docs/qa/", import.meta.url).pathname;
const state = { cancels: 0, deleteAttempts: 0, syncCalls: 0, contextCalls: 0, askCalls: 0, slowContext: false, slowOldStatus: false, savedSessions: [], contexts: { old: { workspace: "/tmp/fake-home", selfEvolve: false }, new: { workspace: "/tmp/fake-home", selfEvolve: false } } };
const sessionEvents = {
  old: Array.from({ length: 18 }, (_, i) => ({ v: 1, kind: i % 2 ? "assistant-text" : "user-message", model: "fake/worker", text: "Older message " + i + "\n" + "context ".repeat(90) })),
  new: [
    { v: 1, kind: "user-message", text: "The selected transcript" },
    { v: 1, kind: "assistant-delta", turnId: "partial", model: "fake/worker", text: "Recovered partial answer." },
    { v: 1, kind: "user-message", text: "Later user message" },
    { v: 1, kind: "tool-call", turnId: "complete", id: "replay-tool", name: "workspace.inspect", arguments: { ignored: true } },
    { v: 1, kind: "tool-result", turnId: "complete", id: "replay-tool", name: "workspace.inspect", content: "replayed output", isError: false },
    { v: 1, kind: "assistant-delta", turnId: "complete", model: "fake/worker", text: "superseded journal text" },
    { v: 1, kind: "assistant-text", turnId: "complete", model: "fake/worker", text: "New transcript wins." },
    { v: 1, kind: "self-change", before: "1111111", after: "2222222", beforeCommit: "1111111", afterCommit: "abcdef1234567890", branch: "self-evolve", repoUrl: "https://github.com/lancesmithcc/agentic.harness", files: [{ path: "apps/web/index.html", status: "M" }] },
  ],
};
function json(res, data, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
function sse(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function fakeStatus(profile, sessionId) {
  const sessionContext = sessionId && state.contexts[sessionId];
  return { profile, profiles: ["home", "work"], workspace: state.slowOldStatus && sessionId === "old" ? "/tmp/stale-context" : sessionContext?.workspace || "/tmp/fake-" + profile,
    defaultWorkspace: "/tmp/fake-" + profile, selfEvolve: sessionContext?.selfEvolve || false,
    settings: { theme: "gold", astraAvailable: false, reasoningOff: false }, providers: [] };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const profile = url.searchParams.get("profile") || "home";
  if (url.pathname === "/api/meta") return json(res, { verbs: ["Preparing"], settings: { theme: "gold" }, models: [] });
  if (url.pathname === "/api/status") {
    const payload = fakeStatus(profile, url.searchParams.get("sessionId"));
    return state.slowOldStatus && url.searchParams.get("sessionId") === "old" ? setTimeout(() => json(res, payload), 140) : json(res, payload);
  }
  if (url.pathname === "/api/sessions") return json(res, { sessions: state.savedSessions.concat([{ id: "old", title: "Old transcript", events: 4 }, { id: "new", title: "New transcript", events: 2 }]) });
  if (url.pathname === "/api/session/context" && req.method === "PUT") {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body || "{}"); const id = input.sessionId || "context-" + (++state.contextCalls);
    const prior = state.contexts[id] || { workspace: "/tmp/fake-" + profile, selfEvolve: false };
    state.contexts[id] = { workspace: input.workspace || prior.workspace, selfEvolve: input.selfEvolve == null ? prior.selfEvolve : !!input.selfEvolve };
    state.savedSessions = [{ id, title: "Context chat", events: 0 }].concat(state.savedSessions.filter((s) => s.id !== id));
    const payload = { session: id, ...state.contexts[id] };
    return state.slowContext ? setTimeout(() => json(res, payload), 140) : json(res, payload);
  }
  if (url.pathname === "/api/session") {
    const id = url.searchParams.get("id");
    if (req.method === "DELETE") {
      state.deleteAttempts++;
      return json(res, { error: "Session has an active turn and cannot be deleted." }, 409);
    }
    return setTimeout(() => json(res, { events: sessionEvents[id] || [], ...(state.contexts[id] || { workspace: "/tmp/fake-" + profile, selfEvolve: false }) }), id === "old" ? 180 : 5);
  }
  if (url.pathname === "/api/fs/list") return json(res, { dir: "/tmp", parent: "/", entries: ["fake-home"] });
  if (url.pathname === "/api/self" && req.method === "GET") return json(res, {
    sourceRoot: "/tmp/fake-harness", git: true, access: "full",
    evolution: { branch: "self-evolve", repoUrl: "https://github.com/lancesmithcc/agentic.harness", localCommit: "abcdef1234567890", remoteCommit: state.syncCalls ? "abcdef1234567890" : null, sync: state.syncCalls ? "synced" : "error", error: state.syncCalls ? null : "Remote unavailable", busy: false },
  });
  if (url.pathname === "/api/self/sync" && req.method === "POST") { state.syncCalls++; return json(res, { evolution: { branch: "self-evolve", repoUrl: "https://github.com/lancesmithcc/agentic.harness", localCommit: "abcdef1234567890", remoteCommit: "abcdef1234567890", sync: "synced", busy: false } }); }
  if (url.pathname === "/api/settings" && req.method === "PUT") return json(res, { ok: true });
  if (url.pathname === "/api/turn/cancel" && req.method === "POST") { state.cancels++; return json(res, { ok: true }); }
  if (url.pathname === "/api/ask" && req.method === "POST") {
    let body = ""; for await (const part of req) body += part;
    state.askCalls++; const input = JSON.parse(body || "{}"), task = input.task || "";
    const session = "turn-" + task;
    state.savedSessions = [{ id: session, title: task + " request", events: 1 }].concat(state.savedSessions.filter((s) => s.id !== session));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const context = state.contexts[input.sessionId] || { workspace: input.workspace || "/tmp/fake-" + profile, selfEvolve: !!input.selfEvolve };
    state.contexts[session] = context; sse(res, { t: "accepted", session, ...context });
    if (task === "error") return setTimeout(() => { sse(res, { t: "error", message: "Fake route failed" }); res.end(); }, 20);
    if (task === "sample") return setTimeout(() => {
      sse(res, { t: "route", session, decision: { selected: "fake/worker" } });
      sse(res, { t: "tool", id: "tool-1", name: "workspace.search" });
      sse(res, { t: "tool-result", id: "tool-1", name: "workspace.search", isError: true, content: "<b>failed output</b> " + "x".repeat(500) });
      sse(res, { t: "tool", id: "tool-2", name: "workspace.read" });
      sse(res, { t: "tool-result", id: "tool-2", name: "workspace.read", isError: false, content: { text: "completed output" } });
      const sample = "## Markdown report\n\nA readable **result** with a [link](https://example.test).\n\n```js\nconst answer = 42;\n```\n";
      sse(res, { t: "delta", text: sample });
      sse(res, { t: "done", model: "fake/worker", text: sample });
      sse(res, { t: "error", message: "Tool command failed: fake tool unavailable" }); res.end();
    }, 20);
    if (task === "long") {
      sse(res, { t: "route", session: "turn-long", decision: { selected: "fake/worker" } });
      const chunk = "x".repeat(1024); let sent = 0;
      const timer = setInterval(() => { sse(res, { t: "delta", text: chunk }); if (++sent === 50) { clearInterval(timer); sse(res, { t: "done", model: "fake/worker", text: chunk.repeat(50) }); res.end(); } }, 2);
      return;
    }
    setTimeout(() => sse(res, { t: "route", session: "turn-" + task, decision: { selected: "fake/worker" } }), 90);
    setTimeout(() => { sse(res, { t: "delta", text: task === "late" ? "late response" : "partial response" }); sse(res, { t: "done", model: "fake/worker", text: task === "late" ? "late response" : "complete response" }); res.end(); }, 140);
    return;
  }
  // Settings makes several read-only API calls. They are intentionally empty
  // in this isolated UI harness, but must still be valid JSON responses.
  if (url.pathname.startsWith("/api/")) return json(res, {});
  const requested = normalize(join(webRoot, url.pathname === "/" ? "index.html" : url.pathname));
  if (!requested.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  try {
    const content = await readFile(requested);
    const type = extname(requested) === ".css" ? "text/css" : extname(requested) === ".js" ? "text/javascript" : "text/html";
    res.writeHead(200, { "content-type": type }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const expect = (ok, message) => { if (!ok) throw new Error(message); };
const send = async (task) => { await page.locator("#task").fill(task); await page.locator("#send").click(); };
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push("pageerror: " + error.message));
page.on("console", (message) => {
  // The delete-conflict fixture intentionally returns this API-level 409.
  if (message.type() === "error" && !message.text().includes("409 (Conflict)")) pageErrors.push("console: " + message.text());
});
const metrics = { maxFrameGap: null, noForcedScroll: false, narrow: null };

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__S.profile === "home" && window.__S.sessionId === "old");
  expect((await page.locator("#view").innerText()).includes("Older message 0"), "normal boot did not hydrate the persisted home session");
  expect(await page.locator('.nav-item[data-view="settings"]').count() === 1, "Settings is no longer reachable from navigation");
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.waitForFunction(() => document.querySelector("#crumb").textContent === "Settings");
  expect(await page.locator(".self-card").count() === 0, "legacy self-evolve card remained in Settings");
  await page.locator('.nav-item[data-view="chat"]').click();
  state.slowOldStatus = true;
  await page.evaluate(() => window.__ls());
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.__S.sessionId === null && window.__S.workspace === "/tmp/fake-home"), "late selected-chat status overwrote a new chat folder");
  state.slowOldStatus = false;
  await page.getByText("Old transcript", { exact: true }).click();
  await page.waitForFunction(() => window.__S.sessionId === "old");
  await page.getByRole("button", { name: "Delete session Old transcript" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("active turn and cannot be deleted"));
  expect(state.deleteAttempts === 1 && await page.evaluate(() => window.__S.sessionId === "old"), "409 delete cleared the selected session");
  await page.getByRole("button", { name: "work" }).click();
  await page.waitForFunction(() => document.querySelector("#profilePill").textContent === "work");
  expect(await page.locator("#profilePill").textContent() === "work", "profile switch did not win");
  await page.getByRole("button", { name: "self evolve" }).click();
  await page.waitForFunction(() => window.__S.selfEvolve === true && window.__S.sessionId.startsWith("context-"));
  expect(await page.locator("#selfEvolveToggle").getAttribute("aria-pressed") === "true", "per-chat self evolve did not persist");
  const contextId = await page.evaluate(() => window.__S.sessionId);
  await page.locator("#wsBtn").click();
  await page.locator(".fsrow").filter({ hasText: "fake-home" }).dblclick();
  await page.waitForFunction(() => window.__S.workspace === "/tmp/fake-home");
  expect(await page.evaluate(() => window.__S.sessionId) === contextId && state.contexts[contextId].workspace === "/tmp/fake-home", "folder selection did not preserve the active chat context");
  await page.evaluate(() => window.__ls());
  await page.waitForTimeout(20);
  expect(await page.evaluate((id) => window.__S.sessionId === id && window.__S.workspace === "/tmp/fake-home" && window.__S.selfEvolve, contextId), "status refresh overwrote the active chat context");
  state.slowContext = true;
  const asksBeforeContextRace = state.askCalls;
  await page.getByRole("button", { name: "self evolve" }).click();
  await page.waitForFunction(() => window.__S.contextSaving === true);
  expect(await page.locator("#send").isDisabled(), "send remained enabled while chat context was saving");
  await page.locator("#task").press("Enter");
  expect(state.askCalls === asksBeforeContextRace, "send started while context was still saving");
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => !window.__S.contextSaving && !document.querySelector("#selfEvolveToggle").disabled && window.__S.sessionId === null), "new chat left controls stuck after an invalidated context save");
  state.slowContext = false;

  await send("late");
  expect(await page.locator("#selfEvolveToggle").isDisabled(), "self-evolve control stayed enabled during an active turn");
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.__S.sessionId === null), "late route replaced fresh session");
  expect(await page.evaluate(() => window.__S.workspace === "/tmp/fake-work" && window.__S.selfEvolve === false), "new chat did not reset to the selected profile default folder and self-evolve off");
  expect(!(await page.locator("#view").innerText()).includes("late response"), "late stream rendered into fresh session");
  await page.waitForFunction(() => document.querySelector("#chatList").innerText.includes("late request"));
  expect(state.savedSessions.some((s) => s.id === "turn-late"), "detached accepted turn was not retained by isolated history");

  await page.getByText("New transcript", { exact: true }).click();
  await page.waitForTimeout(240);
  expect(await page.evaluate(() => window.__S.workspace === "/tmp/fake-home" && window.__S.selfEvolve === false), "opening a saved chat did not restore its own folder and self-evolve state");
  expect((await page.locator("#view").innerText()).includes("New transcript wins."), "late boot hydration overwrote selected history");
  expect((await page.locator("#view").innerText()).includes("Local checkpoint abcdef12"), "recorded self-change overclaimed an unsynced remote commit");
  expect(!(await page.locator("#view").innerText()).includes("superseded journal text"), "committed turn replayed duplicate deltas");
  expect((await page.locator("#view").innerText()).includes("Recovered partial answer."), "uncommitted journal deltas were not recovered");
  const replay = await page.locator("#view").innerText();
  expect(replay.indexOf("Recovered partial answer.") < replay.indexOf("Later user message"), "journal partial was appended after later history");
  expect(await page.locator("#view .msg.assistant").count() === 2, "tool replay created a duplicate assistant bubble");
  expect(await page.locator('#view .tool-row[data-tool-id="replay-tool"] .tool-state').innerText() === "Completed", "replayed tool result was not completed");
  expect(await page.locator('#view .tool-row[data-tool-id="replay-tool"] details[open]').count() === 0, "replayed tool output should stay collapsed");

  await send("stop");
  await page.locator("#stop").click();
  await page.waitForFunction(() => document.body.innerText.includes("Stopped"));
  await page.waitForTimeout(30);
  expect(state.cancels === 1, "stop did not call isolated cancellation endpoint");
  expect(await page.getByRole("button", { name: "Retry this request" }).count() === 1, "stopped request has no retry action");

  await page.getByText("Old transcript", { exact: true }).click();
  await page.waitForTimeout(220);
  await page.locator("#view").evaluate((node) => { node.scrollTop = 0; });
  const before = await page.locator("#view").evaluate((node) => node.scrollTop);
  await page.evaluate(() => {
    window.__frameGaps = []; let previous = performance.now();
    const tick = (now) => { window.__frameGaps.push(now - previous); previous = now; if (window.__frameGaps.length < 120) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await send("long");
  await page.waitForFunction(() => { const all = document.querySelectorAll(".answer"); return all[all.length - 1].textContent.length >= 50 * 1024; }, null, { timeout: 5000 });
  const after = await page.locator("#view").evaluate((node) => node.scrollTop);
  expect(before === after, "long stream forced scroll while reading history");
  const maxFrameGap = await page.evaluate(() => Math.max.apply(Math, window.__frameGaps));
  expect(maxFrameGap < 250, "50KB stream blocked animation frames for " + Math.round(maxFrameGap) + "ms");
  metrics.maxFrameGap = maxFrameGap; metrics.noForcedScroll = before === after;

  await page.getByRole("button", { name: "New session" }).click();
  await send("sample");
  await page.waitForFunction(() => document.body.innerText.includes("Tool command failed"));
  expect((await page.locator(".answer").last().innerText()).includes("Markdown report"), "sample markdown was not rendered");
  expect(await page.locator(".md-code").count() === 1, "sample code block was not rendered");
  const failedTool = page.locator('.tool-row[data-tool-id="tool-1"]');
  expect(await failedTool.locator(".tool-state").innerText() === "Failed" && await failedTool.evaluate((node) => node.classList.contains("failed")), "failed tool result was overwritten by terminal completion");
  expect(await failedTool.locator("details[open]").count() === 0, "live tool output should stay collapsed");
  expect((await failedTool.locator(".tool-output-text").innerText()).length <= 360, "tool output was not capped");
  expect((await failedTool.locator(".tool-output-text").textContent()).includes("<b>failed output</b>") && await failedTool.locator("img").count() === 0, "tool output was not escaped as text");
  expect(await page.locator('.tool-row[data-tool-id="tool-2"] .tool-state').innerText() === "Completed", "completed tool result was not retained");
  expect(await page.getByRole("button", { name: "Retry this request" }).count() === 1, "stream error did not expose retry");
  await mkdir(qaRoot, { recursive: true });
  await page.screenshot({ path: join(qaRoot, "ui-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50);
  const narrow = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const controls = ["#task", "#send", "#modelPick", "#attachBtn"].map((selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    return { viewport, scrollWidth: document.documentElement.scrollWidth, controls };
  });
  expect(narrow.scrollWidth <= narrow.viewport, "390px layout has horizontal overflow: " + JSON.stringify(narrow));
  expect(narrow.controls.every((box) => box.left >= 0 && box.right <= narrow.viewport && box.bottom <= 844), "a composer control is unreachable at 390px");
  metrics.narrow = narrow;
  await page.screenshot({ path: join(qaRoot, "ui-narrow.png"), fullPage: true });
  await page.locator('#selfChatDetails summary').click();
  await page.getByLabel('Harness source checkout').waitFor({ state: 'visible' });
  const selfOptions = await page.locator('#selfChatOptions').boundingBox();
  expect(selfOptions && selfOptions.x >= 0 && selfOptions.x + selfOptions.width <= 390 && selfOptions.y >= 0, 'self-evolve options escaped the mobile viewport');
  expect(await page.locator('#selfEvolveToggle').getAttribute('title') === 'self evolve', 'self-evolve tooltip changed');
  await page.screenshot({ path: join(qaRoot, 'ui-self-evolve-options.png'), fullPage: true });
  await page.keyboard.press('Escape');
  expect(!(await page.locator('#selfChatDetails').getAttribute('open')), 'Escape did not close self-evolve options');
  await page.locator("#mobileMenu").click();
  expect(await page.locator("#mobileMenu").getAttribute("aria-expanded") === "true", "mobile menu did not open");
  expect(await page.locator('.rail.mobile-open .nav-item[data-view="routines"]').count() === 1, "Routines is not reachable from mobile navigation");
  await page.screenshot({ path: join(qaRoot, "ui-narrow-menu.png"), fullPage: true });
  await page.locator('.rail.mobile-open .nav-item[data-view="routines"]').click();
  await page.waitForFunction(() => document.querySelector("#crumb").textContent === "Routines");
  expect(await page.locator(".rail").evaluate((node) => !node.classList.contains("mobile-open")), "mobile drawer did not close after navigation");
  await page.locator("#mobileMenu").click();
  await page.locator("#themeToggle").click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "inverse");
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(213, 209, 193)");
  metrics.inverse = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bodyBackground: getComputedStyle(document.body).backgroundColor }));
  expect(metrics.inverse.bodyBackground !== "rgb(8, 8, 7)", "inverse theme did not change the page field");
  await page.locator('.rail.mobile-open .nav-item[data-view="chat"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.dataset.theme === "inverse"), "navigation overwrote the selected inverse theme");
  metrics.inverse.ink = await page.evaluate(() => ({
    wordmark: getComputedStyle(document.querySelector(".signature-prefix")).color,
    retry: getComputedStyle(document.querySelector(".turn-actions .ghost")).color,
    inactiveNav: getComputedStyle(document.querySelector('.nav-item[data-view="routines"]')).color,
    profile: getComputedStyle(document.querySelector(".profile-pill")).color,
  }));
  expect(Object.values(metrics.inverse.ink).every((color) => color === "rgb(26, 24, 23)" || color === "rgb(55, 51, 47)"), "inverse controls lack dark ink on the sand theme: " + JSON.stringify(metrics.inverse.ink));
  await page.screenshot({ path: join(qaRoot, "ui-inverse.png"), fullPage: true });

  await page.locator("#wsBtn").click();
  expect(await page.locator('[role="dialog"][aria-modal="true"]').count() === 1, "folder dialog lacks modal semantics");
  await page.waitForFunction(() => document.activeElement.id === "fsCancel");
  if (pageErrors.length) throw new Error("browser errors:\n" + pageErrors.join("\n"));
  await writeFile(join(qaRoot, "ui-regression-metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  console.log("ui-regression: passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
