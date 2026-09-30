# paseo-sync-local

A [Paseo](https://paseo.sh) plugin that mirrors a workspace from the host you
work on (a cloud box, say) onto your **local** Paseo host, in a real worktree
with the project's setup run. Develop on the server, test on your machine.

> Requires Paseo >= 0.9 on the app and both daemons, and SSH from your machine
> to the server (Tailscale SSH works).

Install it on **both** hosts:

```sh
paseo plugin add jeroenfrenken/paseo-sync-local
```

## Roles

Each host is either **remote** (where you work) or **local** (where you test),
set in **Settings → Sync to local**. *Auto* makes macOS and Windows local and
anything else remote.

- **Remote** — every git workspace gets a **Sync local** button that creates
  or refreshes its mirror on your local host.
- **Local** — mirror workspaces get a **Mirror** badge warning that edits
  belong on the remote. When the server workspace changes it becomes
  **Sync changes (n)**, and pressing it pulls them in. Other workspaces are
  left alone.

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

Later syncs skip to fetch + apply and take seconds, from either side.

The first sync marks the worktree as a mirror in its own git dir
(`paseo-sync.json`, never in the working tree), with a manifest of the server's
state: HEAD plus a hash per uncommitted file. Comparing manifests tells the
local host what changed on the server and what was edited locally, without
the server running anything but git.

**Only what git tracks travels.** The file list comes from git, so every ignore
rule applies: `.env`, `node_modules` and build output never leave the server.
Your local setup script owns its own `.env`.

**One-way.** Each sync resets the local worktree to the server's state; local
edits there are overwritten (ignored files are kept). Only worktrees this plugin
created are ever reset; it refuses to touch your main checkout. The mirror's
popover counts local edits and turns the button into *Discard edits and sync*. If the branch is
already checked out locally, the worktree uses `sync/<branch>`.

**Running things on your machine.** The app borrows your local host's API
(`getPaseoClient`) and runs each step in a short-lived terminal there, which is
killed when the step finishes. If Tailscale SSH asks you to sign in, the popover
shows the login link.

## Settings

**Settings → Sync to local**: the role, and on the remote the SSH target your
machine uses to reach it (blank = detected Tailscale name) and where first-time
clones go.

## Roadmap

- Live mode as a setting, auto-applying those changes.

## Development

```sh
npm install
npm run check
paseo plugin reload local-sync
```
