# agentic.harness — macOS app

A native macOS window (Tauri 2) around the agentic.harness web UI.

## What happens at launch

1. A bundled splash shows while the harness starts.
2. If a harness already answers on `127.0.0.1:8790` (for example `bun apps/web/src/server.ts`), the app uses it.
3. Otherwise it starts the bundled `harness-server` binary, bound to `127.0.0.1` only, with your login shell's
   environment so `claude`, `codex`, `bun` and provider API keys are found. Its log goes to
   `~/.deepharness/logs/desktop-server.log`.
4. Quitting the app stops the server it started (a reused one keeps running).

Downloads from chat are saved to `~/Downloads`. External links open in your default browser.

## Build

Builds on Apple Silicon macOS 13.5 or newer, matching the bundled Node binary's minimum OS. Requires Rust (`rustup`), Bun, Node/npm for dependency staging, and the Xcode command line tools. End users do not need Node or Bun: the app bundles its server and the official Node 24.21.0 arm64 runtime, verified against a pinned SHA-256 checksum.

```bash
cd apps/desktop
bun install
export PATH="$HOME/.cargo/bin:$PATH"
bun run build
```

`bun run build` stages official DeepSeek SDK `0.1.5-rc.2` and its matching runtime, compiles the server into `src-tauri/binaries/harness-server-aarch64-apple-darwin`, then builds
`src-tauri/target/release/bundle/macos/agentic.harness.app`. Copy it to `/Applications` to install.
The build finishes by applying and verifying a local ad-hoc signature after all SDK resources are present. This is local signing, not Developer ID signing or notarization for public distribution.

Other scripts:

- `bun run dev` — run the app from source with a debug build
- `bun run icons` — regenerate the icon set from `src-tauri/icons/app-icon.png`

The web UI files (`apps/web/index.html`, `brand.css`, `assets/`, JSON metadata) are bundled as resources; the
compiled server finds them through `HARNESS_WEB_ROOT`.

DeepSeek's SDK bridge and Node binary are bundled under `Contents/Resources/dsh-runtime`. The launcher supplies `HARNESS_DSH_BRIDGE` and `HARNESS_NODE_PATH`, so a bare Finder environment can still run the SDK. Provider credentials are resolved locally from the login-shell environment or the profile's Keychain references. No credentials are packaged.

All API and local backends use this SDK for file, shell, and MCP tasks. The SDK reports committed assistant steps; live tool activity appears while it works. Plain text requests retain direct token streaming. Each tool turn runs in a fresh native SDK session with bounded prior conversation; native logs are retained under `~/.deepharness/profiles/<profile>/harness-runtime`.

Validation evidence and known limits: [Gauntlet review](../../docs/GAUNTLET.md).
