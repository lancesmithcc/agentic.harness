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
const state = { cancels: 0, deleteAttempts: 0, syncCalls: 0, savedSessions: [] };
const sessionEvents = {
  old: Array.from({ length: 18 }, (_, i) => ({ v: 1, kind: i % 2 ? "assistant-text" : "user-message", model: "fake/worker", text: "Older message " + i + "\n" + "context ".repeat(90) })),
  new: [
    { v: 1, kind: "user-message", text: "The selected transcript" },
    { v: 1, kind: "assistant-delta", turnId: "partial", model: "fake/worker", text: "Recovered partial answer." },
    { v: 1, kind: "user-message", text: "Later user message" },
    { v: 1, kind: "assistant-delta", turnId: "complete", model: "fake/worker", text: "superseded journal text" },
    { v: 1, kind: "assistant-text", turnId: "complete", model: "fake/worker", text: "New transcript wins." },
    { v: 1, kind: "self-change", before: "1111111", after: "2222222", beforeCommit: "1111111", afterCommit: "abcdef1234567890", branch: "self-evolve", repoUrl: "https://github.com/lancesmithcc/agentic.harness", files: [{ path: "apps/web/index.html", status: "M" }] },
  ],
};
function json(res, data, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
function sse(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function fakeStatus(profile) {
  return { profile, profiles: ["home", "work"], workspace: "/tmp/fake-" + profile,
    settings: { theme: "gold", astraAvailable: false, reasoningOff: false }, providers: [] };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const profile = url.searchParams.get("profile") || "home";
  if (url.pathname === "/api/meta") return json(res, { verbs: ["Preparing"], settings: { theme: "gold" }, models: [] });
  if (url.pathname === "/api/status") return json(res, fakeStatus(profile));
  if (url.pathname === "/api/sessions") return json(res, { sessions: state.savedSessions.concat([{ id: "old", title: "Old transcript", events: 4 }, { id: "new", title: "New transcript", events: 2 }]) });
  if (url.pathname === "/api/session") {
    const id = url.searchParams.get("id");
    if (req.method === "DELETE") {
      state.deleteAttempts++;
      return json(res, { error: "Session has an active turn and cannot be deleted." }, 409);
    }
    return setTimeout(() => json(res, { events: sessionEvents[id] || [] }), id === "old" ? 180 : 5);
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
    const task = JSON.parse(body || "{}").task || "";
    const session = "turn-" + task;
    state.savedSessions = [{ id: session, title: task + " request", events: 1 }].concat(state.savedSessions.filter((s) => s.id !== session));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, { t: "accepted", session });
    if (task === "error") return setTimeout(() => { sse(res, { t: "error", message: "Fake route failed" }); res.end(); }, 20);
    if (task === "sample") return setTimeout(() => {
      sse(res, { t: "route", session, decision: { selected: "fake/worker" } });
      sse(res, { t: "tool", id: "tool-1", name: "workspace.search" });
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
  await page.getByRole("button", { name: "Delete session Old transcript" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("active turn and cannot be deleted"));
  expect(state.deleteAttempts === 1 && await page.evaluate(() => window.__S.sessionId === "old"), "409 delete cleared the selected session");
  await page.getByRole("button", { name: "work" }).click();
  await page.waitForFunction(() => document.querySelector("#profilePill").textContent === "work");
  expect(await page.locator("#profilePill").textContent() === "work", "profile switch did not win");
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.waitForFunction(() => document.body.innerText.includes("GitHub sync needs retry"));
  expect(await page.locator('.self-commit:not(a)').count() === 1, "pending self-evolve checkpoint was presented as a remote commit");
  await page.getByRole("button", { name: "Retry sync" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("GitHub synced"));
  expect(state.syncCalls === 1, "self-evolve retry did not call sync endpoint");
  expect(await page.locator('.self-commit[href="https://github.com/lancesmithcc/agentic.harness/commit/abcdef1234567890"]').count() === 1, "synced self-evolve checkpoint is missing its safe GitHub link");
  await page.locator('.nav-item[data-view="chat"]').click();

  await send("late");
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.__S.sessionId === null), "late route replaced fresh session");
  expect(!(await page.locator("#view").innerText()).includes("late response"), "late stream rendered into fresh session");
  await page.waitForFunction(() => document.querySelector("#chatList").innerText.includes("late request"));
  expect(state.savedSessions.some((s) => s.id === "turn-late"), "detached accepted turn was not retained by isolated history");

  await page.getByText("New transcript", { exact: true }).click();
  await page.waitForTimeout(240);
  expect((await page.locator("#view").innerText()).includes("New transcript wins."), "late boot hydration overwrote selected history");
  expect((await page.locator("#view").innerText()).includes("Local checkpoint abcdef12"), "recorded self-change overclaimed an unsynced remote commit");
  expect(!(await page.locator("#view").innerText()).includes("superseded journal text"), "committed turn replayed duplicate deltas");
  expect((await page.locator("#view").innerText()).includes("Recovered partial answer."), "uncommitted journal deltas were not recovered");
  const replay = await page.locator("#view").innerText();
  expect(replay.indexOf("Recovered partial answer.") < replay.indexOf("Later user message"), "journal partial was appended after later history");

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
  expect(await page.locator(".tool-name").last().innerText() === "workspace.search", "tool activity was not rendered");
  expect(await page.locator(".tool-state").last().innerText() === "Finished", "tool activity did not settle on final stream event");
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
  await page.locator("#mobileMenu").click();
  expect(await page.locator("#mobileMenu").getAttribute("aria-expanded") === "true", "mobile menu did not open");
  expect(await page.locator('.rail.mobile-open .nav-item[data-view="settings"]').count() === 1, "Settings is not reachable from mobile navigation");
  await page.screenshot({ path: join(qaRoot, "ui-narrow-menu.png"), fullPage: true });
  await page.locator('.rail.mobile-open .nav-item[data-view="settings"]').click();
  await page.waitForFunction(() => document.querySelector("#crumb").textContent === "Settings");
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
  expect(Object.values(metrics.inverse.ink).every((color) => color === "rgb(26, 24, 23)"), "inverse controls lack dark ink on the sand theme: " + JSON.stringify(metrics.inverse.ink));
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
