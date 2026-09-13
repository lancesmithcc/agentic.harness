# agentic.harness — Gauntlet review

Review date: September 12, 2026. Existing source edits and user data preserved. The follow-up self-evolve implementation adds GitHub publication and checkpoint history; see [the workflow](SELF_EVOLVE.md).

## Quality bar and method

The requested bar is dependable conversation continuity, clear live progress, responsive interaction, and useful agent tools comparable to everyday Codex or Claude Code workflows. This review used separate implementation workers and critics, deterministic failures, actual process crashes, rendered desktop/mobile screens, and a live DeepSeek runtime task. It does not establish broad feature parity or a blind visual win against those products.

Method: [Gauntlet Loop](https://github.com/robonuggets/gauntlet-loop), RoboNuggets / Matt Shumer, CC BY 4.0. Highest-impact gaps were repaired and rechecked rather than treating a successful build as completion.

Three delegated coding workers covered persistence, adapters/runtime, and UX. Kimi K3, GLM 5.3, MiniMax M3, and local Gemma supplied bounded planning/review/checklist drafts. Their outputs were independently checked. DeepSeek external critic attempts failed on transport/reasoning budget; they are not counted as successful reviews. The official DeepSeek runtime itself passed live inference. Credentials stayed in the primary session and local runtime.

## Repairs

| Area | Root cause or gap | Result |
|---|---|---|
| Saved history | Web and resumed CLI turns could write user and assistant events to different session IDs | One session store owns both sides; profile isolation and resumed conversation are exercised through HTTP and CLI |
| Crash recovery | Streamed text existed only in memory until completion | Text deltas are fsync-persisted before browser delivery, replayed in original order, and replaced by a matching final commit |
| Interrupted work | EOF, nonzero CLI exits, malformed SSE, and partial failures could masquerade as success | Explicit completed/interrupted/failed outcomes; visible partial output retained; tool work is never silently repeated by fallback |
| Stop and concurrency | Work continued after cancellation; concurrent turns could mix | Abort propagation, provider cleanup, one active turn per profile/session, and active-session deletion guard |
| Discovery latency | Fleet, models, and health were rebuilt per request | Immediate durable session acknowledgement; coalesced discovery cached for 15 seconds and invalidated by config/settings changes |
| Workspace routing | Web provider config could come from server cwd rather than chosen workspace | Active workspace overrides now apply to discovery and routing |
| Tool routing | Text-only model APIs advertised execution capability | All API and local backends now execute file, shell, and MCP tasks through the shared official SDK; native Codex/Claude adapters retain their own tools; fallback stops after tool activity |
| Context efficiency | Recent unrelated files and oversized history were included | Relevant bounded excerpts, secret/symlink exclusions, whole recent messages, explicit omission notice, oversized request validation |
| UX | Startup profile hydration could discard valid saved history; late responses could overwrite new/profile-switched chats; streaming repeatedly parsed Markdown | Immutable turn identity, race guards, incremental text rendering, final Markdown pass, scroll position preservation, accessible modal navigation |
| Mobile and theme | Wide controls clipped at 390px; light-theme text lost contrast | Compact mobile header and explicit navigation drawer; corrected inverse-theme contrast; reachable composer/settings/theme controls |
| Identity | Product, source folders, and underlying models were conflated | System context, web UI, CLI description, package, and desktop product identify as agentic.harness |
| Desktop runtime | Bun compilation cannot act as the SDK's Node child; developer-installed Node was required | Explicit Node bridge, pinned official SDK/runtime, verified bundled Node 24.21.0 arm64 and its license |

## Current DeepSeek integration

Verified upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) commit `c291e7961a515f6d7af9304e7fd1d257929aef26`. Matching `@deepseek-ai/dsh-sdk-client` and runtime pinned to **0.1.5-rc.2** (npm `next`; `latest` was 0.1.5-rc.1). The older global dsh installation was not changed.

The app uses actual SDK file/shell tools, permission modes, context compaction, session notifications, usage, and native persistence. Local stdio and HTTP MCP definitions become validated per-launch `dsh-mcp-client` patches; credentials are never put in command arguments. Temporary patches are owner-readable only and removed on close. Tool activity is visible in the chat.

