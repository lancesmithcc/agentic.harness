#!/usr/bin/env bun
/**
 * DeepHarness CLI — one agent environment, many minds.
 */
import { Command, Option } from "commander";
import {
  activeProfileName,
  setActiveProfileName,
  ensureHarnessHome,
  loadConfig,
  HARNESS_HOME,
  SecretStore,
} from "@harness/core";
import { buildFleet, fleetModels } from "@harness/providers";
import { findDelegationDoc, parseDelegation, route } from "@harness/router";
import { scanSkills } from "@harness/skills";
import { scanTools } from "@harness/tools";
import { compileContext } from "@harness/context";
import { loginSubscription } from "@harness/profiles";
import { SessionStore, listSessions, usageSummary } from "@harness/sessions";
import { askRouted, runPipeline, type OrchestratorContext } from "./orchestrator.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderHealth } from "@harness/core";

const program = new Command();
program
  .name("harness")
  .description("One agent environment, many minds. Local agent runtime with delegation.md-driven routing.")
  .version("0.1.0")
  .addOption(new Option("--profile <name>", "one-off profile override (home|work)").choices(["home", "work"]));

function currentProfile(opts: { profile?: string }): string {
  return opts.profile ?? activeProfileName();
}

async function buildContext(profile: string, opts: { noHealth?: boolean } = {}): Promise<OrchestratorContext> {
  const fleet = await buildFleet(profile);
  const models = await fleetModels(fleet);
  const health = new Map<string, ProviderHealth>();
  if (!opts.noHealth) {
    await Promise.all(
      [...fleet.providers.entries()].map(async ([id, p]) => {
        health.set(id, await p.health());
      }),
    );
  }
  const loaded = loadConfig(profile);
  const delegationDoc = findDelegationDoc(loaded.projectDir, HARNESS_HOME, profile);
  const delegation = delegationDoc ? parseDelegation(delegationDoc.text, delegationDoc.path) : null;
  const session = new SessionStore(profile);
  session.append({ v: 1, ts: new Date().toISOString(), kind: "session-start", sessionId: session.sessionId, profile, cwd: process.cwd() });
  return { providers: fleet.providers, models, health, delegation, session, profile };
}

// ---------------------------------------------------------------------------

program
  .command("profile")
  .description("show or switch the active profile (home|work)")
  .argument("[name]", "profile to switch to")
  .action((name: string | undefined) => {
    ensureHarnessHome();
    if (!name) {
      const active = activeProfileName();
      console.log(`● home ${active === "home" ? "(active)" : ""}`);
      console.log(`○ work ${active === "work" ? "(active)" : ""}`);
      return;
    }
    setActiveProfileName(name);
    console.log(`Active profile: ${name.toUpperCase()}`);
  });

program
  .command("status")
  .description("provider matrix, skills, MCP servers, tools for the active profile")
  .action(async (opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const ctx = await buildContext(profile);
    console.log(`Profile: ${profile.toUpperCase()}\n`);
    for (const [id, h] of ctx.health) {
      const modelsHere = ctx.models.filter((m) => m.provider === id);
      const label = modelsHere.slice(0, 3).map((m) => m.model).join(", ") + (modelsHere.length > 3 ? ", …" : "");
      console.log(`${h.ok ? "✓" : "✗"} ${id.padEnd(14)} ${h.detail}${label ? `  [${label}]` : ""}`);
    }
    const skills = await scanSkills({ cwd: process.cwd(), harnessHome: HARNESS_HOME });
    const tools = await scanTools();
    console.log(`\nSkills detected: ${skills.filter((s) => s.type === "agent-skill").length}`);
    console.log(`MCP servers: ${skills.filter((s) => s.type === "mcp").length}`);
    console.log(`CLI tools: ${tools.filter((t) => t.available).length}`);
    console.log(`delegation.md: ${ctx.delegation ? ctx.delegation.sourcePath + ` (${ctx.delegation.rows.length} rows)` : "not found (heuristic routing only)"}`);
  });

