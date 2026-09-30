import {
  getPaseoClient,
  openExternalUrl,
  type PluginButtonContentProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { MirrorPopover } from "./client/mirror-popover";
import { SyncPopover } from "./client/popover";
import { onRoleChange } from "./client/role";
import { SyncSettings } from "./client/settings";
import { checkMirror, getMirror, getSettings, pullMirror, type Check, type Mirror, type Role } from "./shared/contracts";

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
const PULL_POLL_MS = 1_000;

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

interface MirrorButton {
  directory: string;
  mirror: Mirror;
  /** Always there: says this is a mirror and that edits are not synced back. */
  badge: PluginButtonRegistration;
  /** Only visible when the server has changes to pull. */
  pull: PluginButtonRegistration;
  check: Check | null;
  pulling: boolean;
  pullAuthUrl: string | null;
  pullError: string | null;
  pending: ReturnType<typeof setTimeout> | null;
}

/**
 * Local role. Each mirror workspace gets two header buttons:
 *   - a warning badge: this is a mirror, edits here are not synced back
 *   - "Pull (n)", only while the server workspace has changes to bring over
 * Other workspaces are left alone.
 */
function mirrorButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, MirrorButton>();
  const serverFeeds = new Map<string, () => void>();
  let stopped = false;

  const popover = (entry: MirrorButton) => ({
    kind: "popover" as const,
    Content: (props: PluginButtonContentProps) => (
      <MirrorPopover
        {...props}
        workspaceDirectory={entry.directory}
        onChecked={(check) => {
          entry.check = check;
          render(entry);
        }}
      />
    ),
  });

  function render(entry: MirrorButton) {
    const server = entry.mirror.serverLabel.replace(/\.local$/, "");
    const changes = entry.check?.remoteChanges ?? 0;
    const edits = entry.check?.localEdits ?? 0;

    entry.badge.update({
      label: edits > 0 ? `Mirror · ${edits} local edit${edits === 1 ? "" : "s"}` : "Mirror",
      title: `Local mirror of ${entry.mirror.branch} on ${server}. Changes made here are not synced back, and the next pull overwrites them.`,
    });

    const authUrl = entry.pullAuthUrl ?? entry.check?.authUrl ?? null;
    if (entry.pulling) {
      entry.pull.update({
        visible: true,
        disabled: !entry.pullAuthUrl,
        label: entry.pullAuthUrl ? "Sign in to pull" : "Pulling…",
        title: entry.pullAuthUrl ? "Tailscale SSH wants a browser login; the pull continues after." : `Pulling from ${server}`,
        behavior: { kind: "action", onPress: () => void openExternalUrl(entry.pullAuthUrl ?? "") },
      });
    } else if (entry.pullError) {
      entry.pull.update({ visible: true, disabled: false, label: "Pull failed", title: entry.pullError, behavior: popover(entry) });
    } else if (authUrl && changes === 0) {
      // Checks cannot reach the server until you sign in.
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
            scheduleCheck(entry, 15_000);
          },
        },
      });
    } else if (changes > 0) {
      entry.pull.update({
        visible: true,
        disabled: false,
        label: `Pull ${changes}`,
        title:
          edits > 0
            ? `${files(changes)} changed on ${server}. Pulling discards your ${files(edits)} edited here.`
            : `${files(changes)} changed on ${server}. Pull them into this mirror.`,
        // With local edits at stake, confirm in the popover instead of pulling on one click.
        behavior: edits > 0 ? popover(entry) : { kind: "action", onPress: () => startPull(entry) },
      });
    } else {
      entry.pull.update({ visible: false });
    }
  }

  function startPull(entry: MirrorButton) {
    if (entry.pulling) return;
    entry.pulling = true;
    entry.pullError = null;
    entry.pullAuthUrl = null;
    render(entry);
    const finish = (error: string | null) => {
      entry.pulling = false;
      entry.pullAuthUrl = null;
      entry.pullError = error;
      render(entry);
      runCheck(entry);
    };
    const poll = () => {
      if (stopped) return;
      void client
        .rpc(getMirror, { workspaceDirectory: entry.directory })
        .then(({ pull }) => {
          if (pull.running) {
            if (pull.authUrl !== entry.pullAuthUrl) {
              entry.pullAuthUrl = pull.authUrl;
              render(entry);
            }
            setTimeout(poll, PULL_POLL_MS);
          } else finish(pull.error);
        })
        .catch((error: unknown) => finish(String(error)));
    };
    void client
      .rpc(pullMirror, { workspaceDirectory: entry.directory })
      .then(() => setTimeout(poll, PULL_POLL_MS))
      .catch((error: unknown) => finish(String(error)));
  }

  function runCheck(entry: MirrorButton) {
    // Waiting on a Tailscale login: pressing "Sign in to check" resumes.
    if (stopped || entry.pulling || entry.check?.authUrl) return;
    void client
      .rpc(checkMirror, { workspaceDirectory: entry.directory })
      .then((check) => {
        if (buttons.get(entry.mirror.serverWorkspaceId) !== entry) return;
        entry.check = check;
        render(entry);
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
    entry.badge.remove();
    entry.pull.remove();
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

        const noop = { kind: "action" as const, onPress: () => undefined };
        const entry: MirrorButton = {
          directory,
          mirror,
          check: null,
          pulling: false,
          pullAuthUrl: null,
          pullError: null,
          pending: null,
          pull: client.addHeaderButton({
            id: "local-sync-pull",
            workspaceId: workspace.id,
            button: { title: "Pull", icon: "ArrowDownToLine", label: "Pull", visible: false, behavior: noop },
          }),
          badge: client.addHeaderButton({
            id: "local-sync-mirror",
            workspaceId: workspace.id,
            button: { title: "Mirror", icon: "AlertTriangle", label: "Mirror", behavior: noop },
          }),
        };
        entry.badge.update({ behavior: popover(entry) });
        buttons.set(mirror.serverWorkspaceId, entry);
        localIds.set(workspace.id, mirror.serverWorkspaceId);
        render(entry);
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
      entry.badge.remove();
      entry.pull.remove();
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
