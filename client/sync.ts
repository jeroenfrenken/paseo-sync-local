import type { Description, SyncRecord } from "../shared/contracts";
import { homePath, q, runScript, type HostApi } from "./remote";

/**
 * Mirror one server workspace onto the local host.
 *
 *   1. find the project on the local host by git origin, or clone it
 *   2. fetch the server workspace's HEAD straight from this box over SSH,
 *      so unpushed commits come along
 *   3. first time only: have the local Paseo create a worktree on that commit,
 *      which runs the project's own worktree.setup there
 *   4. reset that worktree to the fetched commit, then stream the uncommitted
 *      files — as git lists them — over SSH and unpack them on top
 *
 * One-way, server to local. Only a worktree this plugin created is ever reset;
 * the local main checkout and any other worktree are never touched.
 */

export type Phase = "locate" | "clone" | "fetch" | "worktree" | "apply" | "done";

export interface SyncCallbacks {
  onPhase(phase: Phase, message: string): void;
  onLine(line: string): void;
  onAuthUrl(url: string): void;
}

export interface SyncInput {
  serverWorkspaceId: string;
  description: Description;
  localServerId: string;
  local: HostApi;
  cloneBase: string;
  existing: SyncRecord | null;
}

export class SyncError extends Error {}

const SSH_OPTS = "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15";

const DEPENDENCY_FILES = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;

/** `github.com/owner/repo` from any ssh/https remote form. */
export function normaliseOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  const cleaned = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .toLowerCase();
  return cleaned || null;
}