program
  .command("ask")
  .description("ask a task; routed to the best model per delegation.md")
  .argument("<task...>", "the task or question")
  .option("-m, --model <model>", "pin a model (qualified id like kimi/k3, or --auto)")
  .option("--auto", "ignore pins, route automatically")
  .option("--escalate", "escalate one tier up before routing")
  .option("--session <id>", "resume a session")
  .option("--json", "print JSON result instead of text")
  .action(async (taskParts: string[], opts: { profile?: string; model?: string; auto?: boolean; escalate?: boolean; session?: string; json?: boolean }) => {
    const profile = currentProfile(opts);
    const task = taskParts.join(" ");
    const ctx = await buildContext(profile);
    const session = opts.session ? new SessionStore(profile, opts.session) : ctx.session;
    session.append({ v: 1, ts: new Date().toISOString(), kind: "user-message", text: task });

    const history = session.messages().slice(0, -1);
    const decision0 = route({ task, models: ctx.models, health: ctx.health, delegation: ctx.delegation, escalate: opts.escalate });
    const target = ctx.models.find((m) => m.id === decision0.selected);
    const messages = target
      ? compileContext(task, target, { cwd: process.cwd(), history })
      : [{ role: "user" as const, content: task }];

    if (!opts.json) {
      console.error(`→ ${decision0.selected} (${decision0.category}, confidence ${decision0.confidence.toFixed(2)})${decision0.fallbacks.length ? `  fallbacks: ${decision0.fallbacks.join(", ")}` : ""}`);
    }
    const result = await askRouted(ctx, task, messages, { pinnedModel: opts.auto ? undefined : opts.model, escalate: opts.escalate, onEvent: (e) => {
      if (opts.json || e.type !== "text-delta") return;
      process.stdout.write(e.text);
    } });
    if (opts.json) {
      console.log(JSON.stringify({ ...result, decision: result.decision }, null, 2));
    } else {
      if (!result.text.endsWith("\n")) console.log();
      for (const fb of result.fellBack) console.error(`↳ ${fb.from} unavailable (${fb.cause}); continued with ${fb.to}`);
      console.error(`✓ ${result.modelUsed} · session ${session.sessionId}${result.usage.inputTokens ? ` · ${result.usage.inputTokens}→${result.usage.outputTokens} tok` : ""}`);
    }
  });

program
  .command("models")
  .description("list models for one or all providers")
  .argument("[provider]", "provider id (deepseek, zai, kimi, minimax, openrouter, local, claude-code, codex)")
  .action(async (providerArg: string | undefined, opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const ctx = await buildContext(profile);
    const rows = ctx.models.filter((m) => !providerArg || m.provider === providerArg);
    if (rows.length === 0) {
      console.error(`no models${providerArg ? ` for provider "${providerArg}"` : ""}; check provider config/keys`);
      process.exitCode = 1;
      return;
    }
    for (const m of rows) {
      const c = m.capabilities;
      const tags = [
        c.coding !== undefined ? `coding ${c.coding}` : null,
        c.reasoning !== undefined ? `reasoning ${c.reasoning}` : null,
        c.context ? `${Math.round(c.context / 1000)}k ctx` : null,
        c.local ? "local" : null,
        c.billing,
        c.thinking ? "thinking" : null,
      ].filter(Boolean);
      console.log(`${m.id.padEnd(38)} ${tags.join(" · ")}`);
    }
  });

const modelCmd = program.command("model").description("manage model preferences");
modelCmd
  .command("add <qualified>")
  .description("register a discovered model id (e.g. openrouter/xyz) as a profile default candidate")
  .action(async (qualified: string, opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const ctx = await buildContext(profile, { noHealth: true });
    if (!ctx.models.some((m) => m.id === qualified)) {
      console.error(`"${qualified}" not discovered in the fleet; run: harness models`);
      process.exitCode = 1;
      return;
    }
    const profileToml = join(HARNESS_HOME, "profiles", profile, "profile.toml");
    const existing = existsSync(profileToml) ? readFileSync(profileToml, "utf8") : "";
    const addition = existing.trim().length
      ? `\n[defaults]\nmodel = "${qualified}"\n`
      : `[defaults]\nmodel = "${qualified}"\n`;
    writeFileSync(profileToml, existing + addition, "utf8");
    console.log(`set profile default model: ${qualified}`);
  });

