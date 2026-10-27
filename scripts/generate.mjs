#!/usr/bin/env node
// Build the shipped pstack tree from the pinned upstream snapshot (.upstream/, see vendor.mjs).
//
// Mirrors upstream's own harness generator (cursor/plugins scripts/generate-pstack-harness-trees.mjs):
// skill text stays byte-identical, every SKILL.md that uses Cursor names gets one line pointing at the
// pi adapter, and links to upstream files this tree leaves out point at GitHub at the pinned commit.
//
//   node scripts/generate.mjs           # write pstack/, cursor-team-kit/, docs/fidelity.md
//   node scripts/generate.mjs --check   # fail if anything on disk differs from a fresh generation

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".upstream");
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));
const MANIFEST = join(ROOT, ".generated-files.json");
const ADAPTER_SOURCE = join(ROOT, "adapters/pi.md");
const ADAPTER = "docs/harness/pi.md";
const CHECK = process.argv.includes("--check");
const GITHUB = `https://github.com/cursor/plugins`;
const LINK = /\]\(([^)\s]+)\)/g;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUTE_KEY = "Run another pstack skill";
const ADAPTER_LINE =
  "In pi, read [the pi adapter](../../docs/harness/pi.md) once per session before you follow this skill. " +
  "It maps the Cursor names in pstack skills to pi tools, models, and paths.";

