# DESIGN.md — lancesmith.cc harness (web client)

Recorded from the built world (apps/web/index.html + brand.css + assets). Ground truth over intention.

## World
A Claude Code-style operator shell (left rail / topbar / conversation / composer) wearing the lancesmith.cc identity: a gold Sri Yantra mark on a deep charcoal field laced with a 555px tile (bg.png) under a readability veil. The inverse field flips to deep electric blue on the light tile. The mark breathes while the fleet thinks.

## Tokens
- Fonts (self-hosted, assets/fonts): Poppins Regular 400 (body), Bold 700 (headings, brand name); Italic/BoldItalic loaded. Sub-brand "HARNESS" = Regular, 10px, letter-spacing .34em.
- Gold mode (default): accent #ffdf2c, accent-soft #fff694, bg #0b0a08 + bg.png tile, surface rgba(16,14,11,.82), text #f4efe2 / #b3ab97 / #7d7663, borders rgba(255,223,44,.16/.34), ok #8fe388, fail #ff7d72, amber #ffcf6e.
- Inverse mode ([data-theme="inverse"]): accent #0020d3, accent-soft #3d55e8, bg #eef0fb + bg-light.png tile, surface rgba(255,255,255,.82), text #101223/#3d4368/#767ca3, borders rgba(0,32,211,.16/.36).
- Radii 14/10px; shadows carry offset+blur; glow = 1px accent ring + soft accent bloom. Motion 160/240ms, cubic-bezier(.22,1,.36,1).

## Components
Rail: brand lockup (40px mark + name/sub), accent New session, nav items (hover translateX + surface, active = accent + inset bar), profile pill, theme toggle (icon swaps sriyantra.png ↔ sriyantra-light.png). Topbar: working-folder button (svg folder + name, opens directory browser), crumb, fleet chips with hover mini-roster popovers. Conversation: assistant bubbles (surface + border + shadow, model pill, collapsible reasoning), user bubbles (accent-tinted), centered routing/fallback/error syslines, thinking line (spinning mark + rotating hypersentient verbs from verbs.json). Composer: focus-glow card, AUTO pin select (orchestrator-only entries disabled unless gated), escalate + orchestrator checkboxes, Send/Stop. Panels: Settings (theme switch, Astra gate, model roster with cap bars + best-at tags + dormant marks, delegation.md cards), Routines, Artifacts (sessions), Skills, Tools. Folder browser overlay: breadcrumb + directory list + Choose.

## Voice
Thinking/status copy uses the hypersentient register (Crystallizing, Cultivating the frequency, Harmonizing, Transmuting, Alchemizing, Illuminating, Regenerating + 17 more), rotating every 2.2s while a model works.

## Rules carried forward
Poppins only; no external CDNs; overlays use fixed positioning and [hidden] display:none; sriyantra mark is the sole icon motif (folder/chevrons drawn as thin svg/clip-path geometry); accent color means action/selection, never decoration; both themes must keep body text ≥4.5:1 on the veiled tile.
