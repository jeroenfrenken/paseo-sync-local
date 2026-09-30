import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  describeWorkspace,
  forgetRecord,
  getRecord,
  getSettings,
  saveRecord,
  saveSettings,
} from "./shared/contracts";
import { describe } from "./server/describe";
import { detectSshTarget, findRecord, loadSettings, removeRecord, storeSettings, upsertRecord } from "./server/state";

export default function contribute(server: PluginServerContext) {
  server.handle(describeWorkspace, ({ workspaceDirectory }) => describe(workspaceDirectory));
  server.handle(getRecord, ({ serverWorkspaceId, localServerId }) => ({
    record: findRecord(serverWorkspaceId, localServerId),
  }));
  server.handle(saveRecord, (record) => {
    upsertRecord(record);
    return { ok: true };
  });
  server.handle(forgetRecord, ({ serverWorkspaceId, localServerId }) => {
    removeRecord(serverWorkspaceId, localServerId);
    return { ok: true };
  });
  server.handle(getSettings, () => ({ settings: loadSettings(), detectedSshTarget: detectSshTarget() }));
  server.handle(saveSettings, (settings) => ({ settings: storeSettings(settings), detectedSshTarget: detectSshTarget() }));
  return () => {};
}
