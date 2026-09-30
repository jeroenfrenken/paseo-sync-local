import { execFile } from "node:child_process";
import path from "node:path";
import type { Description } from "../shared/contracts";
import { detectSshTarget, loadSettings } from "./state";

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) =>
      resolve({ ok: !error, out: stdout ?? "" }),
    );
  });
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

export async function describe(workspaceDirectory: string): Promise<Description> {
  const settings = loadSettings();
  const sshTarget = settings.sshTarget.trim() || detectSshTarget();
  const base: Description = {
    ok: false,
    error: null,
    workspaceDirectory,
    projectRoot: workspaceDirectory,
    repoName: path.basename(workspaceDirectory),
    originUrl: null,
    branch: null,
    head: null,
    sshTarget,
    changed: [],
    deleted: [],
  };

  const head = await git(["rev-parse", "HEAD"], workspaceDirectory);
  if (!head.ok) return { ...base, error: "Not a git repository." };

  // A linked worktree's common dir is the main checkout's .git.
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspaceDirectory);
  const projectRoot = common.ok ? path.dirname(common.out.trim()) : workspaceDirectory;

  const [branch, origin, changed, untracked, deleted] = await Promise.all([
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], workspaceDirectory),
    git(["remote", "get-url", "origin"], workspaceDirectory),
    git(["diff", "--name-only", "--no-renames", "--diff-filter=d", "HEAD"], workspaceDirectory),
    git(["ls-files", "--others", "--exclude-standard"], workspaceDirectory),
    git(["diff", "--name-only", "--no-renames", "--diff-filter=D", "HEAD"], workspaceDirectory),
  ]);

  const originUrl = origin.ok ? origin.out.trim() || null : null;
  const repoName = (originUrl ?? projectRoot).replace(/\.git$/, "").split(/[/:]/).pop() || path.basename(projectRoot);

  return {
    ...base,
    ok: true,
    projectRoot,
    repoName,
    originUrl,
    branch: branch.ok ? branch.out.trim() || null : null,
    head: head.out.trim(),
    changed: [...new Set([...lines(changed.out), ...lines(untracked.out)])],
    deleted: lines(deleted.out),
  };
}
