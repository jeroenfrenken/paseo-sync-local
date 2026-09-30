/**
 * A manifest is a worktree's state as git sees it: the HEAD commit plus a hash
 * per uncommitted file. Taken on the server at sync time and stored with the
 * mirror, it answers two questions later by plain comparison:
 *
 *   - what changed on the server since the last sync
 *   - what was edited in the local mirror (and would be overwritten)
 *
 * Ignored files never appear, exactly like the sync itself.
 */

/**
 * Prints the manifest of the current directory, sorted:
 *   H <commit>
 *   D - <path>          deleted, uncommitted
 *   F <blob> <path>     modified or untracked
 * Given a previous commit as $1, also lists `C <blob> <path>` for every file
 * that differs between it and HEAD, with its blob at HEAD ("-" if gone), or
 * `C *` when that commit is unknown.
 */
export const MANIFEST_SCRIPT = [
  "set -e",
  'old="${1:-}"',
  "h=$(git rev-parse HEAD)",
  "{",
  '  echo "H $h"',
  '  if [ -n "$old" ] && [ "$old" != "$h" ]; then',
  '    if git cat-file -e "$old^{commit}" 2>/dev/null; then',
  "      git diff -z --name-only --no-renames \"$old\" \"$h\" -- | while IFS= read -r -d '' f; do",
  '        printf \'C %s %s\\n\' "$(git rev-parse -q --verify "$h:$f" 2>/dev/null || echo -)" "$f"',
  "      done",
  "    else",
  '      echo "C *"',
  "    fi",
  "  fi",
  "  git diff -z --name-only --no-renames --diff-filter=D HEAD | while IFS= read -r -d '' f; do printf 'D - %s\\n' \"$f\"; done",
  "  { git diff -z --name-only --no-renames --diff-filter=d HEAD; git ls-files -z --others --exclude-standard; } |",
  "    while IFS= read -r -d '' f; do printf 'F %s %s\\n' \"$(git hash-object -- \"$f\")\" \"$f\"; done",
  "} | LC_ALL=C sort -u",
].join("\n");

export interface Manifest {
  head: string;
  /** path → blob hash, or "-" for a deleted file. */
  files: Map<string, string>;
  /** Paths that differ between the given previous commit and HEAD → blob at HEAD. */
  committed: Map<string, string>;
  /** The previous commit was unknown, so nothing can be counted. */
  unknownBase: boolean;
}

export function parseManifest(text: string): Manifest {
  const manifest: Manifest = { head: "", files: new Map(), committed: new Map(), unknownBase: false };
  for (const line of text.split("\n")) {
    if (line.startsWith("H ")) manifest.head = line.slice(2).trim();
    else if (line === "C *") manifest.unknownBase = true;
    else if (/^[CDF] /.test(line)) {
      const rest = line.slice(2);
      const space = rest.indexOf(" ");
      if (space <= 0) continue;
      (line[0] === "C" ? manifest.committed : manifest.files).set(rest.slice(space + 1), rest.slice(0, space));
    }
  }
  return manifest;
}

/** The stored form: no `C` lines, which only mean something relative to one base. */
export function storableManifest(text: string): string {
  return `${text
    .split("\n")
    .filter((line) => /^[HDF] /.test(line))
    .join("\n")}\n`;
}

/**
 * Paths that differ between a stored manifest and a current one taken with
 * `stored.head` as base. `null` when the difference cannot be counted.
 */
export function changedPaths(stored: Manifest, current: Manifest): Set<string> | null {
  if (current.unknownBase) return null;
  // A file's content as each side has it: its uncommitted blob if dirty,
  // otherwise its blob in the commit. `undefined` means "as in stored.head".
  const now = (path: string) => current.files.get(path) ?? current.committed.get(path);
  const then = (path: string) => stored.files.get(path);
  const paths = new Set<string>();
  for (const path of new Set([...current.files.keys(), ...current.committed.keys(), ...stored.files.keys()])) {
    if (now(path) !== then(path)) paths.add(path);
  }
  return paths;
}
