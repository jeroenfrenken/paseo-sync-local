import { openExternalUrl, useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { checkMirror, getMirror, pullMirror, type Check, type Mirror, type PullState } from "../shared/contracts";

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

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

export type MirrorPopoverProps = PluginButtonContentProps & {
  workspaceDirectory: string;
  /** Tells the header button what the popover found. */
  onChecked(check: Check): void;
};

export function MirrorPopover(props: MirrorPopoverProps) {
  const ink = props.theme.colors.foreground;
  const muted = props.theme.colors.foregroundMuted;
  const mono = props.layout.platform === "ios" ? "Menlo" : "monospace";

  const get = useRpc(getMirror);
  const checkNow = useRpc(checkMirror);
  const pull = useRpc(pullMirror);
  const rpc = useRef({ get, checkNow, pull, onChecked: props.onChecked });
  rpc.current = { get, checkNow, pull, onChecked: props.onChecked };

  const [mirror, setMirror] = useState<Mirror | null>(null);
  const [state, setState] = useState<PullState | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);

  const input = { workspaceDirectory: props.workspaceDirectory };

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const next = await rpc.current.checkNow({ workspaceDirectory: props.workspaceDirectory });
      setCheck(next);
      rpc.current.onChecked(next);
    } finally {
      setChecking(false);
    }
  }, [props.workspaceDirectory]);

  useEffect(() => {
    void rpc.current.get({ workspaceDirectory: props.workspaceDirectory }).then((result) => {
      setMirror(result.mirror);
      setState(result.pull);
    });
    void recheck();
  }, [props.workspaceDirectory, recheck]);

  // Follow a running pull.
  useEffect(() => {
    if (!state?.running) return;
    const timer = setTimeout(() => {
      void rpc.current.get({ workspaceDirectory: props.workspaceDirectory }).then((result) => {
        setMirror(result.mirror);
        setState(result.pull);
        if (!result.pull.running) void recheck();
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [state, props.workspaceDirectory, recheck]);

  async function start() {
    await rpc.current.pull(input);
    setState({ running: true, message: "Starting", authUrl: null, error: null, log: [] });
  }

  if (!mirror) {
    return (
      <View style={{ padding: 12, width: 360, backgroundColor: props.theme.colors.surface0 }}>
        <Text style={{ color: muted, fontSize: 11 }}>Loading…</Text>
      </View>
    );
  }

  const server = mirror.serverLabel.replace(/\.local$/, "");
  const running = state?.running ?? false;
  const authUrl = state?.authUrl ?? check?.authUrl ?? null;
  const remote = check?.remoteChanges;
  const localEdits = check?.localEdits ?? 0;

  return (
    <View style={{ padding: 12, gap: 10, width: 380, backgroundColor: props.theme.colors.surface0 }}>
      <View
        style={{
          padding: 10,
          gap: 4,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: WARN,
          backgroundColor: `${WARN}1f`,
        }}
      >
        <Text style={{ color: ink, fontSize: 12, fontWeight: "600" }}>▲ Local mirror — edit on {server}</Text>
        <Text style={{ color: ink, fontSize: 11 }}>
          This worktree mirrors {mirror.branch} on {server}. Make changes there; every sync overwrites this worktree.
        </Text>
      </View>

      <View style={{ gap: 2 }}>
        <Text style={{ color: muted, fontSize: 11 }}>
          Synced {ago(mirror.syncedAt)} · {mirror.head.slice(0, 8)}
        </Text>
        <Text selectable style={{ color: muted, fontSize: 10, fontFamily: mono }}>
          {mirror.sshTarget}:{mirror.serverDirectory}
        </Text>
      </View>

      {checking && !check ? (
        <Text style={{ color: muted, fontSize: 11 }}>Checking {server}…</Text>
      ) : check ? (
        <View style={{ gap: 4 }}>
          {check.error ? (
            <Text selectable style={{ color: BAD, fontSize: 11 }}>
              ■ {check.error}
            </Text>
          ) : remote === null || remote === undefined ? null : remote > 0 ? (
            <Text style={{ color: WARN, fontSize: 11 }}>● {files(remote)} changed on {server}</Text>
          ) : (
            <Text style={{ color: GOOD, fontSize: 11 }}>● Up to date with {server}</Text>
          )}
          {localEdits > 0 ? (
            <Text style={{ color: BAD, fontSize: 11 }}>
              ■ {files(localEdits)} edited here. Syncing discards {localEdits === 1 ? "it" : "them"}; ignored files like
              .env are kept.
            </Text>
          ) : null}
        </View>
      ) : null}

      {authUrl ? (
        <Pressable onPress={() => void openExternalUrl(authUrl)}>
          <Text style={{ color: WARN, fontSize: 11 }}>
            ▲ Tailscale SSH wants you to sign in. Open the login page ↗ — then check again.
          </Text>
        </Pressable>
      ) : null}

      {state?.message && (running || !state.error) ? (
        <Text style={{ color: running ? ink : GOOD, fontSize: 11 }}>
          {running ? "…" : "●"} {state.message}
        </Text>
      ) : null}

      {running && state && state.log.length > 0 ? (
        <ScrollView style={{ maxHeight: 90 }}>
          {state.log.slice(-8).map((line, index) => (
            <Text key={`${index}-${line}`} style={{ color: muted, fontSize: 9, fontFamily: mono }} numberOfLines={1}>
              {line}
            </Text>
          ))}
        </ScrollView>
      ) : null}

      {state?.error && !running ? (
        <Text selectable style={{ color: BAD, fontSize: 11 }}>
          ■ {state.error}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <Pressable
          onPress={() => void start()}
          disabled={running}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: localEdits > 0 ? BAD : props.theme.colors.accent,
            opacity: running ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              color: localEdits > 0 ? "#ffffff" : props.theme.colors.accentForeground,
              fontSize: 12,
              fontWeight: "600",
            }}
          >
            {running ? "Syncing…" : localEdits > 0 ? "Discard edits and sync" : remote ? "Sync changes" : "Sync now"}
          </Text>
        </Pressable>
        {running || checking ? <ActivityIndicator color={muted} /> : null}
        {!running && !checking ? (
          <Pressable onPress={() => void recheck()}>
            <Text style={{ color: muted, fontSize: 11 }}>Check again</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
