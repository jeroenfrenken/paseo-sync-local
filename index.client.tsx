import type { PluginClientContext } from "@getpaseo/plugin/client";
import { mirrorButtons } from "./client/mirror-buttons";
import { remoteButtons } from "./client/remote-buttons";
import { onRoleChange } from "./client/role";
import { SyncSettings } from "./client/settings";
import { getSettings, type Role } from "./shared/contracts";

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
