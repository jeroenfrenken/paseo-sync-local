import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SettingsSchema = z.object({
  /** `user@host` the local machine SSHes to. Blank means auto-detect via Tailscale. */
  sshTarget: z.string(),
  /** Where new clones go on the local machine when the project is not there yet. */
  cloneBase: z.string(),
  /** Only "manual" today; "live" is the planned auto-sync mode. */
  mode: z.enum(["manual"]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { sshTarget: "", cloneBase: "~/paseo-sync", mode: "manual" };

/** Everything the local machine needs to mirror one server workspace. */
export const DescriptionSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  workspaceDirectory: z.string(),
  projectRoot: z.string(),
  repoName: z.string(),
  originUrl: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  sshTarget: z.string(),
  /** Uncommitted work, as git sees it; ignored files are never listed. */
  changed: z.array(z.string()),
  deleted: z.array(z.string()),
});
export type Description = z.infer<typeof DescriptionSchema>;

export const describeWorkspace = defineRpc({
  name: "localsync.describe",
  input: z.object({ workspaceDirectory: z.string() }),
  output: DescriptionSchema,
});

/** Where a server workspace was mirrored to, so re-syncs reuse it. */
export const RecordSchema = z.object({
  serverWorkspaceId: z.string(),
  localServerId: z.string(),
  localWorkspaceId: z.string(),
  localDirectory: z.string(),
  localProjectRoot: z.string(),
  branch: z.string(),
  head: z.string(),
  syncedAt: z.string(),
});
export type SyncRecord = z.infer<typeof RecordSchema>;

export const getRecord = defineRpc({
  name: "localsync.record.get",
  input: z.object({ serverWorkspaceId: z.string(), localServerId: z.string() }),
  output: z.object({ record: RecordSchema.nullable() }),
});

export const saveRecord = defineRpc({
  name: "localsync.record.save",
  input: RecordSchema,
  output: z.object({ ok: z.boolean() }),
});

export const forgetRecord = defineRpc({
  name: "localsync.record.forget",
  input: z.object({ serverWorkspaceId: z.string(), localServerId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const getSettings = defineRpc({
  name: "localsync.settings.get",
  input: z.object({}),
  output: z.object({ settings: SettingsSchema, detectedSshTarget: z.string() }),
});

export const saveSettings = defineRpc({
  name: "localsync.settings.save",
  input: SettingsSchema,
  output: z.object({ settings: SettingsSchema, detectedSshTarget: z.string() }),
});
