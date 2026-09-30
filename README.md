# paseo-sync-local

A [Paseo](https://paseo.sh) plugin that mirrors a workspace from the host you
work on (a cloud box, say) onto your **local** Paseo host, in a real worktree
with the project's setup run. Develop on the server, test on your machine.

> Requires Paseo >= 0.9 on the app and both daemons, and SSH from your machine
> to the server (Tailscale SSH works).

```sh
paseo plugin add jeroenfrenken/paseo-sync-local
```

## How it works

Press **Sync local** in a git workspace's header:

1. **Locate** — finds the project on your machine by git origin, or clones it
   into `~/paseo-sync`.
2. **Fetch** — pulls the workspace's HEAD straight from the server over SSH, so
   unpushed commits come along.
3. **Worktree** — your local Paseo creates a worktree on that commit, so the
   project's `worktree.setup` runs and it shows up as a normal workspace.
4. **Apply** — the uncommitted work (modified, staged, untracked, deleted) is
   streamed over SSH as a tar and unpacked on top.

Later syncs skip to fetch + apply and take seconds.

**Only what git tracks travels.** The file list comes from git, so every ignore
rule applies: `.env`, `node_modules` and build output never leave the server.
Your local setup script owns its own `.env`.

**One-way.** Each sync resets the local worktree to the server's state; local
edits there are overwritten (ignored files are kept). Only worktrees this plugin
created are ever reset; it refuses to touch your main checkout. If the branch is
already checked out locally, the worktree uses `sync/<branch>`.

**Running things on your machine.** The app borrows your local host's API
(`getPaseoClient`) and runs each step in a short-lived terminal there, which is
killed when the step finishes. If Tailscale SSH asks you to sign in, the popover
shows the login link.

## Settings

**Settings → Sync to local**: the SSH target of the server (blank = detected
Tailscale name) and where first-time clones go.

## Roadmap

- Install on both hosts: the local copy marks mirror workspaces and shows
  **Sync changes (n)** when the server workspace moves on.
- Live mode as a setting, auto-applying those changes.

## Development

```sh
npm install
npm run check
paseo plugin reload local-sync
```
