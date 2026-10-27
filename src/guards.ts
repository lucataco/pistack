// Mechanical checks behind two pstack rules: read-only subagents stay read-only, and a reply cites
// only principles whose leaf skill was read this session.

import { join } from "node:path";
import { SKILLS_DIR } from "./paths.ts";
import { citedPrinciples } from "./state.ts";

const MUTATING_PROGRAMS = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln", "truncate", "dd", "tee",
  "install", "patch", "unlink", "shred", "rsync",
]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "nice", "exec", "xargs"]);
const GIT_MUTATING = new Set([
  "add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "restore", "cherry-pick", "revert",
  "apply", "am", "clean", "rm", "mv", "init", "clone", "gc", "prune", "update-ref", "notes", "submodule", "filter-branch",
]);
const PACKAGE_MUTATING = new Set(["i", "install", "add", "remove", "rm", "uninstall", "update", "upgrade", "up", "publish", "link", "unlink", "ci", "prune", "dedupe"]);

/**
 * Why a shell command would change files, git state, packages, or remote state, or undefined when
 * it looks read-only. A best-effort guard for read-only subagents, not a sandbox.
 */
export function mutatingCommand(command: string): string | undefined {
  const cleaned = command
    .replace(/\d?>&\d/g, " ")
    .replace(/&?\d?>{1,2}\s*\/dev\/(null|stdout|stderr|tty)\b/g, " ");
  if (/(^|[^<>&\d=-])\d?>{1,2}\s*[^\s&|>]/.test(cleaned)) return "writes a file through a shell redirect";
  for (const segment of cleaned.split(/&&|\|\||[;|\n]|\$\(|`/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPERS.has(words[0]) || /^-/.test(words[0]))) words.shift();
    if (!words.length) continue;
    const program = words[0].split("/").pop()!;
    const sub = words[1];
    if (MUTATING_PROGRAMS.has(program)) return `runs ${program}`;
    if (program === "sed" && words.some((word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith("--in-place"))) return "edits a file in place with sed";
    if (program === "perl" && words.some((word) => /^-[a-zA-Z]*i/.test(word))) return "edits a file in place with perl";
    if (program === "git" && sub) {
      if (GIT_MUTATING.has(sub)) return `runs git ${sub}`;
      if (sub === "stash" && !["list", "show"].includes(words[2] ?? "")) return "runs git stash";
      if (sub === "worktree" && ["add", "remove", "move", "prune"].includes(words[2] ?? "")) return `runs git worktree ${words[2]}`;
      if (sub === "branch" && words.slice(2).some((word) => /^-[dDmMcC]$/.test(word) || /^--(delete|move|copy|force|set-upstream-to|unset-upstream)/.test(word))) {
        return "changes branches";
      }
      if (sub === "tag" && words.slice(2).some((word) => !word.startsWith("-") || /^-[adfs]$/.test(word))) return "creates or deletes a tag";
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(program) && sub && PACKAGE_MUTATING.has(sub)) return `runs ${program} ${sub}`;
    if (["pip", "pip3", "uv"].includes(program) && ["install", "uninstall", "add", "remove", "sync"].includes(sub ?? "")) return `runs ${program} ${sub}`;
    if (program === "brew" && ["install", "uninstall", "upgrade", "remove", "reinstall"].includes(sub ?? "")) return `runs brew ${sub}`;
    if (program === "gh") {
      const action = words[2] ?? "";
      if (["pr", "issue"].includes(sub ?? "") && ["create", "merge", "close", "comment", "edit", "review", "ready", "reopen", "delete", "lock"].includes(action)) return `runs gh ${sub} ${action}`;
      if (["release", "repo", "secret", "variable", "workflow", "label"].includes(sub ?? "") && !["list", "view", "status"].includes(action)) return `runs gh ${sub} ${action}`;
      if (sub === "api" && words.some((word, i) => (word === "-X" || word === "--method") && !/^get$/i.test(words[i + 1] ?? ""))) return "calls gh api with a write method";
    }
    if (program === "curl" && words.some((word, i) => ((word === "-X" || word === "--request") && !/^(get|head)$/i.test(words[i + 1] ?? "")) || /^(-d|--data.*|-F|--form|-T|--upload-file)$/.test(word))) {
      return "sends data with curl";
    }
  }
  return undefined;
}

/** Principles a reply cites without their leaf skill having been read. */
export function unreadCitations(text: string, read: readonly string[], slugs: readonly string[]): string[] {
  return citedPrinciples(text, slugs).filter((slug) => !read.includes(slug));
}

export function citationNudge(unread: readonly string[]): string {
  const paths = unread.map((slug) => `- \`${join(SKILLS_DIR, `principle-${slug}`, "SKILL.md")}\``).join("\n");
  return [
    `pistack check: your reply cites ${unread.map((slug) => `\`${slug}\``).join(", ")}, but this session has not read ${unread.length === 1 ? "that principle's leaf skill" : "those principles' leaf skills"}. poteto-mode cites only principles whose leaf skill was read this session.`,
    `Read ${unread.length === 1 ? "it" : "them"} now:`,
    paths,
    "Then keep or correct the citation in one short follow-up. Do not redo the work.",
  ].join("\n");
}