export async function sync(input: SyncInput, callbacks: SyncCallbacks): Promise<SyncRecord> {
  const { description: d, local } = input;
  if (!d.ok || !d.head) throw new SyncError(d.error ?? "The server workspace is not a git repository.");

  const run = async (script: string, anchor: string, timeoutSeconds: number) => {
    const result = await runScript(local, anchor, script, {
      timeoutSeconds,
      onLine: callbacks.onLine,
      onAuthUrl: callbacks.onAuthUrl,
    });
    if (result.timedOut) throw new SyncError(`Timed out after ${timeoutSeconds}s.`);
    if (result.code !== 0) {
      const tail = result.output.slice(-4).join("\n");
      throw new SyncError(`Failed with exit ${result.code ?? "?"}${tail ? `:\n${tail}` : "."}`);
    }
    return result.output;
  };

  const readValue = (output: string[], key: string) =>
    output.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";

  // ── 1. locate ──────────────────────────────────────────────────────────
  callbacks.onPhase("locate", "Looking for the project on the local host");
  const { entries: localWorkspaces = [] } = await local.workspaces.list();
  if (localWorkspaces.length === 0) {
    throw new SyncError("The local host has no workspace to run commands in. Open any folder in Paseo there first.");
  }

  const reusable =
    input.existing && localWorkspaces.some((ws) => ws.id === input.existing?.localWorkspaceId) ? input.existing : null;
  const anchor = reusable?.localWorkspaceId ?? localWorkspaces[0].id;

  let root = reusable?.localProjectRoot ?? "";
  if (!root) {
    const { projects = [] } = await local.projects.list();
    const wanted = normaliseOrigin(d.originUrl);
    if (projects.length > 0 && wanted) {
      const probe = projects
        .map((p) => `printf 'P=%s\\t%s\\n' ${q(p.projectRootPath)} "$(git -C ${q(p.projectRootPath)} remote get-url origin 2>/dev/null)"`)
        .join("\n");
      const output = await run(`${probe}\ntrue`, anchor, 30);
      for (const line of output) {
        if (!line.startsWith("P=")) continue;
        const [path, origin] = line.slice(2).split("\t");
        if (path && normaliseOrigin(origin) === wanted) root = path;
      }
    }
  }

  // ── 2. clone when the project is not on the local host yet ────────────
  if (!root) {
    callbacks.onPhase("clone", `Setting up ${d.repoName} on the local host (first time only)`);
    const dest = `${homePath(input.cloneBase)}/${q(d.repoName)}`;
    const fromServer = `ssh://${d.sshTarget}${d.projectRoot}`;
    const output = await run(
      [
        `dest=${dest}`,
        `mkdir -p "$(dirname "$dest")"`,
        `if [ -d "$dest/.git" ]; then echo "reusing existing clone"; else`,
        // GitHub first; the server itself as a fallback, which always works
        // over the same SSH the rest of the sync already depends on.
        d.originUrl
          ? `  git clone --quiet ${q(d.originUrl)} "$dest" || GIT_SSH_COMMAND=${q(`ssh ${SSH_OPTS}`)} git clone --quiet ${q(fromServer)} "$dest"`
          : `  GIT_SSH_COMMAND=${q(`ssh ${SSH_OPTS}`)} git clone --quiet ${q(fromServer)} "$dest"`,
        d.originUrl ? `  git -C "$dest" remote set-url origin ${q(d.originUrl)}` : "  true",
        `fi`,
        `echo "ROOT=$(cd "$dest" && pwd -P)"`,
      ].join("\n"),
      anchor,
      30 * 60,
    );
    root = readValue(output, "ROOT");
    if (!root) throw new SyncError("Clone finished but its path could not be read back.");
  }

  // ── 3. fetch the server's HEAD, including unpushed commits ────────────
  callbacks.onPhase("fetch", "Fetching commits from the server");
  const ref = `refs/paseo-sync/${input.serverWorkspaceId}`;
  const serverUrl = `ssh://${d.sshTarget}${d.workspaceDirectory}`;
  const wantedBranch = d.branch ?? `detached-${d.head.slice(0, 8)}`;

  const fetched = await run(
    [
      `cd ${q(root)}`,
      `GIT_SSH_COMMAND=${q(`ssh ${SSH_OPTS}`)} git fetch --quiet ${q(serverUrl)} HEAD`,
      `git update-ref ${q(ref)} FETCH_HEAD`,
      `echo "HEAD=$(git rev-parse ${q(ref)})"`,
      // A branch can only be checked out in one worktree; if the local main
      // checkout already has it (typically main), use a sync-prefixed name.
      `if git worktree list --porcelain | grep -qx ${q(`branch refs/heads/${wantedBranch}`)}; then`,
      `  echo "BRANCH=sync/${wantedBranch}"`,
      `else`,
      `  echo "BRANCH=${wantedBranch}"`,
      `fi`,
    ].join("\n"),
    anchor,
    10 * 60,
  );
  if (readValue(fetched, "HEAD") !== d.head) {
    throw new SyncError("The fetched commit does not match the server workspace's HEAD.");
  }

  // ── 4. the local worktree, created by the local Paseo ─────────────────
  let directory = reusable?.localDirectory ?? "";
  let localWorkspaceId = reusable?.localWorkspaceId ?? "";
  let branch = reusable?.branch ?? readValue(fetched, "BRANCH");

  if (!reusable) {
    callbacks.onPhase("worktree", `Creating a worktree on the local host (runs the project's setup)`);
    await run(`cd ${q(root)}\ngit branch -f ${q(branch)} ${q(ref)}`, anchor, 60);

    const handle = await local.workspaces.create({
      source: { kind: "worktree", cwd: root, action: "checkout", refName: branch },
      title: d.branch ?? wantedBranch,
    });
    localWorkspaceId = handle.id;
    directory = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? "";
    if (!directory) throw new SyncError("The local worktree was created but its directory is unknown.");
  }

  // Never reset anything but a worktree this plugin made.
  if (directory === root) throw new SyncError("Refusing to overwrite the local main checkout.");

  // ── 5. overlay the uncommitted work ───────────────────────────────────
  callbacks.onPhase(
    "apply",
    `Applying ${d.changed.length} changed and ${d.deleted.length} deleted file${d.changed.length + d.deleted.length === 1 ? "" : "s"}`,
  );
  const remoteDir = q(d.workspaceDirectory);
  const listChanged =
    `cd ${remoteDir} && { git diff -z --name-only --no-renames --diff-filter=d HEAD; ` +
    `git ls-files -z --others --exclude-standard; } | tar --null -T - -cf -`;
  const listDeleted = `cd ${remoteDir} && git diff --name-only --no-renames --diff-filter=D HEAD`;

  await run(
    [
      `cd ${q(directory)}`,
      `test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"`,
      `git reset --hard --quiet ${q(ref)}`,
      // Untracked leftovers from a previous sync. Skipped on the first sync,
      // where setup is running in this fresh worktree right now and may be
      // generating untracked files. Ignored files (node_modules, .env) are
      // never touched either way, because -x is not passed.
      reusable ? `git clean -fdq` : `true`,
      `ssh ${SSH_OPTS} ${q(d.sshTarget)} ${q(listDeleted)} | while IFS= read -r f; do rm -f -- "$f"; done`,
      `ssh ${SSH_OPTS} ${q(d.sshTarget)} ${q(listChanged)} | tar -xf - -C .`,
      `echo "APPLIED=1"`,
    ].join("\n"),
    anchor,
    10 * 60,
  );

  const record: SyncRecord = {
    serverWorkspaceId: input.serverWorkspaceId,
    localServerId: input.localServerId,
    localWorkspaceId,
    localDirectory: directory,
    localProjectRoot: root,
    branch,
    head: d.head,
    syncedAt: new Date().toISOString(),
  };

  const depsChanged = d.changed.some((file) => DEPENDENCY_FILES.test(file));
  callbacks.onPhase(
    "done",
    reusable
      ? depsChanged
        ? "Synced. Dependency files changed — run the project's setup again on the local host."
        : "Synced."
      : "Synced. The local Paseo is running the project's setup in the new worktree.",
  );
  return record;
}
