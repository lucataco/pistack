// Git worktree isolation for subagents: pi's stand-in for Cursor's `environment: "cloud"`.
// A worktree is a separate checkout, not a VM or a sandbox.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  /** Commit the worktree started from. */
  base: string;
  /** The ref the caller named, if any. */
  baseRef?: string;
}

export interface WorktreeOutcome {
  kept: boolean;
  dirty: number;
  commits: number;
  summary: string;
}

function git(cwd: string, args: string[], input?: string): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    const reason = (run.stderr || run.error?.message || "").trim().slice(0, 600);
    throw new Error(`git ${args.join(" ").slice(0, 160)} failed: ${reason}`);
  }
  return run.stdout.trim();
}

export function gitRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

export function planWorktree(cwd: string, id: string, baseRef?: string): Worktree {
  const repo = gitRoot(cwd);
  if (!repo) throw new Error(`isolation: "worktree" needs a git repository, and ${cwd} is not inside one.`);
  const base = git(repo, ["rev-parse", "--verify", `${baseRef ?? "HEAD"}^{commit}`]);
  return { repo, path: join(repo, ".pi", "worktrees", id), branch: `pistack/${id}`, base, baseRef };
}

/** True when a new agent cannot use this plan: its path or branch is left over from an earlier agent. */
export function worktreeTaken(worktree: Worktree): boolean {
  return existsSync(worktree.path) || git(worktree.repo, ["branch", "--list", worktree.branch]) !== "";
}

/** Keep `.pi/worktrees/` out of the parent checkout's `git status` without touching tracked files. */
function excludeWorktreeDir(repo: string): void {
  let common = git(repo, ["rev-parse", "--git-common-dir"]);
  if (!isAbsolute(common)) common = resolve(repo, common);
  const exclude = join(common, "info", "exclude");
  const line = "/.pi/worktrees/";
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/** Create the worktree, or re-create it from its branch when resuming after it was removed. */
export function ensureWorktree(worktree: Worktree): void {
  if (existsSync(worktree.path)) return;
  excludeWorktreeDir(worktree.repo);
  mkdirSync(dirname(worktree.path), { recursive: true });
  const branchExists = git(worktree.repo, ["branch", "--list", worktree.branch]) !== "";
  git(
    worktree.repo,
    branchExists
      ? ["worktree", "add", worktree.path, worktree.branch]
      : ["worktree", "add", "-b", worktree.branch, worktree.path, worktree.base],
  );
}

export function inspectWorktree(worktree: Worktree): { dirty: number; commits: number } {
  if (!existsSync(worktree.path)) return { dirty: 0, commits: 0 };
  const status = git(worktree.path, ["status", "--porcelain"]);
  const dirty = status ? status.split("\n").length : 0;
  const commits = Number(git(worktree.path, ["rev-list", "--count", `${worktree.base}..HEAD`])) || 0;
  return { dirty, commits };
}

/** Remove a worktree the agent left untouched; keep anything with changes or commits. */
export function settleWorktree(worktree: Worktree): WorktreeOutcome {
  if (!existsSync(worktree.path)) return { kept: false, dirty: 0, commits: 0, summary: "worktree already removed" };
  const { dirty, commits } = inspectWorktree(worktree);
  if (dirty === 0 && commits === 0) {
    git(worktree.repo, ["worktree", "remove", worktree.path]);
    try {
      git(worktree.repo, ["branch", "-D", worktree.branch]);
    } catch {
      // The branch may be checked out elsewhere; leaving it is harmless.
    }
    return { kept: false, dirty, commits, summary: "no changes, so the worktree and its branch were removed" };
  }
  const parts = [];
  if (commits) parts.push(`${commits} commit${commits === 1 ? "" : "s"} on ${worktree.branch}`);
  if (dirty) parts.push(`${dirty} uncommitted change${dirty === 1 ? "" : "s"}`);
  return { kept: true, dirty, commits, summary: `kept: ${parts.join(", ")}` };
}

/** Remove a finished agent's worktree when it has no uncommitted changes. Its branch, and any commits, stay. */
export function removeCleanWorktree(worktree: Worktree): string {
  if (!existsSync(worktree.path)) return `${worktree.path}: already removed`;
  const { dirty, commits } = inspectWorktree(worktree);
  if (dirty > 0) return `${worktree.path}: kept, ${dirty} uncommitted change${dirty === 1 ? "" : "s"}`;
  git(worktree.repo, ["worktree", "remove", worktree.path]);
  if (commits === 0) {
    try {
      git(worktree.repo, ["branch", "-D", worktree.branch]);
    } catch {
      // Leave a branch that cannot be deleted.
    }
    return `${worktree.path}: removed with its branch`;
  }
  return `${worktree.path}: removed; branch ${worktree.branch} keeps ${commits} commit${commits === 1 ? "" : "s"}`;
}