// Cursor names the adapter must cover. Upstream's Claude Code list, plus host features pi lacks.
export const TERMS = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "poteto-agent", re: /poteto-agent/ },
  { key: "comment-sicko", re: /comment-sicko/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: '`environment: "cloud"`', re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "inherit-parent", re: /inherit-parent/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin|plugins\/cache/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  { key: "Cursor-only features", re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/ },
  { key: "`/loop`", re: /\/loop\b/ },
  { key: "agent store", re: /agent(?:'s)? store/ },
  { key: "cursor-team-kit", re: /cursor-team-kit/ },
  { key: "`/create-skill`", re: /(?<![\w-])create-skill(?![\w-])/ },
  { key: "Custom Mode", re: /Custom Mode/ },
  { key: "`Grep`, `Glob`", re: /`(Grep|Glob)`/ },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toPosix = (path) => path.split("\\").join("/");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// 1. The snapshot must match the lock byte for byte.
if (!existsSync(CACHE)) {
  console.error("No .upstream/ snapshot. Run `npm run vendor` first.");
  process.exit(1);
}
const upstream = new Map();
for (const file of LOCK.files) {
  const path = join(CACHE, file.path);
  if (!existsSync(path)) throw new Error(`Snapshot is missing ${file.path}. Run \`npm run vendor\`.`);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== file.sha256) throw new Error(`Snapshot file ${file.path} does not match upstream.lock.json.`);
  upstream.set(file.path, { bytes, mode: file.mode });
}
const extra = walk(CACHE).map((path) => toPosix(relative(CACHE, path))).filter((path) => !upstream.has(path));
if (extra.length) throw new Error(`Snapshot has files the lock does not list: ${extra.slice(0, 5).join(", ")}`);

// 2. Choose what ships. Upstream paths are relative to the cursor/plugins root.
// statechart's scripts/test/ is its CLI's own 3.6 MB test suite; agents never run it.
const SHIP = [
  { from: "pstack/skills/", to: "pstack/skills/", skip: (path) => path.startsWith("pstack/skills/statechart/scripts/test/") },
  { from: "pstack/agents/", to: "pstack/agents/" },
  { from: "pstack/docs/guide/", to: "pstack/docs/guide/", skip: (path) => path.startsWith("pstack/docs/guide/images/") },
  { from: "pstack/README.md", to: "pstack/README.md" },
  { from: "pstack/LICENSE", to: "pstack/LICENSE" },
  { from: "cursor-team-kit/skills/", to: "cursor-team-kit/skills/" },
  { from: "cursor-team-kit/LICENSE", to: "cursor-team-kit/LICENSE" },
];
const output = new Map(); // shipped path -> { bytes, mode, source, changes: Set }
const shippedFrom = new Map(); // upstream path -> shipped path
for (const [path, file] of upstream) {
  const rule = SHIP.find(({ from, skip }) => (from.endsWith("/") ? path.startsWith(from) : path === from) && !skip?.(path));
  if (!rule) continue;
  const target = rule.to + path.slice(rule.from.length);
  output.set(target, { bytes: file.bytes, mode: file.mode, source: path, changes: new Set() });
  shippedFrom.set(path, target);
}
output.set(`pstack/${ADAPTER}`, { bytes: readFileSync(ADAPTER_SOURCE), mode: "644", source: "adapters/pi.md", changes: new Set(["pistack"]) });
shippedFrom.set(`pstack/${ADAPTER}`, `pstack/${ADAPTER}`);

// 3. Classify skills: which Cursor names each one uses (SKILL.md plus its playbooks and references).
const problems = [];
const users = new Map();
const skillRoots = [...output.keys()]
  .filter((path) => /^(pstack|cursor-team-kit)\/skills\/[^/]+\/SKILL\.md$/.test(path))
  .map((path) => dirname(path));
const skillNames = skillRoots.map((root) => root.split("/").at(-1));
for (const root of skillRoots) {
  const name = root.split("/").at(-1);
  const others = skillNames.filter((other) => other !== name).join("|");
  const route = new RegExp(`the \\*\\*(?<bold>${others})\\*\\* skill|\`/(?<command>${others})\``, "g");
  const linksTo = (line, skill) => line.includes(`(../${skill}/`);
  const namesBareSkill = (line) => [...line.matchAll(route)].some(({ groups }) => !linksTo(line, groups.bold ?? groups.command));
  const used = new Set();
  for (const [path, entry] of output) {
    if (!path.startsWith(`${root}/`) || !path.endsWith(".md")) continue;
    const text = entry.bytes.toString("utf8");
    for (const term of TERMS) if (term.re.test(text)) used.add(term.key);
    if (text.split("\n").some(namesBareSkill)) used.add(ROUTE_KEY);
  }
  for (const key of used) users.set(key, [...(users.get(key) ?? []), name]);

  const skillFile = output.get(`${root}/SKILL.md`);
  const text = skillFile.bytes.toString("utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const declared = frontmatter.match(/^name:(.*)$/m)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  if (declared !== name) problems.push(`${root}/SKILL.md declares name ${JSON.stringify(declared ?? "")}, not its folder name`);
  if (!SKILL_NAME.test(name) || name.length > 64) problems.push(`${root} is not a valid Agent Skills name`);
  if (!/^description:/m.test(frontmatter)) problems.push(`${root}/SKILL.md has no description`);
  if (used.size > 0 && root.startsWith("pstack/")) {
    if (!/^# /m.test(text)) problems.push(`${root}/SKILL.md uses Cursor names but has no H1 for the adapter line`);
    else {
      skillFile.bytes = Buffer.from(text.replace(/^(# .*)\n+/m, `$1\n\n${ADAPTER_LINE}\n\n`));
      skillFile.changes.add("adapter line");
    }
  }
}
const adapterText = readFileSync(ADAPTER_SOURCE, "utf8");
for (const [key, using] of users) {
  if (!adapterText.includes(key)) problems.push(`adapters/pi.md has no row for ${key}, used by ${using.join(", ")}`);
}

// 4. Rewrite relative links to upstream files this tree leaves out, then fail on anything dangling.
function resolveLink(fromUpstream, href) {
  const target = href.replace(/[#?].*/, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) return undefined;
  return posix.normalize(posix.join(posix.dirname(fromUpstream), target)).replace(/\/$/, "");
}
const upstreamDirs = new Set([...upstream.keys()].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
const shippedDirs = new Set([...output.keys()].flatMap((path) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
const dangling = [];
for (const [path, entry] of output) {
  if (!path.endsWith(".md")) continue;
  const from = entry.source === "adapters/pi.md" ? `pstack/${ADAPTER}` : entry.source;
  let rewrote = false;
  const text = entry.bytes.toString("utf8").replace(LINK, (link, href) => {
    const target = resolveLink(from, href);
    if (!target) return link;
    const suffix = href.slice(href.search(/[#?]|$/));
    if (shippedFrom.has(target)) return link;
    if (upstreamDirs.has(target)) {
      // A directory link holds if the shipped tree keeps that directory.
      const shippedDir = SHIP.find(({ from: prefix }) => prefix.endsWith("/") && `${target}/`.startsWith(prefix));
      if (shippedDir && shippedDirs.has(shippedDir.to + `${target}/`.slice(shippedDir.from.length).replace(/\/$/, ""))) return link;
      rewrote = true;
      return `](${GITHUB}/tree/${LOCK.commit}/${target}${suffix})`;
    }
    if (upstream.has(target)) {
      rewrote = true;
      return `](${GITHUB}/blob/${LOCK.commit}/${target}${suffix})`;
    }
    // Upstream templates hold placeholder links such as `[PR #123](url)`. Only our own files must resolve.
    if (entry.source === "adapters/pi.md") dangling.push(`${path} links to ${href}, which does not exist`);
    return link;
  });
  if (rewrote) {
    entry.bytes = Buffer.from(text);
    entry.changes.add("external links");
  }
}
problems.push(...dangling);

// 5. A fidelity report so drift from upstream stays visible.
const shipped = [...output.values()].filter((entry) => entry.source !== "adapters/pi.md");
const identical = shipped.filter((entry) => entry.changes.size === 0).length;
const changed = [...output.entries()].filter(([, entry]) => entry.changes.size > 0 && entry.source !== "adapters/pi.md");
const report = [
  "# Upstream fidelity",
  "",
  `Generated by \`scripts/generate.mjs\` from [cursor/plugins@${LOCK.commit.slice(0, 12)}](${GITHUB}/tree/${LOCK.commit}/pstack) (pstack ${LOCK.pstackVersion}). Do not edit.`,
  "",
  `- Shipped upstream files: ${shipped.length}`,
  `- Byte-identical to upstream: ${identical}`,
  `- Changed: ${changed.length} (only the edits listed below; skill prose is never rewritten)`,
  "- Added: `pstack/docs/harness/pi.md` (the pi adapter, from `adapters/pi.md`)",
  "- Left out: `pstack/automations/` (Cursor Automations), `pstack/assets/`, `pstack/docs/guide/images/`, `pstack/docs/harness/claude-code.md`, `pstack/skills/statechart/scripts/test/` (the statechart CLI's own test suite); links to them point at GitHub",
  "",
  "| File | Change |",
  "| --- | --- |",
  ...changed.map(([path, entry]) => `| \`${path}\` | ${[...entry.changes].join(", ")} |`),
  "",
].join("\n");
output.set("docs/fidelity.md", { bytes: Buffer.from(report), mode: "644", source: "generated", changes: new Set(["report"]) });

if (problems.length) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}

// 6. Write (or check) with protection against hand edits to generated files.
const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
const next = {};
const drift = [];
for (const [path, { bytes, mode }] of [...output.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  next[path] = sha256(bytes);
  const target = join(ROOT, path);
  const current = existsSync(target) ? readFileSync(target) : undefined;
  const modeOk = current ? ((statSync(target).mode & 0o111) !== 0) === (mode === "755") : false;
  if (current?.equals(bytes) && modeOk) continue;
  if (CHECK) {
    drift.push(path);
    continue;
  }
  if (current && previous[path] && sha256(current) !== previous[path]) {
    throw new Error(`Refusing to overwrite hand-edited generated file ${path}. Move the change into adapters/ or scripts/generate.mjs.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  chmodSync(target, mode === "755" ? 0o755 : 0o644);
}
for (const path of Object.keys(previous)) {
  if (output.has(path)) continue;
  const target = join(ROOT, path);
  if (!existsSync(target)) continue;
  if (CHECK) {
    drift.push(`${path} (stale)`);
    continue;
  }
  if (sha256(readFileSync(target)) !== previous[path]) throw new Error(`Refusing to remove hand-edited retired file ${path}.`);
  unlinkSync(target);
}
if (CHECK) {
  if (!existsSync(MANIFEST) || JSON.stringify(previous) !== JSON.stringify(next)) drift.push(".generated-files.json");
  if (drift.length) {
    for (const path of drift.slice(0, 30)) console.error(`DRIFT ${path}`);
    console.error("Generated files are out of date. Run `npm run generate` and commit the result.");
    process.exit(1);
  }
  console.log(`Generated tree is up to date (${output.size} files, pstack ${LOCK.pstackVersion}).`);
} else {
  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
  for (const dir of ["pstack", "cursor-team-kit"]) pruneEmptyDirs(join(ROOT, dir));
  const wrapped = [...output.values()].filter((entry) => entry.changes.has("adapter line")).length;
  console.log(`Generated ${skillRoots.length} skills (${wrapped} with the adapter line), ${output.size} files, pstack ${LOCK.pstackVersion}.`);
}

function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pruneEmptyDirs(path);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}
