/**
 * Local role. Each mirror workspace gets two header buttons, both plain clicks:
 *   - a warning badge: this is a mirror, edits here are not synced back.
 *     Clicking it checks the server again.
 *   - "Pull n", only while the server workspace has changes. One click pulls;
 *     with local edits at stake it drops down a single confirm item instead.
 * When the server workspace is archived, its mirror is archived too, unless
 * it holds local edits; then the badge says so and leaves it to you.
 * Other workspaces are left alone.
 */
import {
  getPaseoClient,
  openExternalUrl,
  type PluginButtonBehavior,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { MIRROR_TITLE_PREFIX, mirrorTitle } from "../shared/commands";
import { checkMirror, getMirror, pullMirror, type Check, type Mirror } from "../shared/contracts";
import { errorText, files, followWorkspaces, shortHost, type WorkspaceEntry, type WorkspaceFeed } from "./workspaces";

const CHECK_EVERY_MS = 2 * 60_000;
const SERVER_CHANGE_DEBOUNCE_MS = 3_000;
const PULL_POLL_MS = 1_000;
const RESULT_VISIBLE_MS = 6_000;

const NOTHING: PluginButtonBehavior = { kind: "action", onPress: () => {} };

interface ServerWorkspaces {
  workspaces: WorkspaceFeed & {
    ref(id: string): { refresh(): Promise<{ archivedAt?: string | null } | null> };
  };
}

interface Entry {
  localWorkspaceId: string;
  directory: string;
  mirror: Mirror;
  badge: PluginButtonRegistration;
  pull: PluginButtonRegistration;
  check: Check | null;
  checking: boolean;
  pulling: boolean;
  pullAuthUrl: string | null;
  /** The server workspace is archived but this mirror holds local edits. */
  orphaned: boolean;
  /** A finished pull's outcome, shown on the pull button for a moment. */
  result: { ok: boolean; message: string } | null;
  resultTimer: ReturnType<typeof setTimeout> | null;
  pending: ReturnType<typeof setTimeout> | null;
}

export function mirrorButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, Entry>();
  const serverFeeds = new Map<string, () => void>();
  let stopped = false;

  function render(entry: Entry) {
    const server = shortHost(entry.mirror.serverLabel);
    const changes = entry.check?.remoteChanges ?? 0;
    const edits = entry.check?.localEdits ?? 0;
    const synced = new Date(entry.mirror.syncedAt).toLocaleString();

    if (entry.orphaned) {
      entry.badge.update({
        label: `Archived on ${server} · ${edits} local edit${edits === 1 ? "" : "s"}`,
        title: `The ${entry.mirror.branch} workspace was archived on ${server}. This mirror was kept because it has edits of its own; archive it yourself when you are done.`,
        behavior: NOTHING,
      });
      entry.pull.update({ visible: false });
      return;
    }

    entry.badge.update({
      label: entry.checking ? "Checking…" : edits > 0 ? `Mirror · ${edits} local edit${edits === 1 ? "" : "s"}` : "Mirror",
      title: [
        `Local mirror of ${entry.mirror.branch} on ${server}.`,
        `Changes made here are not synced back to ${server}; the next pull overwrites them (ignored files like .env stay).`,
        `Last synced ${synced}.`,
        entry.check?.error ? `\n${entry.check.error}` : "",
        "Click to check the server now.",
      ]
        .filter(Boolean)
        .join("\n"),
      behavior: { kind: "action", onPress: () => runCheck(entry, true) },
    });

    const authUrl = entry.pullAuthUrl ?? entry.check?.authUrl ?? null;
    if (entry.pulling) {
      entry.pull.update({
        visible: true,
        disabled: !entry.pullAuthUrl,
        label: entry.pullAuthUrl ? "Sign in to pull" : "Pulling…",
        title: entry.pullAuthUrl ? "Tailscale SSH wants a browser login; the pull continues after." : `Pulling from ${server}`,
        behavior: entry.pullAuthUrl
          ? { kind: "action", onPress: () => void openExternalUrl(entry.pullAuthUrl ?? "") }
          : NOTHING,
      });
    } else if (entry.result) {
      entry.pull.update({
        visible: true,
        disabled: false,
        label: entry.result.ok ? "Pulled ✓" : "Pull failed",
        title: entry.result.ok ? entry.result.message : `${entry.result.message}\n\nClick to try again.`,
        behavior: { kind: "action", onPress: () => startPull(entry) },
      });
    } else if (authUrl) {
      entry.pull.update({
        visible: true,
        disabled: false,
        label: "Sign in to check",
        title: `Tailscale SSH wants a browser login before ${server} can be checked.`,
        behavior: {
          kind: "action",
          onPress: () => {
            void openExternalUrl(authUrl);
            if (entry.check) entry.check = { ...entry.check, authUrl: null };
            render(entry);
            scheduleCheck(entry, 15_000);
          },
        },
      });
    } else if (changes > 0) {
      entry.pull.update({
        visible: true,
        disabled: false,
        label: `Pull ${changes}`,
        title: `${files(changes)} changed on ${server} since the last sync.`,
        behavior:
          edits > 0
            ? {
                kind: "menu",
                items: [
                  {
                    kind: "item",
                    id: "discard-and-pull",
                    title: `Discard ${files(edits)} edited here and pull`,
                    icon: "Trash2",
                    behavior: { kind: "action", onPress: () => startPull(entry) },
                  },
                ],
              }
            : { kind: "action", onPress: () => startPull(entry) },
      });
    } else {
      entry.pull.update({ visible: false });
    }
  }

  function showResult(entry: Entry, result: Entry["result"]) {
    entry.result = result;
    if (entry.resultTimer) clearTimeout(entry.resultTimer);
    // A failure stays until the next attempt; success fades out.
    if (result?.ok) {
      entry.resultTimer = setTimeout(() => {
        entry.result = null;
        render(entry);
      }, RESULT_VISIBLE_MS);
    }
    render(entry);
  }

  function startPull(entry: Entry) {
    if (entry.pulling) return;
    entry.pulling = true;
    entry.pullAuthUrl = null;
    entry.result = null;
    render(entry);

    const finish = (error: string | null, message: string | null) => {
      entry.pulling = false;
      entry.pullAuthUrl = null;
      showResult(entry, error ? { ok: false, message: error } : { ok: true, message: message ?? "Pulled." });
      runCheck(entry, true);
    };
    const poll = () => {
      if (stopped) return;
      void client
        .rpc(getMirror, { workspaceDirectory: entry.directory })
        .then(({ mirror, pull }) => {
          if (mirror) entry.mirror = mirror;
          if (pull.running) {
            if (pull.authUrl !== entry.pullAuthUrl) {
              entry.pullAuthUrl = pull.authUrl;
              render(entry);
            }
            setTimeout(poll, PULL_POLL_MS);
          } else finish(pull.error, pull.message);
        })
        .catch((error: unknown) => finish(errorText(error), null));
    };
    void client
      .rpc(pullMirror, { workspaceDirectory: entry.directory })
      .then(() => setTimeout(poll, PULL_POLL_MS))
      .catch((error: unknown) => finish(errorText(error), null));
  }

  /** `force` is a click: it also retries after a Tailscale login prompt. */
  function runCheck(entry: Entry, force = false) {
    if (stopped || entry.pulling || entry.checking || entry.orphaned) return;
    if (!force && entry.check?.authUrl) return;
    entry.checking = force;
    if (force) render(entry);
    void client
      .rpc(checkMirror, { workspaceDirectory: entry.directory })
      .then((check) => {
        entry.check = check;
      })
      .catch(() => undefined)
      .finally(() => {
        entry.checking = false;
        if (buttons.get(entry.mirror.serverWorkspaceId) === entry) render(entry);
      });
  }

  function scheduleCheck(entry: Entry, delay: number) {
    if (entry.pending) clearTimeout(entry.pending);
    entry.pending = setTimeout(() => {
      entry.pending = null;
      runCheck(entry);
    }, delay);
  }

  /**
   * Archives the mirror when its server workspace is gone. Asks the server
   * directly rather than trusting an event, and never archives over local edits.
   */
  async function followArchive(entry: Entry) {
    if (stopped || entry.orphaned || entry.pulling) return;
    let api: ServerWorkspaces;
    try {
      api = getPaseoClient(entry.mirror.serverId) as unknown as ServerWorkspaces;
    } catch {
      return; // server not connected: cannot tell
    }
    const server = await api.workspaces
      .ref(entry.mirror.serverWorkspaceId)
      .refresh()
      .catch(() => undefined);
    if (server === undefined || (server && !server.archivedAt)) return;

    const check = await client.rpc(checkMirror, { workspaceDirectory: entry.directory }).catch(() => null);
    if (!check || check.localEdits === null) return;
    if (check.localEdits > 0) {
      entry.check = check;
      entry.orphaned = true;
      render(entry);
      return;
    }
    const result = await client.paseo.workspaces.archive(entry.localWorkspaceId).catch((error: unknown) => ({
      error: errorText(error),
    }));
    if (result.error) console.warn("[local-sync] could not archive mirror", result.error);
  }

  /** Server-side activity on a mirrored workspace triggers a check; removal, an archive check. */
  function watchServer(serverId: string) {
    if (serverFeeds.has(serverId)) return;
    try {
      const api = getPaseoClient(serverId) as unknown as { workspaces: WorkspaceFeed };
      const touch = (id: string) => {
        const entry = buttons.get(id);
        if (entry) scheduleCheck(entry, SERVER_CHANGE_DEBOUNCE_MS);
      };
      const removed = (id: string) => {
        const entry = buttons.get(id);
        if (entry) void followArchive(entry);
      };
      serverFeeds.set(
        serverId,
        followWorkspaces(api.workspaces, (workspace) => touch(workspace.id), removed),
      );
    } catch {
      // Host not connected yet; the periodic check retries.
    }
  }

  /** Mirrors made before the title prefix existed get it once they are seen. */
  function labelAsMirror(workspace: WorkspaceEntry, mirror: Mirror) {
    const current = workspace.title || workspace.name || mirror.branch;
    if (current.startsWith(MIRROR_TITLE_PREFIX)) return;
    const handle = (client.paseo.workspaces as unknown as {
      ref(id: string): { setTitle(title: string): Promise<unknown> };
    }).ref(workspace.id);
    void handle.setTitle(mirrorTitle(current)).catch((error: unknown) => {
      console.warn("[local-sync] could not set mirror title", error);
    });
  }

  const localIds = new Map<string, string>(); // local workspace id → server workspace id

  function dispose(entry: Entry) {
    if (entry.pending) clearTimeout(entry.pending);
    if (entry.resultTimer) clearTimeout(entry.resultTimer);
    entry.badge.remove();
    entry.pull.remove();
  }

  function remove(localId: string) {
    const key = localIds.get(localId);
    localIds.delete(localId);
    const entry = key ? buttons.get(key) : undefined;
    if (!key || !entry) return;
    dispose(entry);
    buttons.delete(key);
  }

  function apply(workspace: WorkspaceEntry) {
    const directory = workspace.workspaceDirectory ?? null;
    if (!directory || !workspace.gitRuntime) return remove(workspace.id);
    const key = localIds.get(workspace.id);
    if (key && buttons.get(key)?.directory === directory) return;

    void client
      .rpc(getMirror, { workspaceDirectory: directory })
      .then(({ mirror }) => {
        if (stopped) return;
        remove(workspace.id);
        if (!mirror) return;

        const entry: Entry = {
          localWorkspaceId: workspace.id,
          directory,
          mirror,
          check: null,
          checking: false,
          pulling: false,
          pullAuthUrl: null,
          orphaned: false,
          result: null,
          resultTimer: null,
          pending: null,
          pull: client.addHeaderButton({
            id: "local-sync-pull",
            workspaceId: workspace.id,
            button: { title: "Pull", icon: "ArrowDownToLine", label: "Pull", visible: false, behavior: NOTHING },
          }),
          badge: client.addHeaderButton({
            id: "local-sync-mirror",
            workspaceId: workspace.id,
            button: { title: "Mirror", icon: "AlertTriangle", label: "Mirror", behavior: NOTHING },
          }),
        };
        buttons.set(mirror.serverWorkspaceId, entry);
        localIds.set(workspace.id, mirror.serverWorkspaceId);
        render(entry);
        watchServer(mirror.serverId);
        scheduleCheck(entry, 2_000);
        // Catch up on archives that happened while this app was closed.
        void followArchive(entry);
        labelAsMirror(workspace, mirror);
      })
      .catch((error: unknown) => console.warn("[local-sync] could not read mirror", error));
  }

  const unsubscribe = followWorkspaces(client.paseo.workspaces as unknown as WorkspaceFeed, apply, remove);
  const interval = setInterval(() => {
    for (const entry of buttons.values()) {
      watchServer(entry.mirror.serverId);
      runCheck(entry);
      void followArchive(entry);
    }
  }, CHECK_EVERY_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribe();
    for (const off of serverFeeds.values()) off();
    serverFeeds.clear();
    for (const entry of buttons.values()) dispose(entry);
    buttons.clear();
  };
}