program
  .command("explain")
  .description("show the routing decision for a task without executing it")
  .argument("<task...>", "the task")
  .option("-m, --model <model>", "explain as if pinned")
  .action(async (taskParts: string[], opts: { profile?: string; model?: string }) => {
    const profile = currentProfile(opts);
    const task = taskParts.join(" ");
    const ctx = await buildContext(profile);
    const d = route({ task, models: ctx.models, health: ctx.health, delegation: ctx.delegation, pinnedModel: opts.model });
    console.log(`Task: ${task}`);
    console.log(`Category: ${d.category} (via ${d.classifiedBy}, confidence ${d.confidence.toFixed(2)})`);
    console.log(`\nSelected: ${d.selected}\n`);
    console.log("Reason:");
    for (const r of d.reason) console.log(`• ${r}`);
    console.log(`\nFallback:`);
    for (const f of d.fallbacks) console.log(`- ${f}`);
    if (ctx.delegation?.sourcePath) console.log(`\ndelegation.md: ${ctx.delegation.sourcePath}`);
  });

program
  .command("doctor")
  .description("full health check of profile, providers, local runtimes, skills, routing")
  .action(async (opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const ctx = await buildContext(profile);
    const skills = await scanSkills({ cwd: process.cwd(), harnessHome: HARNESS_HOME });
    const tools = await scanTools();
    console.log("Harness Doctor\n");
    console.log(`Profile\n✓ ${profile}\n`);
    console.log("Providers");
    for (const [, h] of ctx.health) console.log(`${h.ok ? "✓" : "✗"} ${h.provider.padEnd(14)} ${h.detail}`);
    console.log("\nAgent infrastructure");
    console.log(`✓ ${skills.filter((s) => s.type === "agent-skill").length} skills`);
    console.log(`✓ ${skills.filter((s) => s.type === "mcp").length} MCP servers`);
    console.log(`✓ ${tools.filter((t) => t.available).length} / ${tools.length} known CLI tools available`);
    console.log("\nRouting");
    if (ctx.delegation) {
      const rows = ctx.delegation.rows;
      console.log(`✓ delegation.md valid (${ctx.delegation.sourcePath}; ${rows.length} models, ${ctx.delegation.frontmatter ? "front-matter + " : ""}rows)`);
      const { resolveModelRef } = await import("@harness/router");
      for (const r of rows) {
        const hit = resolveModelRef(r.model, ctx.models);
        console.log(`  ${hit ? "✓" : "⚠"} ${r.model.padEnd(20)} → ${hit?.id ?? "no match in fleet"}`);
      }
    } else {
      console.log("✗ delegation.md not found (copy one to ~/.deepharness/delegation.md or .harness/delegation.md)");
    }
    const okCount = [...ctx.health.values()].filter((h) => h.ok).length;
    console.log(`\n${okCount} of ${ctx.health.size} providers healthy. System ${okCount > 0 ? "ready" : "degraded"}.`);
  });

program
  .command("skills")
  .description("skill discovery")
  .command("scan")
  .description("scan known locations for agent skills and MCP servers")
  .action(async (opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const entries = await scanSkills({ cwd: process.cwd(), harnessHome: HARNESS_HOME });
    for (const e of entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))) {
      console.log(`${e.type === "mcp" ? "◈" : "★"} ${e.name.padEnd(28)} ${e.type.padEnd(11)} ${e.source}`);
      if (e.description) console.log(`  ${e.description}`);
    }
    console.log(`\n${entries.length} entries`);
  });

program
  .command("tools")
  .description("CLI tool discovery")
  .command("scan")
  .description("detect useful executables in $PATH")
  .action(async () => {
    const entries = await scanTools();
    for (const t of entries) {
      console.log(`${t.available ? "✓" : "✗"} ${t.name.padEnd(14)} ${t.version ?? ""}`);
    }
    console.log(`\n${entries.filter((t) => t.available).length}/${entries.length} available`);
  });

