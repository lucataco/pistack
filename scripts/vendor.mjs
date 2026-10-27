#!/usr/bin/env node
// Snapshot upstream cursor/plugins at a pinned commit into .upstream/ (gitignored)
// and record every vendored file's sha256 in upstream.lock.json.
//
//   node scripts/vendor.mjs                      # re-vendor the commit pinned in upstream.lock.json
//   node scripts/vendor.mjs --commit <sha>       # bump the pin
//   node scripts/vendor.mjs --clone <path>       # read objects from a local clone instead of GitHub
//
// The snapshot is the generator's only input. Never edit it; change scripts/generate.mjs or adapters/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".upstream");
const LOCK = join(ROOT, "upstream.lock.json");
const REPOSITORY = "https://github.com/cursor/plugins";
export const VENDORED_PATHS = [
  "pstack",
  "cursor-team-kit/LICENSE",
  "cursor-team-kit/skills/deslop",
  "cursor-team-kit/skills/control-ui",
  "cursor-team-kit/skills/control-cli",
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024, ...options });
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const previous = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : undefined;
const commit = arg("--commit") ?? previous?.commit;
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("Pass --commit <40-char sha>, or keep a valid commit in upstream.lock.json.");
  process.exit(1);
}

let clone = arg("--clone");
let scratch;
if (!clone) {
  scratch = mkdtempSync(join(tmpdir(), "pistack-vendor-"));
  git(scratch, ["init", "--quiet"]);
  git(scratch, ["remote", "add", "origin", `${REPOSITORY}.git`]);
  git(scratch, ["fetch", "--quiet", "--depth", "1", "origin", commit]);
  clone = scratch;
} else {
  clone = resolve(clone);
  try {
    git(clone, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    git(clone, ["fetch", "--quiet", "origin", commit]);
  }
}

try {
  rmSync(CACHE, { recursive: true, force: true });
  mkdirSync(CACHE, { recursive: true });
  const archive = git(clone, ["archive", "--format=tar", commit, "--", ...VENDORED_PATHS]);
  execFileSync("tar", ["-x", "-C", CACHE], { input: archive, maxBuffer: 512 * 1024 * 1024 });
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

const files = walk(CACHE)
  .map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(CACHE, path).split("\\").join("/"),
      mode: statSync(path).mode & 0o111 ? "755" : "644",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

const pstackVersion = JSON.parse(readFileSync(join(CACHE, "pstack/.cursor-plugin/plugin.json"), "utf8")).version;
const lock = { schemaVersion: 1, repository: REPOSITORY, commit, pstackVersion, files };
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Vendored ${files.length} files from cursor/plugins@${commit.slice(0, 12)} (pstack ${pstackVersion}).`);