Provider-neutral history remains authoritative when switching models. Each turn starts a fresh native SDK session with bounded prior conversation, with native SDK logs retained separately. The SDK emits committed assistant steps, not individual output tokens. Additional directories outside the selected workspace are unsupported under restricted access; existing full-access scope and directories already within the workspace are accepted. The app reports unsupported scope explicitly.

## Verification

Initial review baseline: 18 tests. That review concluded with **68 tests passed**, 168 assertions across 14 files; TypeScript typecheck and diff checks passed. Bun dependency audit and the separately staged npm runtime audit both reported zero vulnerabilities. The strict browser suite passed, including normal saved-history boot, profile-switch races, active-session delete rejection, 50 KiB rendering, mobile navigation, and theme contrast.

The packaged runtime passed with a clean PATH and isolated test home: real `read` and `mcp__fixture__marker` tool calls, correct agentic.harness identity, one durable assistant commit, and browser reload. One observed run acknowledged the request in **29 ms**, called the first tool in **1,876 ms**, and completed in **2,797 ms**. This is a single measured smoke task, not a general latency guarantee.

- [Packaged runtime screenshot](qa/packaged-runtime.png)

The final Apple Silicon app is installed at `/Applications/agentic.harness.app`, launched, and responding at `http://127.0.0.1:8790`. The old source-run server and old desktop process were stopped while idle. Existing settings, credentials, and histories remain in place. A local ad-hoc signature was applied after resource staging and passed `codesign --verify --deep --strict`; future desktop builds perform the same step. The source build and installed bundle retain the same HTML, CSS, and SDK bridge. The installed app restored existing home-profile history on a fresh browser load, with zero page errors; all eight configured providers reported healthy. Local installed-app checks are generated under `docs/qa` and excluded from publication.

Reproducible local checks:

```sh
bun test
bun run typecheck
node scripts/ui-regression.mjs
bun audit
cd apps/desktop
PATH="$HOME/.cargo/bin:$PATH" bun run build
```

For the optional live packaged check, make `DEEPSEEK_API_KEY` available in the process environment, build the desktop app, then run `node scripts/verify-packaged.mjs`. It sends one bounded test task and creates an isolated temporary home and local MCP fixture; it does not write to real chat history.

The integration suite uses isolated homes and a deterministic SSE server. It tests actual HTTP routing/storage, CLI resume, stopping, concurrent sends, profile isolation, and a `SIGKILL` during streaming followed by a server restart and successful continuation. Real histories are not used as test fixtures.

Browser evidence uses a 50 KiB streaming reply, preserved reading position, zero JavaScript/console errors, desktop and 390px viewports, modal focus, profile/navigation races, tool activity, and crash replay. The measured animation-frame gap is a synthetic rendering check, not a model-latency benchmark.

- [Desktop](qa/ui-desktop.png)
- [390px mobile](qa/ui-narrow.png)
- [Mobile menu](qa/ui-narrow-menu.png)
- [Inverse theme](qa/ui-inverse.png)

## Existing history recovery

A dry-run scan found one orphan response with ambiguous unfinished user-turn matches. It was preserved without guessing a destination, and is labeled “Recovered reply” in the history list. No real history was merged or deleted. The recovery utility requires explicit apply, creates backups of both logs, preserves the source orphan, and refuses ambiguous matches.

```sh
bun scripts/recover-split-sessions.ts --profiles-dir "$HOME/.deepharness/profiles"
```

## Remaining limits

- The pinned upstream SDK is a release candidate. This is a tested integration, not a guarantee of defect-free operation or universal Codex/Claude Code parity.
- Desktop packaging currently targets Apple Silicon macOS 13.5 or newer. Public distribution signing/notarization and Intel builds are outside this local repair.
- Native macOS WebKit visual interaction could not be inspected while the Mac was locked. Browser rendering and the actual packaged server/SDK are tested separately.
- One historical orphan remains intentionally unmerged. The old app build is retained for rollback.

## GitHub self-evolve follow-up

