#!/bin/bash
# lancesmith.cc harness web app — starts with ~/.local/bin first on PATH
# (codex 0.154+ lives there; older homebrew codex lacks the 5.6 models)
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
exec bun apps/web/src/server.ts
