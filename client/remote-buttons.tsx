/**
 * Remote role: a "Sync local" button on every git workspace. One click
 * mirrors the workspace onto the local host; the label shows progress and
 * the result, the tooltip the details.
 */
import {
  getPaseoClient,
  openExternalUrl,
  useHosts,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  type PluginHostSummary,
} from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { Text } from "react-native";
import { describeWorkspace, getRecord, getSettings, saveRecord } from "../shared/contracts";
import type { HostApi } from "./remote";
import { sync, type Phase } from "./sync";
import { errorText, followWorkspaces, shortHost, type WorkspaceEntry, type WorkspaceFeed } from "./workspaces";

/**
 * The host list is only available through a hook, and an action button has no
 * component of its own, so the button's icon reports what it sees.
 */
const hostsSeen: { hosts: readonly PluginHostSummary[]; self: { id: string; label: string } | null } = {
  hosts: [],
  self: null,
};

function SyncIcon(props: PluginButtonIconProps) {
  const hosts = useHosts();
  useEffect(() => {
    hostsSeen.hosts = hosts;
    hostsSeen.self = props.host;
  }, [hosts, props.host]);
  return <Text style={{ color: props.color, fontSize: props.size, lineHeight: props.size + 2 }}>⤓</Text>;
}

const PHASE_LABEL: Record<Phase, string> = {
  locate: "Syncing…",
  clone: "Cloning…",
  fetch: "Fetching…",
  worktree: "Creating worktree…",
  apply: "Applying…",
  done: "Synced ✓",
};

const RESULT_VISIBLE_MS = 6_000;

interface Entry {
  directory: string;
  registration: PluginButtonRegistration;
  running: boolean;
  reset: ReturnType<typeof setTimeout> | null;
}

export function remoteButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, Entry>();

  function idle(entry: Entry, workspaceId: string) {
    const local = pickLocal();
    entry.registration.update({
      label: "Sync local",
      disabled: false,
      title: local
        ? `Mirror this workspace onto ${shortHost(local.label)}. Only files git tracks are copied.`
        : "Mirror this workspace onto your local Paseo host",
      behavior: { kind: "action", onPress: () => void run(entry, workspaceId) },
    });
  }

  /** Shows a result for a few seconds, then returns to idle. */
  function settle(entry: Entry, workspaceId: string, label: string, title: string) {
    entry.registration.update({
      label,
      title,
      disabled: false,
      behavior: { kind: "action", onPress: () => void run(entry, workspaceId) },
    });
    if (entry.reset) clearTimeout(entry.reset);
    entry.reset = setTimeout(() => idle(entry, workspaceId), RESULT_VISIBLE_MS);
  }

  function pickLocal() {
    const self = hostsSeen.self?.id;
    return hostsSeen.hosts.find((host) => host.serverId !== self && host.status === "online") ?? null;
  }

  async function run(entry: Entry, workspaceId: string) {
    if (entry.running) return;
    if (entry.reset) clearTimeout(entry.reset);
    const local = pickLocal();
    const self = hostsSeen.self;
    if (!local || !self) {
      settle(entry, workspaceId, "No local host", "Run Paseo on your machine and connect it to this app first.");
      return;
    }

    entry.running = true;
    const show = (label: string, title: string) =>
      entry.registration.update({ label, title, disabled: true, behavior: { kind: "action", onPress: () => {} } });
    show("Syncing…", `Syncing to ${shortHost(local.label)}`);

    try {
      const [description, { record }, { settings }] = await Promise.all([
        client.rpc(describeWorkspace, { workspaceDirectory: entry.directory }),
        client.rpc(getRecord, { serverWorkspaceId: workspaceId, localServerId: local.serverId }),
        client.rpc(getSettings, {}),
      ]);
      let doneMessage = "Synced.";
      const next = await sync(
        {
          serverId: self.id,
          serverLabel: self.label,
          serverWorkspaceId: workspaceId,
          description,
          localServerId: local.serverId,
          local: getPaseoClient(local.serverId) as unknown as HostApi,
          cloneBase: settings.cloneBase,
          existing: record,
        },
        {
          onPhase: (phase, message) => {
            if (phase === "done") doneMessage = message;
            else show(PHASE_LABEL[phase], message);
          },
          onLine: () => {},
          onAuthUrl: (url) =>
            entry.registration.update({
              label: "Sign in to sync",
              title: "Tailscale SSH wants a browser login; the sync continues once you have signed in.",
              disabled: false,
              behavior: { kind: "action", onPress: () => void openExternalUrl(url) },
            }),
        },
      );
      await client.rpc(saveRecord, next);
      const changes = description.changed.length + description.deleted.length;
      settle(
        entry,
        workspaceId,
        !record ? "Synced ✓ · setup running" : doneMessage.includes("Dependency") ? "Synced ✓ · rerun setup" : "Synced ✓",
        `${doneMessage}\n${changes} uncommitted file${changes === 1 ? "" : "s"} · ${next.localDirectory}`,
      );
    } catch (error) {
      settle(entry, workspaceId, "Sync failed", `${errorText(error)}\n\nClick to try again.`);
    } finally {
      entry.running = false;
    }
  }

  function remove(id: string) {
    const entry = buttons.get(id);
    if (entry?.reset) clearTimeout(entry.reset);
    entry?.registration.remove();
    buttons.delete(id);
  }

  function apply(workspace: WorkspaceEntry) {
    const directory = workspace.workspaceDirectory ?? null;
    // Only git workspaces can be mirrored.
    if (!directory || !workspace.gitRuntime) return remove(workspace.id);
    if (buttons.get(workspace.id)?.directory === directory) return;
    remove(workspace.id);

    const entry: Entry = {
      directory,
      running: false,
      reset: null,
      registration: client.addHeaderButton({
        id: "local-sync",
        workspaceId: workspace.id,
        button: { title: "Sync local", icon: SyncIcon, label: "Sync local", behavior: { kind: "action", onPress: () => {} } },
      }),
    };
    buttons.set(workspace.id, entry);
    idle(entry, workspace.id);
  }

  const unsubscribe = followWorkspaces(client.paseo.workspaces as unknown as WorkspaceFeed, apply, remove);
  return () => {
    unsubscribe();
    for (const id of [...buttons.keys()]) remove(id);
  };
}
