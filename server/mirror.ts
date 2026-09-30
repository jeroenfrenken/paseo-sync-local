/**
 * The local host's side: a mirror worktree pulls the server's current state
 * into itself. Runs in this daemon with plain child processes; the server only
 * needs SSH and git, not this plugin.
 *
 * Same steps as the first sync minus the worktree creation: fetch the server's
 * HEAD, reset to it, clear untracked leftovers, then overlay the server's
 * uncommitted files. Ignored files (.env, node_modules) are never touched.
 */
import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTH_URL,
  DEPENDENCY_FILES,
  MANIFEST_FILE,
  MIRROR_FILE,
  SSH_OPTS,
  SSH_OPTS_ARGV,
  listDeletedCommand,
  manifestCommand,
  q,
  tarChangedCommand,
} from "../shared/commands";
import { MirrorSchema, type Check, type Mirror, type PullState } from "../shared/contracts";
import { MANIFEST_SCRIPT, changedPaths, parseManifest, storableManifest } from "../shared/manifest";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; onLine?(line: string): void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `ssh ${SSH_OPTS}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const lines = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) options.onLine?.(line);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      lines(data.toString());
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastLines = (text: string) => text.trim().split("\n").slice(-4).join("\n");

async function gitDir(directory: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: directory, timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function readMirror(directory: string): Promise<Mirror | null> {
  const dir = await gitDir(directory).catch(() => null);
  if (!dir) return null;
  try {
    const parsed = MirrorSchema.safeParse(JSON.parse(await readFile(path.join(dir, MIRROR_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readStoredManifest(directory: string) {
  const dir = await gitDir(directory);
  if (!dir) return null;
  return readFile(path.join(dir, MANIFEST_FILE), "utf8").catch(() => null);
}

function remoteManifest(mirror: Mirror, base: string, timeoutMs: number, onLine?: (line: string) => void) {
  return run(
    "ssh",
    [...SSH_OPTS_ARGV, mirror.sshTarget, manifestCommand(mirror.serverDirectory, MANIFEST_SCRIPT, base)],
    { cwd: "/", timeoutMs, onLine },
  );
}

function localManifest(directory: string, base: string) {
  return run("bash", ["-c", MANIFEST_SCRIPT, "manifest", base], { cwd: directory, timeoutMs: 30_000 });
}

// ── check ─────────────────────────────────────────────────────────────────

export async function check(directory: string): Promise<Check> {
  const checkedAt = new Date().toISOString();
  const blank: Check = { remoteChanges: null, localEdits: null, authUrl: null, error: null, checkedAt };
  const mirror = await readMirror(directory);
  if (!mirror) return { ...blank, error: "Not a mirror." };
  const storedText = await readStoredManifest(directory);
  if (!storedText) return { ...blank, error: "This mirror has no record of its last sync. Sync once to fix." };
  const stored = parseManifest(storedText);

  let authUrl: string | null = null;
  const [remote, local] = await Promise.all([
    remoteManifest(mirror, stored.head, 25_000, (line) => {
      authUrl ??= AUTH_URL.exec(line)?.[0] ?? null;
    }),
    localManifest(directory, stored.head),
  ]);

  const remoteChanges = remote.code === 0 ? changedPaths(stored, parseManifest(remote.stdout))?.size ?? null : null;
  const localEdits = local.code === 0 ? changedPaths(stored, parseManifest(local.stdout))?.size ?? null : null;
  const error =
    remote.code === 0 ? null : authUrl ? null : `Could not reach ${mirror.sshTarget}: ${lastLines(remote.stderr) || "timed out"}`;
  return { remoteChanges, localEdits, authUrl, error, checkedAt };
}

// ── pull ──────────────────────────────────────────────────────────────────

const pulls = new Map<string, PullState>();
const IDLE: PullState = { running: false, message: null, authUrl: null, error: null, log: [] };

export function pullState(directory: string): PullState {
  return pulls.get(directory) ?? IDLE;
}

/** Starts a pull in the background; false when one is already running. */
export function startPull(directory: string): boolean {
  if (pulls.get(directory)?.running) return false;
  const state: PullState = { running: true, message: "Starting", authUrl: null, error: null, log: [] };
  pulls.set(directory, state);
  void pull(directory, state)
    .then((message) => {
      state.message = message;
      state.authUrl = null;
    })
    .catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      state.running = false;
    });
  return true;
}

async function pull(directory: string, state: PullState): Promise<string> {
  const onLine = (line: string) => {
    state.log = [...state.log.slice(-40), line];
    const url = AUTH_URL.exec(line)?.[0];
    if (url) state.authUrl = url;
  };
  const step = async (message: string, command: string, args: string[], cwd: string, timeoutMs: number) => {
    state.message = message;
    const result = await run(command, args, { cwd, timeoutMs, onLine });
    if (result.code !== 0) {
      throw new Error(`${message} failed${result.code === null ? " (timed out)" : ""}: ${lastLines(result.stderr)}`);
    }
    return result.stdout;
  };

  const mirror = await readMirror(directory);
  if (!mirror) throw new Error("This workspace is not a mirror.");
  const dir = await gitDir(directory);
  if (!dir) throw new Error("Not a git worktree.");

  // Only ever reset a linked worktree at its own top level, never a main checkout.
  const top = (await step("Checking the worktree", "git", ["rev-parse", "--show-toplevel"], directory, 10_000)).trim();
  const common = (
    await step("Checking the worktree", "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], directory, 10_000)
  ).trim();
  if ((await realpath(top)) !== (await realpath(directory))) throw new Error("Not the top of a worktree.");
  if ((await realpath(path.dirname(common))) === (await realpath(top))) {
    throw new Error("Refusing to overwrite a main checkout.");
  }

  const previous = parseManifest((await readStoredManifest(directory)) ?? "");
  const ref = `refs/paseo-sync/${mirror.serverWorkspaceId}`;
  const serverUrl = `ssh://${mirror.sshTarget}${mirror.serverDirectory}`;

  // Manifest first, then fetch; if the server committed in between, take it again.
  let manifestText = "";
  let head = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    manifestText = await step(
      "Reading the server's state",
      "ssh",
      [...SSH_OPTS_ARGV, mirror.sshTarget, manifestCommand(mirror.serverDirectory, MANIFEST_SCRIPT, previous.head)],
      directory,
      5 * 60_000,
    );
    await step("Fetching commits from the server", "git", ["fetch", "--quiet", serverUrl, "HEAD"], directory, 10 * 60_000);
    await step("Fetching commits from the server", "git", ["update-ref", ref, "FETCH_HEAD"], directory, 10_000);
    head = (await step("Fetching commits from the server", "git", ["rev-parse", ref], directory, 10_000)).trim();
    if (parseManifest(manifestText).head === head) break;
  }

  await step(
    "Applying the server's changes",
    "bash",
    [
      "-c",
      [
        "set -eo pipefail",
        `git reset --hard --quiet ${q(ref)}`,
        "git clean -fdq",
        `ssh ${SSH_OPTS} ${q(mirror.sshTarget)} ${q(listDeletedCommand(mirror.serverDirectory))} | while IFS= read -r f; do rm -f -- "$f"; done`,
        `ssh ${SSH_OPTS} ${q(mirror.sshTarget)} ${q(tarChangedCommand(mirror.serverDirectory))} | tar -xf - -C .`,
      ].join("\n"),
    ],
    directory,
    10 * 60_000,
  );

  const current = parseManifest(manifestText);
  await writeFile(path.join(dir, MANIFEST_FILE), storableManifest(manifestText));
  await writeFile(
    path.join(dir, MIRROR_FILE),
    `${JSON.stringify({ ...mirror, head, syncedAt: new Date().toISOString() } satisfies Mirror, null, 2)}\n`,
  );

  const changed = changedPaths(previous, current);
  const deps = changed ? [...changed].some((file) => DEPENDENCY_FILES.test(file)) : false;
  const count = changed ? `${changed.size} file${changed.size === 1 ? "" : "s"} updated` : "Updated";
  return deps ? `${count}. Dependency files changed — rerun the project's setup.` : `${count}.`;
}
