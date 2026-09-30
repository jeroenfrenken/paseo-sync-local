import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import { getSettings, saveSettings, type Settings } from "../shared/contracts";

export function SyncSettings(props: PluginSurfaceProps) {
  const load = useRpc(getSettings);
  const save = useRpc(saveSettings);
  const rpc = useRef({ load, save });
  rpc.current = { load, save };

  const [settings, setSettings] = useState<Settings | null>(null);
  const [detected, setDetected] = useState("");

  useEffect(() => {
    void rpc.current.load({}).then((result) => {
      setSettings(result.settings);
      setDetected(result.detectedSshTarget);
    });
  }, []);

  const update = (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void rpc.current.save(next);
  };

  if (!settings) return <Text style={{ color: props.theme.colors.foregroundMuted, padding: 16 }}>Loading…</Text>;

  return (
    <ScrollView contentContainerStyle={{ gap: 16 }}>
      <SettingsSection title="Sync to local">
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
    </ScrollView>
  );
}
