// `pistack_sessions`: the counterpart of Cursor's `agent-transcripts/`, scoped to this workspace.
// pi sessions are trees, so a transcript is the active branch walked from its leaf, not file order.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentManager } from "../agents/manager.ts";
import { gitRoot } from "../agents/worktree.ts";
import { configDir, isInside } from "../paths.ts";

type Entry = { type?: string; id?: string; parentId?: string | null; [key: string]: any };

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT = 60_000;

export function workspaceSessionDir(ctx: ExtensionContext): string {
  const file = ctx.sessionManager.getSessionFile();
  return file ? dirname(file) : ctx.sessionManager.getSessionDir();
}

function readHeader(file: string): Entry | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0]);
    return header?.type === "session" ? header : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Walk parentId links from the leaf (the last entry written) back to the root. */
export function activeBranch(entries: readonly Entry[]): Entry[] {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const leaf = [...entries].reverse().find((entry) => entry.id);
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = leaf?.id;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function collapseSkills(text: string): string {
  return text.replace(/<skill name="([^"]+)" location="[^"]*">[\s\S]*?<\/skill>/g, "[skill $1 loaded]");
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length - max} more chars)` : flat;
}

export function renderEntry(entry: Entry, includeToolResults: boolean): string | undefined {
  if (entry.type === "message") {
    const message = entry.message ?? {};
    if (message.role === "user") return `[user] ${clip(collapseSkills(textParts(message.content)), 4_000)}`;
    if (message.role === "assistant") {
      const lines: string[] = [];
      const text = textParts(message.content);
      if (text) lines.push(`[assistant] ${clip(text, 6_000)}`);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall") lines.push(`[tool call] ${part.name}(${clip(JSON.stringify(part.arguments ?? {}), 300)})`);
      }
      return lines.join("\n") || undefined;
    }
    if (message.role === "toolResult") {
      const text = textParts(message.content);
      const label = `[tool result${message.isError ? " error" : ""}: ${message.toolName}]`;
      return includeToolResults ? `${label} ${clip(text, 600)}` : `${label} (${text.length} chars)`;
    }
    return undefined;
  }
  if (entry.type === "custom_message") return `[${entry.customType}] ${clip(textParts(entry.content), 2_000)}`;
  if (entry.type === "compaction") return `[compaction summary] ${clip(String(entry.summary ?? ""), 3_000)}`;
  if (entry.type === "branch_summary") return `[branch summary] ${clip(String(entry.summary ?? ""), 2_000)}`;
  if (entry.type === "model_change") return `[model → ${entry.provider}/${entry.modelId}]`;
  return undefined;
}

export function renderTranscript(entries: readonly Entry[], options: { limit: number; includeToolResults: boolean }): string {
  const rendered = entries.map((entry) => renderEntry(entry, options.includeToolResults)).filter((line): line is string => Boolean(line));
  const tail = rendered.slice(-options.limit);
  let text = tail.join("\n\n");
  if (rendered.length > tail.length) text = `(${rendered.length - tail.length} earlier entries omitted; raise limit to see them)\n\n${text}`;
  if (text.length > MAX_OUTPUT) text = `(start truncated)\n…${text.slice(-MAX_OUTPUT)}`;
  return text;
}

function allowedToRead(file: string, ctx: ExtensionContext): boolean {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  if (!real.endsWith(".jsonl")) return false;
  const header = readHeader(real);
  if (!header || typeof header.cwd !== "string") return false;
  const workspace = gitRoot(ctx.cwd) ?? ctx.cwd;
  const inWorkspaceDir = isInside(real, realpathSync(workspaceSessionDir(ctx)));
  const inAgentDir = existsSync(join(configDir(), "agents")) && isInside(real, realpathSync(join(configDir(), "agents")));
  return (inWorkspaceDir || inAgentDir) && (isInside(header.cwd, workspace) || isInside(header.cwd, ctx.cwd));
}

export function registerSessionsTool(pi: ExtensionAPI, manager: AgentManager): void {
  pi.registerTool({
    name: "pistack_sessions",
    label: "pistack sessions",
    description:
      "Read pi session transcripts for this workspace (Cursor's agent-transcripts). `current` names the current session file and its subagent transcripts; `list` shows this workspace's sessions, newest first; `read` renders a session's active branch. Never reads other workspaces.",
    promptSnippet: "List and read this workspace's pi session transcripts (Cursor's agent-transcripts)",
    parameters: Type.Object(
      {
        action: StringEnum(["current", "list", "read"] as const),
        file: Type.Optional(Type.String({ description: "Session file for `read`. Default: the current session." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000, description: "Entries (`read`) or sessions (`list`) to return. Default: 80 / 20." })),
        include_tool_results: Type.Optional(Type.Boolean({ description: "Include tool output excerpts in `read`. Default: false." })),
      },
      { additionalProperties: false },
    ),
    namespace: { name: "pistack", description: "pstack workflows for pi: subagents, questions, todos, sessions, and loops." },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    defaultActive: false,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = ctx.sessionManager.getSessionFile();
      if (params.action === "current") {
        const children = [...manager.records.values()].map((record) => ({
          id: record.id,
          description: record.description,
          status: record.status,
          transcript: record.sessionFile,
        }));
        const lines = [
          `Current session: ${current ?? "(not persisted: started with --no-session)"}`,
          `Workspace sessions: ${workspaceSessionDir(ctx)}`,
          `Entries on the active branch: ${ctx.sessionManager.getBranch().length}`,
          children.length ? "Subagent transcripts:" : "No subagent transcripts yet.",
          ...children.map((child) => `- ${child.id} (${child.status}) ${child.description}: ${child.transcript ?? "(no transcript yet)"}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }], details: { current, children } as unknown as Record<string, unknown> };
      }
      if (params.action === "list") {
        const dir = workspaceSessionDir(ctx);
        const files = existsSync(dir)
          ? readdirSync(dir)
              .filter((name) => name.endsWith(".jsonl"))
              .map((name) => join(dir, name))
              .filter((file) => {
                const header = readHeader(file);
                return header && typeof header.cwd === "string" && isInside(header.cwd, ctx.cwd);
              })
              .map((file) => ({ file, modified: statSync(file).mtimeMs }))
              .sort((a, b) => b.modified - a.modified)
              .slice(0, params.limit ?? 20)
          : [];
        const text = files.length
          ? files.map(({ file, modified }) => `${new Date(modified).toISOString()}  ${file}${file === current ? "  (current)" : ""}`).join("\n")
          : `No sessions found in ${dir}.`;
        return { content: [{ type: "text", text }], details: { files } as unknown as Record<string, unknown> };
      }
      const file = params.file ?? current;
      if (!file) throw new Error("This session is not persisted. Pass `file`.");
      if (!allowedToRead(file, ctx)) throw new Error(`${file} is not a session of this workspace. Use pistack_sessions list.`);
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`${file} is larger than 64 MiB. Read a slice of it with read and offset/limit.`);
      const entries: Entry[] = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as Entry;
          } catch {
            return {} as Entry;
          }
        });
      const header = entries[0]?.type === "session" ? entries.shift() : undefined;
      const text = renderTranscript(activeBranch(entries), { limit: params.limit ?? 80, includeToolResults: params.include_tool_results ?? false });
      return {
        content: [{ type: "text", text: `Session ${file}${header?.cwd ? ` (cwd ${header.cwd})` : ""}\n\n${text}` }],
        details: { file } as unknown as Record<string, unknown>,
      };
    },
  });
}
