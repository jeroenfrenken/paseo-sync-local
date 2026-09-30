import { getPaseoClient, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { MirrorPopover } from "./client/mirror-popover";
import { SyncPopover } from "./client/popover";
import { onRoleChange } from "./client/role";
import { SyncSettings } from "./client/settings";
import { checkMirror, getMirror, getSettings, type Check, type Mirror, type Role } from "./shared/contracts";

interface WorkspaceEntry {
  id: string;
  workspaceDirectory?: string | null;
  gitRuntime?: unknown;
}

type WorkspaceUpdate = { kind: "upsert"; workspace: unknown } | { kind: "remove"; id: string };

interface WorkspaceFeed {
  subscribe(listener: (update: WorkspaceUpdate) => void): () => void;
  list(options: { subscribe: object }): Promise<{ entries: unknown[] }>;
}

/** Calls `apply` for every workspace on a host now and on every change. */
function followWorkspaces(
  feed: WorkspaceFeed,
  apply: (workspace: WorkspaceEntry) => void,
  remove: (id: string) => void,
): () => void {
  const unsubscribe = feed.subscribe((update) => {
    if (update.kind === "upsert") apply(update.workspace as WorkspaceEntry);
    else remove(update.id);
  });
  void feed
    .list({ subscribe: {} })
    .then((result) => {
      for (const workspace of result.entries) apply(workspace as WorkspaceEntry);
    })
    .catch((error: unknown) => console.warn("[local-sync] could not list workspaces", error));
  return unsubscribe;
}

/** Remote role: a "Sync local" button on every git workspace. */
function remoteButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; directory: string }>();

  function remove(id: string) {
    buttons.get(id)?.registration.remove();
    buttons.delete(id);
  }

  function apply(workspace: WorkspaceEntry) {
    const directory = workspace.workspaceDirectory ?? null;
    const existing = buttons.get(workspace.id);

    // Only git workspaces can be mirrored.
    if (!directory || !workspace.gitRuntime) return remove(workspace.id);
    if (existing && existing.directory === directory) return;
    existing?.registration.remove();

    buttons.set(workspace.id, {
      directory,
      registration: client.addHeaderButton({
        id: "local-sync",
        workspaceId: workspace.id,
        button: {
          title: "Mirror this workspace onto your local Paseo host",
          icon: "MonitorDown",
          label: "Sync local",
          behavior: {
            kind: "popover",
            Content: (props) => <SyncPopover {...props} workspaceDirectory={directory} />,
          },
        },
      }),
    });
  }

  const unsubscribe = followWorkspaces(client.paseo.workspaces as unknown as WorkspaceFeed, apply, remove);
  return () => {
    unsubscribe();
    for (const entry of buttons.values()) entry.registration.remove();
    buttons.clear();
  };
}

const CHECK_EVERY_MS = 2 * 60_000;
const SERVER_CHANGE_DEBOUNCE_MS = 3_000;

interface MirrorButton {
  registration: PluginButtonRegistration;
  directory: string;
  mirror: Mirror;
  pending: ReturnType<typeof setTimeout> | null;
  /** Tailscale wants a browser login; stop checking until the popover succeeds. */
  paused: boolean;
}

/**
 * Local role: mirror workspaces get a warning badge that turns into
 * "Sync changes (n)" when the server workspace moves on. Other workspaces
 * are left alone.
 */
function mirrorButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, MirrorButton>();
  const serverFeeds = new Map<string, () => void>();
  let stopped = false;

  function present(entry: MirrorButton, check: Check | null) {
    const server = entry.mirror.serverLabel.replace(/\.local$/, "");
    const changes = check?.remoteChanges ?? 0;
    entry.paused = Boolean(check?.authUrl);
    entry.registration.update({
      label: changes > 0 ? `Sync changes (${changes})` : "Mirror",
      title:
        changes > 0
          ? `${changes} file${changes === 1 ? "" : "s"} changed on ${server} since the last sync`
          : `Local mirror of ${entry.mirror.branch} on ${server}. Edit there; syncing overwrites this worktree.`,
    });
  }

  function runCheck(entry: MirrorButton) {
    if (stopped || entry.paused) return;
    void client
      .rpc(checkMirror, { workspaceDirectory: entry.directory })
      .then((check) => {
        if (buttons.get(entry.mirror.serverWorkspaceId) === entry) present(entry, check);
      })
      .catch(() => undefined);
  }

  function scheduleCheck(entry: MirrorButton, delay: number) {
    if (entry.pending) clearTimeout(entry.pending);
    entry.pending = setTimeout(() => {
      entry.pending = null;
      runCheck(entry);
    }, delay);
  }

  /** Server-side git activity on a mirrored workspace triggers a check. */
  function watchServer(serverId: string) {
    if (serverFeeds.has(serverId)) return;
    try {
      const api = getPaseoClient(serverId) as unknown as { workspaces: WorkspaceFeed };
      const touch = (id: string) => {
        const entry = buttons.get(id);
        if (entry) scheduleCheck(entry, SERVER_CHANGE_DEBOUNCE_MS);
      };
      serverFeeds.set(
        serverId,
        followWorkspaces(api.workspaces, (workspace) => touch(workspace.id), touch),
      );
    } catch {
      // Host not connected yet; the periodic check retries.
    }
  }

  const localIds = new Map<string, string>(); // local workspace id → server workspace id

  function remove(localId: string) {
    const key = localIds.get(localId);
    localIds.delete(localId);
    const entry = key ? buttons.get(key) : undefined;
    if (!key || !entry) return;
    if (entry.pending) clearTimeout(entry.pending);
    entry.registration.remove();
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

        const entry: MirrorButton = {
          directory,
          mirror,
          pending: null,
          paused: false,
          registration: client.addHeaderButton({
            id: "local-sync-mirror",
            workspaceId: workspace.id,
            button: {
              title: "",
              icon: "MonitorDown",
              label: "Mirror",
              behavior: {
                kind: "popover",
                Content: (props) => (
                  <MirrorPopover
                    {...props}
                    workspaceDirectory={directory}
                    onChecked={(check) => {
                      const current = buttons.get(mirror.serverWorkspaceId);
                      if (current) present(current, check);
                    }}
                  />
                ),
              },
            },
          }),
        };
        buttons.set(mirror.serverWorkspaceId, entry);
        localIds.set(workspace.id, mirror.serverWorkspaceId);
        present(entry, null);
        watchServer(mirror.serverId);
        scheduleCheck(entry, 2_000);
      })
      .catch((error: unknown) => console.warn("[local-sync] could not read mirror", error));
  }

  const unsubscribe = followWorkspaces(client.paseo.workspaces as unknown as WorkspaceFeed, apply, remove);
  const interval = setInterval(() => {
    for (const entry of buttons.values()) {
      watchServer(entry.mirror.serverId);
      runCheck(entry);
    }
  }, CHECK_EVERY_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribe();
    for (const off of serverFeeds.values()) off();
    serverFeeds.clear();
    for (const entry of buttons.values()) {
      if (entry.pending) clearTimeout(entry.pending);
      entry.registration.remove();
    }
    buttons.clear();
  };
}

export default function contribute(client: PluginClientContext) {
  let role: Role | null = null;
  let teardown: () => void = () => {};
  let removed = false;

  const start = (next: Role) => {
    if (removed || next === role) return;
    teardown();
    role = next;
    teardown = next === "remote" ? remoteButtons(client) : mirrorButtons(client);
  };

  void client
    .rpc(getSettings, {})
    .then((result) => start(result.role))
    .catch((error: unknown) => console.warn("[local-sync] could not read settings", error));
  const offRole = onRoleChange(start);

  const removeSettings = client.addSettingsScreen({
    id: "local-sync",
    title: "Sync to local",
    icon: "MonitorDown",
    Component: SyncSettings,
  });

  return () => {
    if (removed) return;
    removed = true;
    offRole();
    teardown();
    removeSettings();
  };
}
