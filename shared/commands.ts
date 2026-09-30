/** Shell pieces both sides of a sync build on. Plain strings, no runtime. */

export const SSH_OPTS = "-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15";
export const SSH_OPTS_ARGV = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15"];

/** Single-quote for a POSIX shell. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run on the server: a tar of every uncommitted, non-ignored file. */
export function tarChangedCommand(serverDirectory: string): string {
  return (
    `cd ${q(serverDirectory)} && { git diff -z --name-only --no-renames --diff-filter=d HEAD; ` +
    `git ls-files -z --others --exclude-standard; } | tar --null -T - -cf -`
  );
}

/** Run on the server: uncommitted deletions, one per line. */
export function listDeletedCommand(serverDirectory: string): string {
  return `cd ${q(serverDirectory)} && git diff --name-only --no-renames --diff-filter=D HEAD`;
}

/** Run on the server: its manifest (see manifest.ts), relative to `base`. */
export function manifestCommand(serverDirectory: string, script: string, base: string): string {
  return `cd ${q(serverDirectory)} && bash -c ${q(script)} manifest ${q(base)}`;
}

export const DEPENDENCY_FILES = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;

/** Starts every mirror workspace's title, so it reads as a copy in the sidebar. */
export const MIRROR_TITLE_PREFIX = "[MIRROR]";

/** Earlier prefixes, swapped for the current one. */
const LEGACY_PREFIXES = ["[CLONE]"];

export function mirrorTitle(title: string): string {
  if (title.startsWith(MIRROR_TITLE_PREFIX)) return title;
  const legacy = LEGACY_PREFIXES.find((prefix) => title.startsWith(prefix));
  const rest = legacy ? title.slice(legacy.length).trimStart() : title;
  return `${MIRROR_TITLE_PREFIX} ${rest}`;
}

export const MIRROR_FILE = "paseo-sync.json";
export const MANIFEST_FILE = "paseo-sync.manifest";

export const AUTH_URL = /https:\/\/login\.tailscale\.com\/[^\s'"]+/;
