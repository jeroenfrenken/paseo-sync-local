import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SyncPopover } from "./client/popover";
import { SyncSettings } from "./client/settings";

interface WorkspaceEntry {
  id: string;
  workspaceDirectory?: string | null;
  gitRuntime?: unknown;
}

export default function contribute(client: PluginClientContext) {
  const buttons = new Map<string, { registration: PluginButtonRegistration; directory: string }>();
  let stopped = false;

  function apply(workspace: WorkspaceEntry) {
    if (stopped) return;
    const directory = workspace.workspaceDirectory ?? null;
    const existing = buttons.get(workspace.id);

    // Only git workspaces can be mirrored.
    if (!directory || !workspace.gitRuntime) {
      existing?.registration.remove();
      buttons.delete(workspace.id);
      return;
    }
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

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") apply(update.workspace as WorkspaceEntry);
    else {
      buttons.get(update.id)?.registration.remove();
      buttons.delete(update.id);
    }
  });

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then((result) => {
      for (const workspace of result.entries) apply(workspace as WorkspaceEntry);
    })
    .catch((error: unknown) => console.warn("[local-sync] could not list workspaces", error));

  const removeSettings = client.addSettingsScreen({
    id: "local-sync",
    title: "Sync to local",
    icon: "MonitorDown",
    Component: SyncSettings,
  });

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    stopped = true;
    unsubscribe();
    removeSettings();
    for (const entry of buttons.values()) entry.registration.remove();
    buttons.clear();
  };
}
