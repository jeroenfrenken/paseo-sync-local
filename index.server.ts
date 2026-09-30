import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  checkMirror,
  describeWorkspace,
  forgetRecord,
  getMirror,
  getRecord,
  getSettings,
  pullMirror,
  saveRecord,
  saveSettings,
} from "./shared/contracts";
import { describe } from "./server/describe";
import { check, pullState, readMirror, startPull } from "./server/mirror";
import {
  detectSshTarget,
  effectiveRole,
  findRecord,
  loadSettings,
  removeRecord,
  storeSettings,
  upsertRecord,
} from "./server/state";
import type { Settings } from "./shared/contracts";

function settingsResult(settings: Settings) {
  return { settings, detectedSshTarget: detectSshTarget(), role: effectiveRole(settings), platform: process.platform };
}

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
  server.handle(getSettings, () => settingsResult(loadSettings()));
  server.handle(saveSettings, (settings) => settingsResult(storeSettings(settings)));

  server.handle(getMirror, async ({ workspaceDirectory }) => ({
    mirror: await readMirror(workspaceDirectory),
    pull: pullState(workspaceDirectory),
  }));
  server.handle(checkMirror, ({ workspaceDirectory }) => check(workspaceDirectory));
  server.handle(pullMirror, ({ workspaceDirectory }) => ({ started: startPull(workspaceDirectory) }));
  return () => {};
}
