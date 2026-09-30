import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, SettingsSchema, RecordSchema, type Settings, type SyncRecord } from "../shared/contracts";

const FILE = path.join(os.homedir(), ".config", "paseo-local-sync", "state.json");

interface State {
  settings?: unknown;
  records?: unknown[];
}

function read(): State {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function write(state: State) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** This box as the local machine should address it: `user@<tailscale name>`. */
export function detectSshTarget(): string {
  const user = os.userInfo().username;
  try {
    const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 }));
    const dns = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
    if (dns) return `${user}@${dns}`;
  } catch {
    // No Tailscale CLI; fall back to the plain hostname.
  }
  return `${user}@${os.hostname()}`;
}

export function loadSettings(): Settings {
  const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((read().settings as object) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function storeSettings(settings: Settings) {
  write({ ...read(), settings });
  return loadSettings();
}

function records(): SyncRecord[] {
  return (read().records ?? []).flatMap((entry) => {
    const parsed = RecordSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function findRecord(serverWorkspaceId: string, localServerId: string): SyncRecord | null {
  return (
    records().find((r) => r.serverWorkspaceId === serverWorkspaceId && r.localServerId === localServerId) ?? null
  );
}

export function upsertRecord(record: SyncRecord) {
  const rest = records().filter(
    (r) => !(r.serverWorkspaceId === record.serverWorkspaceId && r.localServerId === record.localServerId),
  );
  write({ ...read(), records: [...rest, record] });
}

export function removeRecord(serverWorkspaceId: string, localServerId: string) {
  const rest = records().filter(
    (r) => !(r.serverWorkspaceId === serverWorkspaceId && r.localServerId === localServerId),
  );
  write({ ...read(), records: rest });
}

export function stateExists() {
  return existsSync(FILE);
}
