# PRODUCT.md — lancesmith.cc harness

## Truth
- Product: **lancesmith.cc harness** — a local multi-model agent runtime (CLI + web app). One agent environment, many minds.
- Owner/user: Lance (personal + work). macOS-first.
- Mechanism: reads `delegation.md` (internal routing reference) + live provider health + capability metadata, routes each task to the best-fit model across the fleet, with fallback, escalation, and cross-model verification.
- Fleet: Claude (Code subscription), Codex (ChatGPT), Z.AI GLM 5.3 (+flash), Kimi K3/K2.7, DeepSeek V4, MiniMax M3/M2.7, local Gemma 4 12B; planned OpenAI GPT 5.6 sol/terra/luna, Claude Opus 5, GPT 6 Astra (orchestrator-only, toggle-gated, token-hungry).

## Web surface (Operate)
- Audience: Lance, daily, on a MacBook, long sessions, often at night — dark gold is the default scene; the inverse blue mode is for bright rooms/daylight.
- Job: run tasks through the fleet; watch routing decisions; manage models, delegate roles, routines, artifacts, skills, tools & MCP; switch home/work profiles.
- Action: type a task → watch the harness pick a mind (and fall back live) → read the answer; manage the fleet in Settings.
- Proof: live provider health, real routing reasons from delegation.md, session/usage history.
- Constraints: local-only data; secrets in Keychain; Bun runtime; no external CDNs (self-host fonts/assets).

## Brand commitments (user-pinned)
- Name/lockup: sriyantra icon + "lancesmith.cc" (Poppins) + tracked "HARNESS".
- Type: Poppins Regular body; headings Bold; subheading/light treatment via Regular + reduced weight color.
- Default (gold) mode: accents #ffdf2c / #fff694, bg.png tiled dark field, gold sriyantra.png.
- Inverse (blue) mode: accents #0020d3 / #00096b, bg-light.png tiled light field, blue sriyantra-light.png.
- Loading/thinking copy: enlightened hypersentient consciousness register (Crystallizing, Cultivating the frequency, Harmonizing, Transmuting, Alchemizing, Illuminating, Regenerating…).
- Interface form: Claude Code-like (left rail: sessions/nav; center: conversation; composer with model selector) — earned familiarity, the tool disappears into the task.
