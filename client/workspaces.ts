export interface WorkspaceEntry {
  id: string;
  workspaceDirectory?: string | null;
  gitRuntime?: unknown;
}

type WorkspaceUpdate = { kind: "upsert"; workspace: unknown } | { kind: "remove"; id: string };

export interface WorkspaceFeed {
  subscribe(listener: (update: WorkspaceUpdate) => void): () => void;
  list(options: { subscribe: object }): Promise<{ entries: unknown[] }>;
}

/** Calls `apply` for every workspace on a host now and on every change. */
export function followWorkspaces(
  feed: WorkspaceFeed,
  apply: (workspace: WorkspaceEntry) => void,
  remove: (id: string) => void,
): () => void {
  const unsubscribe = feed.subscribe((update) => {
    if (update.kind === "upsert") apply(update.workspace as WorkspaceEntry);
    else remove(update.id);
  });
  void feed
    .list({ subscribe: {} })
    .then((result) => {
      for (const workspace of result.entries) apply(workspace as WorkspaceEntry);
    })
    .catch((error: unknown) => console.warn("[local-sync] could not list workspaces", error));
  return unsubscribe;
}

export const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

export const shortHost = (label: string) => label.replace(/\.local$/, "");

/** First line of an error, short enough for a tooltip. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
