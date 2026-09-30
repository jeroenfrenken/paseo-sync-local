import { getPaseoClient, openExternalUrl, useHosts, useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  describeWorkspace,
  forgetRecord,
  getRecord,
  getSettings,
  saveRecord,
  type Description,
  type SyncRecord,
} from "../shared/contracts";
import type { HostApi } from "./remote";
import { sync, type Phase } from "./sync";

const GOOD = "#0ca30c";
const WARN = "#fab219";
const BAD = "#d03b3b";

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export type SyncPopoverProps = PluginButtonContentProps & { workspaceDirectory: string };

export function SyncPopover(props: SyncPopoverProps) {
  const ink = props.theme.colors.foreground;
  const muted = props.theme.colors.foregroundMuted;
  const mono = props.layout.platform === "ios" ? "Menlo" : "monospace";

  const hosts = useHosts();
  const local = hosts.find((host) => host.serverId !== props.host.id && host.status === "online") ?? null;

  const describe = useRpc(describeWorkspace);
  const loadRecord = useRpc(getRecord);
  const storeRecord = useRpc(saveRecord);
  const dropRecord = useRpc(forgetRecord);
  const loadSettings = useRpc(getSettings);
  const rpc = useRef({ describe, loadRecord, storeRecord, dropRecord, loadSettings });
  rpc.current = { describe, loadRecord, storeRecord, dropRecord, loadSettings };

  const [description, setDescription] = useState<Description | null>(null);
  const [record, setRecord] = useState<SyncRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<{ phase: Phase; message: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextDescription, nextRecord] = await Promise.all([
      rpc.current.describe({ workspaceDirectory: props.workspaceDirectory }),
      local
        ? rpc.current.loadRecord({ serverWorkspaceId: props.workspaceId, localServerId: local.serverId })
        : Promise.resolve({ record: null }),
    ]);
    setDescription(nextDescription);
    setRecord(nextRecord.record);
  }, [props.workspaceDirectory, props.workspaceId, local?.serverId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run() {
    if (!local || !description) return;
    setBusy(true);
    setError(null);
    setAuthUrl(null);
    setLog([]);
    try {
      // Re-read right before syncing so the WIP counts are current.
      const fresh = await rpc.current.describe({ workspaceDirectory: props.workspaceDirectory });
      setDescription(fresh);
      const { settings } = await rpc.current.loadSettings({});
      const next = await sync(
        {
          serverWorkspaceId: props.workspaceId,
          description: fresh,
          localServerId: local.serverId,
          local: getPaseoClient(local.serverId) as unknown as HostApi,
          cloneBase: settings.cloneBase,
          existing: record,
        },
        {
          onPhase: (nextPhase, message) => setPhase({ phase: nextPhase, message }),
          onLine: (line) => setLog((current) => [...current.slice(-40), line]),
          onAuthUrl: setAuthUrl,
        },
      );
      await rpc.current.storeRecord(next);
      setRecord(next);
      setAuthUrl(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const changes = description ? description.changed.length + description.deleted.length : 0;

  return (
    <View style={{ padding: 12, gap: 10, width: 380, backgroundColor: props.theme.colors.surface0 }}>
      <Text style={{ color: ink, fontSize: 13, fontWeight: "600" }}>
        {local ? `Sync to ${local.label.replace(/\.local$/, "")}` : "Sync to local"}
      </Text>

      {!local ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          No other online Paseo host. Run Paseo on your machine and connect it to this app, then this can mirror the
          workspace there.
        </Text>
      ) : null}

      {description && !description.ok ? (
        <Text style={{ color: BAD, fontSize: 11 }}>■ {description.error}</Text>
      ) : null}

      {description?.ok ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          {description.branch ?? "detached"} @ {description.head?.slice(0, 8)} ·{" "}
          {changes === 0 ? "no uncommitted changes" : `${changes} uncommitted change${changes === 1 ? "" : "s"}`}
        </Text>
      ) : null}

      {record ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: GOOD, fontSize: 11 }}>● Synced {ago(record.syncedAt)}</Text>
          <Text selectable style={{ color: muted, fontSize: 10, fontFamily: mono }}>
            {record.localDirectory}
          </Text>
        </View>
      ) : local ? (
        <Text style={{ color: muted, fontSize: 11 }}>
          First sync creates a worktree on {local.label.replace(/\.local$/, "")} and runs the project's setup there.
          It overwrites that worktree each time — changes made there are not synced back.
        </Text>
      ) : null}

      {authUrl ? (
        <Pressable onPress={() => void openExternalUrl(authUrl)}>
          <Text style={{ color: WARN, fontSize: 11 }}>
            ▲ Tailscale SSH wants you to sign in. Open the login page ↗ — the sync continues once you do.
          </Text>
        </Pressable>
      ) : null}

      {phase ? (
        <Text style={{ color: phase.phase === "done" ? GOOD : ink, fontSize: 11 }}>
          {phase.phase === "done" ? "●" : "…"} {phase.message}
        </Text>
      ) : null}

      {busy && log.length > 0 ? (
        <ScrollView style={{ maxHeight: 110 }}>
          {log.slice(-12).map((line, index) => (
            <Text key={`${index}-${line}`} style={{ color: muted, fontSize: 9, fontFamily: mono }} numberOfLines={1}>
              {line}
            </Text>
          ))}
        </ScrollView>
      ) : null}

      {error ? (
        <Text selectable style={{ color: BAD, fontSize: 11 }}>
          ■ {error}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Pressable
          onPress={() => void run()}
          disabled={busy || !local || !description?.ok}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: props.theme.colors.accent,
            opacity: busy || !local || !description?.ok ? 0.5 : 1,
          }}
        >
          <Text style={{ color: props.theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
            {busy ? "Syncing…" : record ? "Sync again" : "Sync now"}
          </Text>
        </Pressable>
        {busy ? <ActivityIndicator color={muted} /> : null}
        {record && !busy && local ? (
          <Pressable
            onPress={() => {
              void rpc.current
                .dropRecord({ serverWorkspaceId: props.workspaceId, localServerId: local.serverId })
                .then(() => setRecord(null));
            }}
          >
            <Text style={{ color: muted, fontSize: 11 }}>Forget link</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
