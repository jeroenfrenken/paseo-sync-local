import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import { getSettings, saveSettings, type Role, type Settings } from "../shared/contracts";
import { announceRole } from "./role";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export function SyncSettings(props: PluginSurfaceProps) {
  const load = useRpc(getSettings);
  const save = useRpc(saveSettings);
  const rpc = useRef({ load, save });
  rpc.current = { load, save };

  const [settings, setSettings] = useState<Settings | null>(null);
  const [detected, setDetected] = useState("");
  const [role, setRole] = useState<Role>("remote");
  const [platform, setPlatform] = useState("");

  useEffect(() => {
    void rpc.current.load({}).then((result) => {
      setSettings(result.settings);
      setDetected(result.detectedSshTarget);
      setRole(result.role);
      setPlatform(result.platform);
    });
  }, []);

  const update = (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void rpc.current.save(next).then((result) => {
      setRole(result.role);
      announceRole(result.role);
    });
  };

  if (!settings) return <Text style={{ color: props.theme.colors.foregroundMuted, padding: 16 }}>Loading…</Text>;

  const host = props.host.label.replace(/\.local$/, "");
  const auto = platform === "darwin" || platform === "win32" ? "local" : "remote";

  return (
    <ScrollView contentContainerStyle={{ gap: 16 }}>
      <SettingsSection title={`Sync to local · ${host}`}>
        <SettingsSelect
          label="This host is"
          hint={
            role === "remote"
              ? "Where you work. Git workspaces get a Sync local button that mirrors them onto your local host."
              : "Where you test. Mirrored workspaces get a warning badge and pull the server's changes; nothing else changes."
          }
          value={settings.role}
          options={[
            { label: `Auto (${PLATFORM[platform] ?? platform}: ${auto})`, value: "auto" },
            { label: "Remote: the source you edit", value: "remote" },
            { label: "Local: holds mirrors", value: "local" },
          ]}
          onValueChange={(next) => update({ role: next })}
        />
      </SettingsSection>

      {role === "remote" ? (
        <SettingsSection title="Mirroring">
          <SettingsSelect
            label="Mode"
            hint="On demand syncs when you press the button. Live sync is planned."
            value={settings.mode}
            options={[{ label: "On demand", value: "manual" }]}
            onValueChange={(mode) => update({ mode })}
          />
          <SettingsInput
            label="Server address"
            hint={`What your machine SSHes to. Blank uses the detected ${detected}.`}
            initialValue={settings.sshTarget}
            placeholder={detected}
            onChangeText={(sshTarget) => update({ sshTarget })}
          />
          <SettingsInput
            label="Clone location"
            hint="Where a project is cloned on your machine when it is not there yet. Existing checkouts are found by git origin and reused."
            initialValue={settings.cloneBase}
            placeholder="~/paseo-sync"
            onChangeText={(cloneBase) => update({ cloneBase })}
          />
        </SettingsSection>
      ) : null}
    </ScrollView>
  );
}
