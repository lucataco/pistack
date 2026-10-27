// What a pistack subagent is launched with: its instructions, tools, CLI arguments, and environment.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ADAPTER_PATH, AGENTS_DIR, PACKAGE_ROOT, POTETO_SKILL, PSTACK_DIR, isInside } from "../paths.ts";
import type { Worktree } from "./worktree.ts";

export const GENERAL_PURPOSE = "general-purpose";

export interface AgentDefinition {
  name: string;
  description: string;
  body: string;
  path?: string;
}

/** `general-purpose` plus every agent shipped in `<pstack>/agents/`. */
export function loadAgentDefinitions(dir = AGENTS_DIR): Map<string, AgentDefinition> {
  const definitions = new Map<string, AgentDefinition>([
    [GENERAL_PURPOSE, { name: GENERAL_PURPOSE, description: "A general-purpose delegate with the parent's tools.", body: "" }],
  ]);
  if (!existsSync(dir)) return definitions;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const frontmatter = match?.[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1].trim().replace(/^["']|["']$/g, "") ?? file.slice(0, -3);
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1].trim() ?? "";
    definitions.set(name, { name, description, body: (match?.[2] ?? text).trim(), path });
  }
  return definitions;
}

export interface ChildPromptInput {
  id: string;
  definition: AgentDefinition;
  depth: number;
  maxDepth: number;
  readonly: boolean;
  background: boolean;
  worktree?: Worktree;
}

export function childSystemPrompt(input: ChildPromptInput): string {
  const { id, definition, depth, maxDepth, worktree } = input;
  const lines = [
    "# pistack subagent",
    "",
    `You are a pistack subagent (agent ${id}, type \`${definition.name}\`, depth ${depth} of ${maxDepth}) spawned by a parent pi session.`,
    "- Work only on the brief in the user message. The parent sees only your final message, so end with a complete, self-contained report: what you did, what you found, and how you verified it.",
    "- You cannot ask the user anything, and `pistack_ask` is unavailable. When blocked, stop and state exactly what you need.",
    `- pstack is installed at \`${PSTACK_DIR}\` (\`<pstack>\`). Skills live at \`<pstack>/skills/<name>/SKILL.md\`. pstack skills use Cursor names, so read the pi adapter at \`${ADAPTER_PATH}\` before you follow one.`,
  ];
  if (definition.name === "poteto-agent") lines.push(`- The absolute path of the poteto-mode skill is \`${POTETO_SKILL}\`.`);
  if (input.readonly) {
    lines.push("- Read-only: do not create, edit, move, or delete files, and do not change git state. pistack blocks file-changing tools and commands. Report findings only.");
  }
  if (worktree) {
    lines.push(
      `- You are in an isolated git worktree at \`${worktree.path}\` on branch \`${worktree.branch}\`, created from ${worktree.baseRef ? `\`${worktree.baseRef}\` (${worktree.base.slice(0, 12)})` : worktree.base.slice(0, 12)}. Commit there when the brief asks for commits. Never push unless the brief says to.`,
    );
  }
  if (input.background) lines.push("- You run in the background. The parent keeps working and receives your final message when you finish.");
  if (definition.body) lines.push("", definition.body);
  return `${lines.join("\n")}\n`;
}

export function childBrief(prompt: string, files: readonly string[] | undefined, cwd: string): string {
  if (!files?.length) return prompt;
  const list = files.map((file) => `- ${isAbsolute(file) ? file : resolve(cwd, file)}`).join("\n");
  return `${prompt}\n\nAttached files (read them as part of the brief):\n${list}`;
}

const WRITE_TOOLS = ["edit", "write"];
const READ_TOOLS = ["read", "grep", "find", "ls", "bash"];
/** Tools only the root session can use: children cannot ask the user or arm loops. */
const PARENT_ONLY = ["pistack_ask", "pistack_loop"];
const SPAWN_TOOLS = ["pistack_agent", "pistack_agents"];
const CHILD_PISTACK_TOOLS = ["pistack_todo", "pistack_sessions"];

export interface ChildToolOptions {
  readonly: boolean;
  canSpawn: boolean;
  /** Tools annotated `readOnlyHint: true`, which a read-only child keeps. */
  isReadOnlyTool?: (name: string) => boolean;
}

/**
 * A child inherits the parent's active tools (MCP and extension tools included), minus what its role
 * forbids. A read-only child keeps only the read tools and tools annotated read-only, as Cursor's
 * `readonly` subagents lose MCP access.
 */
export function childTools(parentActive: readonly string[], options: ChildToolOptions): string[] {
  const tools = new Set(parentActive.filter((name) => !PARENT_ONLY.includes(name) && !SPAWN_TOOLS.includes(name)));
  tools.add("read");
  tools.add("bash");
  if (options.readonly) {
    for (const name of [...tools]) {
      if (!READ_TOOLS.includes(name) && !CHILD_PISTACK_TOOLS.includes(name) && !options.isReadOnlyTool?.(name)) tools.delete(name);
    }
    for (const name of WRITE_TOOLS) tools.delete(name);
    for (const name of READ_TOOLS) tools.add(name);
  } else {
    for (const name of WRITE_TOOLS) tools.add(name);
  }
  for (const name of CHILD_PISTACK_TOOLS) tools.add(name);
  if (options.canSpawn && !options.readonly) for (const name of SPAWN_TOOLS) tools.add(name);
  return [...tools];
}

const VALUE_FLAGS = new Set(["-e", "--extension", "--skill"]);
const BARE_FLAGS = new Set(["-ne", "--no-extensions", "--no-mcp", "--offline", "-ns", "--no-skills", "-nc", "--no-context-files"]);

/**
 * Resource flags the parent was started with, so a child loads the same extensions and skills.
 * Relative paths are made absolute because a child may run in a worktree.
 */
export function passthroughArgs(argv: readonly string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) break;
      const absolute = /^[a-z]+:/i.test(value) || isAbsolute(value) ? value : resolve(cwd, value);
      out.push(flag, absolute);
    } else if (BARE_FLAGS.has(arg)) {
      out.push(arg);
    }
  }
  return out;
}

/** True when the parent loaded pistack itself through `-e`, so children receive it through passthrough. */
export function loadsPistackExplicitly(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-e" || args[i] === "--extension") && args[i + 1] && isInside(args[i + 1], PACKAGE_ROOT)) return true;
  }
  return false;
}

export interface ChildArgsInput {
  sessionDir: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  tools: readonly string[];
  systemPromptFile: string;
  passthrough: readonly string[];
  trusted: boolean;
  /** The first user message. Starts with a header, so it never reads as a flag or an `@file`. */
  prompt: string;
  /** A brief too large for the command line, included with pi's `@file` syntax. */
  briefFile?: string;
}

/** Briefs above this size go through a file: argv and environment share one OS limit. */
export const MAX_INLINE_BRIEF_BYTES = 128 * 1024;

export function childArgs(input: ChildArgsInput): string[] {
  const args = ["--mode", "json", "-p", "--session-dir", input.sessionDir, "--session-id", input.sessionId];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  args.push("--tools", input.tools.join(","));
  args.push("--append-system-prompt", input.systemPromptFile);
  args.push(...input.passthrough);
  args.push(input.trusted ? "--approve" : "--no-approve");
  args.push("--");
  if (input.briefFile) args.push(`@${input.briefFile}`);
  args.push(input.prompt);
  return args;
}
