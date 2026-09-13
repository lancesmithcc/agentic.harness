# Self-evolve workflow

Self-evolve lets an agent change the local `agentic.harness` source tree when the user explicitly asks to change the harness. It is separate from ordinary workspace work.

Published release code belongs on GitHub `main`. Self-evolve checkpoints belong on the app-managed self-evolve branch. The app control plane creates the before and after commits, records rollback commits, and syncs that branch to `lancesmithcc/agentic.harness` asynchronously. The agent never changes Git refs, the index, remotes, credentials, commits, resets, or pushes.

## Before enabling it

1. Click **🧬** in the chat composer to enable Self-evolve for that chat. Its tooltip says **self evolve**. Use the adjacent options control to select an `agentic.harness` source checkout or inspect GitHub sync.
2. Set Agent file access to **Workspace** or **Full**. **Read-only always wins**, even when Self-evolve is on.
3. Ask for an explicit harness change, such as “fix harness history” or “change agentic.harness UI.” Ordinary project requests remain in the selected project workspace.

Every chat remembers its own selected working folder and Self-evolve state, including after reload. Changing a chat's folder keeps its conversation intact. New chats start with Self-evolve off. Existing chats recover their folder from the saved session log, not the profile's latest default. A missing or unmounted folder must be selected again; work never silently moves to the home directory.

Enabling 🧬 alone does not authorize a harness edit. General references to “this app,” “the code,” or “the UI” mean the selected project. A direct question about agentic.harness can inspect its source read-only, while an explicit edit request requires the chat's Self-evolve toggle. Source tasks temporarily execute in the harness checkout without replacing the chat's remembered project folder.

With Workspace access, a self-evolve task uses the harness source root as its agent workspace. This permits source edits without granting unrestricted filesystem access. All API and local model backends share the official SDK's single workspace boundary; a normal project and the harness source cannot both be writable in one restricted SDK turn. Run separate tasks for those workspaces, or explicitly select Full access when both are needed.

## Checkpoints, sync, and rollback

Each self-evolve card shows its local checkpoint and affected files; session records retain both before and after commits. The chat's Self-evolve options show the latest synchronized GitHub commit. A rollback is append-only: it creates a new rollback commit rather than moving branch history backwards.

Restoring a card is local and file-aware. It restores only files still matching the card’s later version, and skips files changed by a newer self-evolve card or by the user. Review skipped files before making another change.

The app queues branch synchronization after a checkpoint. A failed or offline sync remains pending and retries later; it does not discard the local checkpoint. Inspect the chat's Self-evolve sync state before relying on a remote copy.

To recover on another machine, clone the repository and fetch the self-evolve branch recorded by the relevant card. Check out or compare that branch with `main`, then use the recorded before, after, or rollback commit. Do not force-push or rewrite the branch while pending checkpoint sync exists.

## Applying changes

Source-run web sessions can reload HTML/CSS in the browser; server, provider, router, and package changes require restarting the Bun harness server.

The packaged macOS desktop app serves bundled UI files and a compiled server. Source edits do not change a running installed app. Rebuild, install, and relaunch the desktop bundle using [the desktop build guide](../apps/desktop/README.md):

```bash
cd apps/desktop
bun install
export PATH="$HOME/.cargo/bin:$PATH"
bun run build
```

Copy the resulting app bundle to `/Applications` as described in that guide, then launch the new bundle. Keep the previous installed app until the rebuilt one opens successfully.

Explicit Self-evolve edits share one source checkpoint lock. A second such turn receives a retryable busy response so two agents cannot mix their source changes. Ordinary project requests do not create harness checkpoints.