const secretCmd = program.command("secret").description("manage API keys in the macOS Keychain");
secretCmd
  .command("set <provider>")
  .description("store an API key (reads value from stdin)")
  .action(async (provider: string, opts: { profile?: string }) => {
    const store = new SecretStore(currentProfile(opts));
    const value = readFileSync(0, "utf8").trim();
    store.set(provider, value);
    console.log(`stored harness/${currentProfile(opts)}/${provider} in Keychain`);
  });
secretCmd
  .command("get <provider>")
  .action(async (provider: string, opts: { profile?: string }) => {
    const store = new SecretStore(currentProfile(opts));
    const v = store.get(provider);
    if (v) console.log(v);
    else { console.error("not found"); process.exitCode = 1; }
  });
secretCmd
  .command("list")
  .action(async (opts: { profile?: string }) => {
    const store = new SecretStore(currentProfile(opts));
    for (const name of store.list()) console.log(`harness/${currentProfile(opts)}/${name}`);
  });

program
  .command("auth")
  .description("log in subscription CLIs inside the profile's isolated environment")
  .argument("<provider>", "claude | codex")
  .action(async (provider: string, opts: { profile?: string }) => {
    if (provider !== "claude" && provider !== "codex") {
      console.error("auth supports: claude, codex");
      process.exitCode = 1;
      return;
    }
    const code = await loginSubscription(provider, currentProfile(opts));
    process.exitCode = code;
  });

program
  .command("usage")
  .description("usage rollup for the profile")
  .action(async (opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const rows = await usageSummary(profile);
    if (rows.length === 0) {
      console.log("no usage recorded yet");
      return;
    }
    const byModel = new Map<string, { tokens: number; cost: number; calls: number }>();
    for (const r of rows) {
      const k = r.model.includes("/") ? r.model : `${r.provider}/${r.model}`;
      const agg = byModel.get(k) ?? { tokens: 0, cost: 0, calls: 0 };
      agg.tokens += r.totalTokens;
      agg.cost += r.costUsd;
      agg.calls += 1;
      byModel.set(k, agg);
    }
    for (const [k, v] of byModel) {
      console.log(`${k.padEnd(40)} ${String(v.calls).padStart(4)} calls  ${String(v.tokens).padStart(9)} tok  $${v.cost.toFixed(4)}`);
    }
  });

const sessionCmd = program.command("session").description("inspect sessions");
sessionCmd
  .command("list")
  .action(async (opts: { profile?: string }) => {
    for (const s of listSessions(currentProfile(opts))) {
      console.log(`${s.id.padEnd(24)} ${s.events} events  ${s.modified}`);
    }
  });
sessionCmd
  .command("show <id>")
  .action(async (id: string, opts: { profile?: string }) => {
    const store = new SessionStore(currentProfile(opts), id);
    for (const e of store.all()) {
      const ts = e.ts.slice(11, 19);
      if (e.kind === "user-message") console.log(`\n[${ts}] user: ${e.text.slice(0, 200)}`);
      else if (e.kind === "assistant-text") console.log(`[${ts}] ${e.model}: ${e.text.slice(0, 300)}`);
      else if (e.kind === "routing") console.log(`[${ts}] route → ${e.decision.selected}`);
      else if (e.kind === "fallback") console.log(`[${ts}] fallback ${e.from} → ${e.to} (${e.cause})`);
      else if (e.kind === "usage") console.log(`[${ts}] usage ${JSON.stringify(e.usage)}`);
    }
  });

program
  .command("agent")
  .description("multi-agent pipeline: planner → workers → reviewer (different models per role)")
  .argument("<task...>", "the task")
  .action(async (taskParts: string[], opts: { profile?: string }) => {
    const profile = currentProfile(opts);
    const task = taskParts.join(" ");
    const ctx = await buildContext(profile);
    console.log(`Task: ${task}\n`);
    const result = await runPipeline(ctx, task, {
      onAgentStart: (role, model) => console.log(`\n━━ ${role} → ${model}`),
    });
    console.log("\n════ REVIEW ════\n");
    console.log(result.review.text);
    console.log(`\nmodels used: plan=${result.plan.modelUsed}, workers=${result.workers.map((w) => w.modelUsed).join(", ")}, review=${result.review.modelUsed}`);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
