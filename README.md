# DeepHarness

**One agent environment, many minds.**

A local agent runtime (macOS CLI today, Tauri shell later) that gives one interface to many coding and reasoning models. The harness reads your task, the project context, provider availability, capability metadata, and — above all — your `delegation.md`, then sends each part of the work to the most suitable model.

## Quick start

```bash
bun install
bun test                          # 18 unit tests
bun apps/cli/bin/harness status   # provider matrix for the active profile
```

A `harness` symlink is installed at `~/.local/bin/harness` (Bun required).

## The fleet

| Provider | Auth | Route |
|---|---|---|
| Claude | Claude Pro/Max login (`harness auth claude`) | Claude Code CLI, isolated `CLAUDE_CONFIG_DIR` |
| OpenAI | ChatGPT login (`harness auth codex`) | Codex CLI, isolated `CODEX_HOME` |
| Z.AI | Coding Plan key | `api.z.ai/api/coding/paas/v4` |
| Kimi | Coding Plan key | `api.kimi.com/coding/v1` (k3, k3-256k, kimi-for-coding, highspeed) |
| DeepSeek | API key | `api.deepseek.com` |
| MiniMax | API key | `api.minimax.io/v1` |
| OpenRouter | API key | dynamic model discovery |
| Local | none | llama.cpp / Ollama / LM Studio / MLX autodetect (e.g. gemma-4-12b-it on :8088) |

Subscription credentials stay owned by their official CLIs. API keys live in the macOS Keychain — config files only hold `keychain://harness/<profile>/<provider>` references.

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

## Non-goals (v1)

No editor, no terminal emulator, no cloud sync, no multi-user, no hosted inference, no billing management. The CLI/runtime comes first; Tauri becomes the shell once the engine is boringly reliable.
