/**
 * Running a shell script on another Paseo host and reading its output.
 *
 * There is no remote-exec API, but a host's PaseoApi can open a terminal in one
 * of its workspaces with an explicit command. The script runs as argv — never
 * typed into a shell — ends by printing a marker with its exit code, and then
 * idles so the output can still be captured before the terminal is killed.
 */

export interface HostWorkspace {
  id: string;
  name?: string | null;
  projectId?: string;
  workspaceDirectory?: string | null;
}

export interface HostWorkspaceHandle {
  id: string;
  directory: string | null;
  projectId: string | null;
  refresh(): Promise<{ workspaceDirectory?: string | null } | null>;
}

export interface TerminalHandle {
  capture(options?: { stripAnsi?: boolean }): Promise<unknown>;
  kill(): Promise<void>;
}

/** The slice of a borrowed host's PaseoApi this plugin uses. */
export interface HostApi {
  workspaces: {
    list(options?: unknown): Promise<{ entries?: HostWorkspace[] }>;
    create(options: { source: Record<string, unknown>; title?: string }): Promise<HostWorkspaceHandle>;
  };
  projects: { list(options?: unknown): Promise<{ projects?: { projectId: string; projectRootPath: string }[] }> };
  terminals: {
    create(options: {
      workspaceId: string;
      cwd?: string;
      name?: string;
      command?: string;
      args?: string[];
      size?: { rows: number; cols: number };
    }): Promise<TerminalHandle>;
  };
}

/** Single-quote for a POSIX shell. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `~/x` to `"$HOME"/x`, since a tilde inside quotes never expands. */
export function homePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return `"$HOME"`;
  if (trimmed.startsWith("~/")) return `"$HOME"/${q(trimmed.slice(2))}`;
  return q(trimmed);
}

function captureText(result: unknown): string {
  if (typeof result === "string") return result;
  const value = result as { lines?: unknown; text?: unknown; content?: unknown } | null;
  if (Array.isArray(value?.lines)) {
    return value.lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
  }
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.content === "string") return value.content;
  return "";
}

const AUTH_URL = /https:\/\/login\.tailscale\.com\/[^\s'"]+/;

export interface RunOptions {
  /** Seconds before giving up. */
  timeoutSeconds: number;
  onLine?(line: string): void;
  /** Tailscale SSH "check" mode wants a browser login; surface the link. */
  onAuthUrl?(url: string): void;
}

export interface RunResult {
  code: number | null;
  output: string[];
  timedOut: boolean;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runScript(
  api: HostApi,
  anchorWorkspaceId: string,
  script: string,
  options: RunOptions,
): Promise<RunResult> {
  const marker = `__LOCAL_SYNC_${Math.random().toString(36).slice(2)}__`;
  const wrapped = `( set -e\n${script}\n)\ncode=$?\nprintf '\\n${marker}:%s\\n' "$code"\nsleep 900\n`;

  const terminal = await api.terminals.create({
    workspaceId: anchorWorkspaceId,
    name: "local-sync",
    command: "/bin/bash",
    args: ["-c", wrapped],
    // Wide, so long paths and the Tailscale login URL are not wrapped.
    size: { rows: 400, cols: 500 },
  });

  const seen: string[] = [];
  let authShown = false;
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  try {
    while (Date.now() < deadline) {
      await delay(700);
      const lines = captureText(await terminal.capture({ stripAnsi: true }))
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""));

      const done = lines.findIndex((line) => line.startsWith(`${marker}:`));
      const visible = (done >= 0 ? lines.slice(0, done) : lines).filter((line) => line.trim() !== "");

      for (const line of visible.slice(seen.length)) {
        seen.push(line);
        options.onLine?.(line);
        const url = AUTH_URL.exec(line)?.[0];
        if (url && !authShown) {
          authShown = true;
          options.onAuthUrl?.(url);
        }
      }

      if (done >= 0) {
        const code = Number.parseInt(lines[done].slice(marker.length + 1), 10);
        return { code: Number.isFinite(code) ? code : null, output: seen, timedOut: false };
      }
    }
    return { code: null, output: seen, timedOut: true };
  } finally {
    await terminal.kill().catch(() => undefined);
  }
}