The self-evolve follow-up passed **84 tests**, 241 assertions across 16 files, plus TypeScript, strict browser regression, and Bun dependency audit (zero reported vulnerabilities). New coverage includes durable before/after commits, interrupted-process recovery, nested edits, retained newer work, modes, symlinks, directory replacements, sync failure, remote divergence, and HTTP chat-to-rollback integration.

A live packaged DeepSeek self-evolve smoke test used Workspace access with a separate disposable source checkout. It edited `src/engine.ts`, read the change back, emitted three tool calls, saved a source checkpoint, and restored the original through an append-only rollback commit. The complete smoke workflow took 10.246 seconds on one observed run. This exercises actual model-driven file editing and the compiled desktop server; it does not establish a general latency bound or prove arbitrary rewrites correct.

Reproduce the optional paid smoke test after building the app, with `DEEPSEEK_API_KEY` available in the process environment:

```sh
node scripts/verify-self-evolve.mjs
```

The script uses disposable source and session directories, performs no remote push, and removes its fixture afterward. Application publication and checkpoint sync use the authorized GitHub repository; the checkpoint branch records history separately from the published `main` branch.

## Shared tools follow-up — September 13, 2026

File execution previously depended on choosing a native agent adapter. API and local adapters now use the same pinned DeepSeek SDK runtime for tool tasks, including manually selected models and configured OpenAI-compatible endpoints. Ordinary text requests retain direct token streaming. Tools follow the selected workspace and access mode; read-only denial and cancellation are tested through the real SDK. API keys reach the child process through its environment, never through command arguments or temporary configuration files.

The bridge selects each provider's native protocol: OpenAI Responses, MiniMax Anthropic messages, or OpenAI-compatible completions. MiniMax's native [Anthropic-compatible API](https://platform.minimax.io/docs/api-reference/text-anthropic-api) resolved malformed thinking blocks observed through its completions route. Custom endpoint overrides remain supported.

Local context limits come from the running server, not the model's theoretical training limit. The installed Gemma server has an 8,192-token context. The SDK also reserves 4,096 tokens, which initially left only one output token with the full prompt. For small contexts, optional orchestration/search schemas are omitted and the generated source map is available on demand. Core file, shell, image-read, MCP, sandbox, identity, and self-evolve instructions remain. Shell commands provide search when dedicated search schemas are omitted.

Tool calls and results are durably saved and replayed as correlated activity. Failed tool status survives completion, replay does not duplicate assistant bubbles, and escaped result previews stay collapsed and bounded.

Final checks: **99 tests passed**, 317 assertions across 20 files; TypeScript, strict browser regression, diff checks, and Bun dependency audit passed (zero reported vulnerabilities). SDK integration tests exercise real file/shell execution, read-only denial, cancellation, and useful output budgets under an 8K context. The desktop bundle rebuilt successfully and passed its ad-hoc signature verification.

The compiled desktop server passed live file-read, shell-copy, read-back, MCP, identity, saved-event, and no-fallback checks in isolated homes:

| Route | Model | Result | Observed complete workflow |
|---|---|---|---|
| DeepSeek API | deepseek-v4-flash | Pass, 4 tool calls | 42.956 s |
| DeepSeek native SDK | deepseek-v4-flash | Pass, 4 tool calls | 6.688 s |
| Z.ai | glm-5.3-flash | Pass, 4 tool calls | 25.707 s |
| Kimi | k3 | Pass, 4 tool calls | 21.239 s |
| MiniMax | MiniMax-M3 | Pass, 4 tool calls | 11.520 s |
| Local | gemma-4-12b-it | Pass, 4 tool calls | 28.508 s |

These are individual multi-step smoke runs, not latency guarantees. OpenAI and OpenRouter protocols are covered by deterministic checks, but live checks were skipped because their API keys were unavailable. Native Codex and Claude execution paths were unchanged and were not live-retested in this follow-up. Other selectable models still depend on their endpoint implementing the advertised tool protocol.

After building the desktop bundle, reproduce with configured provider keys in the process environment:

```sh
node scripts/verify-model-tools.mjs
HARNESS_QA_MODELS=local node scripts/verify-model-tools.mjs
```

The verifier uses temporary homes, workspaces, and an MCP fixture. It does not use real chat history or enable self-evolve. JSON reports stay local under `docs/qa`.
