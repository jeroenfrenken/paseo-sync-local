/**
 * v0.8 compiles the two entries separately and enforces the runtime boundary:
 * the client bundle may not reach `server/` or any node: builtin, and the
 * server bundle may not reach `client/`. Those failures only surface when the
 * plugin loads, so check both here.
 */
import { build } from "esbuild";

const SHARED_EXTERNAL = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/server",
  "zod",
];

function forbid(rules) {
  return {
    name: "paseo-plugin-boundary",
    setup(context) {
      for (const [filter, message] of rules) {
        context.onResolve({ filter }, (args) => ({ errors: [{ text: `${message}: ${args.path}` }] }));
      }
    },
  };
}

async function check({ entry, platform, external, rules }) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform,
    target: platform === "node" ? "node20" : "es2020",
    external,
    plugins: [forbid(rules)],
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  const size = (result.outputFiles[0].text.length / 1024).toFixed(1);
  console.log(`${entry} builds clean (${size} KB)`);
}

await check({
  entry: "index.client.tsx",
  platform: "neutral",
  external: [...SHARED_EXTERNAL, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native"],
  rules: [
    [/(^|\/)server\//, "server-only module reached the client bundle"],
    [/^node:/, "node builtin reached the client bundle"],
  ],
});

await check({
  entry: "index.server.ts",
  platform: "node",
  external: SHARED_EXTERNAL,
  rules: [[/(^|\/)client\//, "client-only module reached the server bundle"]],
});

/**
 * The host rejects duplicate client contributions when the app evaluates the
 * bundle — not when the daemon loads it. That means `paseo plugin ls` can read
 * `running` while the plugin is actually broken in the UI, so catch it here.
 *
 * Slash commands are keyed by name and everything else by id, in both cases
 * ignoring `context` — two registrations of the same name for different
 * contexts is a duplicate.
 */
import { readFile } from "node:fs/promises";

const entry = await readFile("index.client.tsx", "utf8");

const KINDS = [
  { call: "addSlashCommand", key: "name" },
  { call: "addSidebarItem", key: "id" },
  { call: "addCommandCenterItem", key: "id" },
  { call: "addWorkspacePanel", key: "id" },
  { call: "addAttachmentSource", key: "id" },
  { call: "addSettingsScreen", key: "id" },
  { call: "addTheme", key: "id" },
  { call: "addComposerPill", key: "id" },
];

const duplicates = [];
for (const { call, key } of KINDS) {
  const seen = new Map();
  const pattern = new RegExp(`${call}\\s*\\(\\s*\\{([\\s\\S]{0,400}?)\\}\\s*\\)`, "g");
  for (const match of entry.matchAll(pattern)) {
    const found = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(match[1]);
    if (!found) continue;
    const value = found[1];
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  for (const [value, count] of seen) {
    if (count > 1) duplicates.push(`${call}: ${key} "${value}" registered ${count} times`);
  }
}

// addSurface takes its id positionally.
const surfaces = new Map();
for (const match of entry.matchAll(/addSurface\s*\(\s*["'`]?([A-Za-z0-9_-]+)["'`]?\s*,/g)) {
  surfaces.set(match[1], (surfaces.get(match[1]) ?? 0) + 1);
}
for (const [value, count] of surfaces) {
  if (count > 1) duplicates.push(`addSurface: id "${value}" registered ${count} times`);
}

if (duplicates.length > 0) {
  console.error("duplicate client contributions (the app would refuse to load this plugin):");
  for (const line of duplicates) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("no duplicate client contributions");
