# agentic.harness

**One agent environment, many minds.**

A local agent runtime with a web interface, macOS desktop app, and CLI. The harness reads your task, project context, provider availability, capability metadata, and `delegation.md`, then routes the work to a suitable model. Its name and runtime identity are **agentic.harness**; existing `~/.deepharness` data paths remain compatible.

## Quick start

```bash
bun install
bun test                          # isolated unit and integration tests
bun apps/cli/bin/harness status   # provider matrix for the active profile
```

Run `bun apps/cli/bin/harness` directly, or link it into your PATH as `harness` (Bun required).

Source repository: [lancesmithcc/agentic.harness](https://github.com/lancesmithcc/agentic.harness).

For the web interface, run `bun apps/web/src/server.ts` and open `http://127.0.0.1:8790`. Build the native macOS app using [the desktop guide](apps/desktop/README.md).

## The fleet

| Provider | Auth | Route |
|---|---|---|
| Claude | Claude Pro/Max login (`harness auth claude`) | Claude Code CLI, isolated `CLAUDE_CONFIG_DIR` |
| OpenAI | ChatGPT login (`harness auth codex`) | Codex CLI, isolated `CODEX_HOME` |
| Z.AI | Coding Plan key | `api.z.ai/api/coding/paas/v4` |
| Kimi | Coding Plan key | `api.kimi.com/coding/v1` (k3, k3-256k, kimi-for-coding, highspeed) |
| DeepSeek | API key | `api.deepseek.com` |
| DeepSeek Harness | Same DeepSeek key | Official SDK `0.1.5-rc.2`, with file and shell tools, native session logging, and context compaction |
| MiniMax | API key | `api.minimax.io/v1` |
| OpenRouter | API key | dynamic model discovery |
| Local | none | llama.cpp / Ollama / LM Studio / MLX autodetect (e.g. gemma-4-12b-it on :8088) |

Subscription credentials stay owned by their official CLIs. API keys can come from the local process environment or macOS Keychain; committed config files should only hold `keychain://harness/<profile>/<provider>` references.

Every API and local adapter supports file, shell, and registered MCP tools through the shared official SDK agent loop. Action tasks and follow-ups after tool work automatically use that runtime; plain text requests retain direct streaming. All routes honor the selected read-only, workspace, or full file access. Tool calls and results are saved with the chat and remain visible after reload. An API caller can explicitly select execution with `tools: true` on `/api/ask`.

Local llama.cpp context limits are detected from the running server, rather than the model's theoretical maximum. Other local endpoints can set `contextWindow` in their config. Small contexts use a compact runtime that keeps file, shell and MCP tools while omitting optional orchestration tools. Source runs need the SDK's supported Node runtime; the desktop app bundles it.

## Profiles

`home` and `work` keep separate credentials, providers, sessions, histories, delegation rules, and logs under `~/.deepharness/profiles/<name>/`.

```bash
harness profile          # ● home / ○ work
harness profile work     # switch
harness --profile home ask "..."   # one-off, no switching
```

## delegation.md — the philosophical center

Routing policy lives in a readable document (precedence: project `.harness/delegation.md` → profile → `~/.deepharness/delegation.md`). Two shapes, combinable:

**Human table** (the live format — TSV or markdown pipes):

```
GLM-5.3 Flash	⭐ **Default production worker**	Coding, research, repo inspection, tool use, ...	Final judgment on the hardest problems
DeepSeek V4.1 Flash	⭐ **Code + automation engineer**	Debugging, multi-file edits, tests, terminal work, ...	...
```

**Optional YAML front matter** for explicit control:

```
---
local_first: true
max_parallel_agents: 5
routing:
  architecture: [claude, codex, kimi-k3]
  simple: [gemma-local]
---
```

The router classifies the task (keywords + capability + context-size signals), honors front-matter routing lists, boosts models whose *Best For* matches, demotes models whose *Avoid For* matches, prefers `local → subscription/coding-plan → API` on ties, and always emits a diverse fallback chain.

## Commands

```bash
harness ask "task"                 # routed ask with live fallback
harness ask -m kimi/k3 "task"      # pin a model
harness ask --escalate "task"      # one tier up before routing
harness explain "task"             # why which model (never a black box)
harness models [provider]          # live model discovery
harness doctor                     # full health check
harness status                     # provider matrix + skills/MCP/tools counts
harness skills scan                # agent skills + MCP servers (~/.claude, ~/.agents, ~/.zcode, .mcp.json, ...)
harness tools scan                 # CLI tools in $PATH
harness secret set deepseek        # store API key in Keychain (stdin)
harness auth claude|codex          # isolated subscription login per profile
harness session list|show <id>     # provider-neutral JSONL sessions
harness usage                      # per-model token/cost rollup (SQLite)
harness agent "task"               # planner → workers → reviewer pipeline
```

## Architecture

```
apps/cli            commander CLI + orchestrator (fallback, escalation, multi-agent)
packages/core       types, universal ModelProvider interface, TOML config, Keychain secrets
packages/router     delegation.md parser, task classifier, routing engine
packages/providers  claude-code, codex, openai-compat base + deepseek/zai/kimi/minimax/openrouter, local
packages/skills     skill + MCP discovery
packages/tools      $PATH tool discovery
packages/context    context compiler (relevant files, git state, per-model budgets)
packages/sessions   JSONL session store + SQLite usage rollups
packages/profiles   profile switching + isolated subscription logins
```

Sessions are provider-neutral event logs: a conversation can move Gemma → DeepSeek → Claude → Codex without losing history.

## Multi-agent rules

The planner/worker/reviewer pipeline routes each role independently and enforces the delegation.md verification rule: **a model never reviews its own major implementation** — the reviewer is chosen from a different provider whenever the fleet allows.

## Self-evolve

Each chat remembers its own working folder. General questions and code requests refer to that folder; switching chats restores the folder selected for that conversation. A missing folder produces a clear error instead of redirecting work elsewhere.

Enable **🧬** in the chat composer (tooltip: **self evolve**) to permit explicit changes to agentic.harness. The toggle belongs to that chat and starts off in new chats. When explicitly asked, file-capable agents can rewrite any part of the harness source: UI, runtime, routing, providers, desktop shell, build tools, and tests. Read-only access still prevents writes. Explicit self-evolve tasks temporarily use the source checkout; the chat keeps its selected project folder for subsequent ordinary work.

The app records before/after commits on `self-evolve`, syncs them to GitHub, and exposes a file-aware rollback action. Rollback creates another commit and preserves newer local edits. `main` holds the published application; checkpoint sync never force-pushes or changes the checked-out branch or staging area. Offline checkpoints remain local with visible sync status and retry.

Read the [self-evolve workflow](docs/SELF_EVOLVE.md) for recovery and rebuild steps. An installed desktop bundle must be rebuilt and reinstalled to run changed source.

## Verification

`bun test`, `bun run typecheck`, and `node scripts/ui-regression.mjs` exercise isolated chat persistence, routing, provider protocols, source checkpoints, rollback, and rendered UI. See [the review record](docs/GAUNTLET.md) for live runtime evidence and limits.
