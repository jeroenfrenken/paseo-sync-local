import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Which side of a sync this host is. The remote is where you work (the cloud
 * box) and offers "Sync local"; the local host holds read-only mirrors.
 */
export const RoleSchema = z.enum(["remote", "local"]);
export type Role = z.infer<typeof RoleSchema>;

export const SettingsSchema = z.object({
  /** "auto" picks local on macOS and Windows, remote elsewhere. */
  role: z.enum(["auto", "remote", "local"]),
  /** `user@host` the local machine SSHes to. Blank means auto-detect via Tailscale. */
  sshTarget: z.string(),
  /** Where new clones go on the local machine when the project is not there yet. */
  cloneBase: z.string(),
  /** Only "manual" today; "live" is the planned auto-sync mode. */
  mode: z.enum(["manual"]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { role: "auto", sshTarget: "", cloneBase: "~/paseo-sync", mode: "manual" };

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

const SettingsResultSchema = z.object({
  settings: SettingsSchema,
  detectedSshTarget: z.string(),
  /** The role in effect, with "auto" resolved. */
  role: RoleSchema,
  platform: z.string(),
});

export const getSettings = defineRpc({
  name: "localsync.settings.get",
  input: z.object({}),
  output: SettingsResultSchema,
});

export const saveSettings = defineRpc({
  name: "localsync.settings.save",
  input: SettingsSchema,
  output: SettingsResultSchema,
});

// ── Local role: mirrors ──────────────────────────────────────────────────

/**
 * Written into a mirror worktree's own git dir (never the working tree) by the
 * first sync. It is what makes a local workspace a mirror.
 */
export const MirrorSchema = z.object({
  serverId: z.string(),
  serverLabel: z.string(),
  serverWorkspaceId: z.string(),
  sshTarget: z.string(),
  serverDirectory: z.string(),
  branch: z.string(),
  head: z.string(),
  syncedAt: z.string(),
});
export type Mirror = z.infer<typeof MirrorSchema>;

export const PullStateSchema = z.object({
  running: z.boolean(),
  message: z.string().nullable(),
  authUrl: z.string().nullable(),
  error: z.string().nullable(),
  log: z.array(z.string()),
});
export type PullState = z.infer<typeof PullStateSchema>;

export const getMirror = defineRpc({
  name: "localsync.mirror.get",
  input: z.object({ workspaceDirectory: z.string() }),
  output: z.object({ mirror: MirrorSchema.nullable(), pull: PullStateSchema }),
});

export const CheckSchema = z.object({
  /** Files that changed on the server since the last sync; null when unknown. */
  remoteChanges: z.number().nullable(),
  /** Files edited in this mirror, which the next sync overwrites. */
  localEdits: z.number().nullable(),
  authUrl: z.string().nullable(),
  error: z.string().nullable(),
  checkedAt: z.string(),
});
export type Check = z.infer<typeof CheckSchema>;

export const checkMirror = defineRpc({
  name: "localsync.mirror.check",
  input: z.object({ workspaceDirectory: z.string() }),
  output: CheckSchema,
});

export const pullMirror = defineRpc({
  name: "localsync.mirror.pull",
  input: z.object({ workspaceDirectory: z.string() }),
  output: z.object({ started: z.boolean() }),
});
