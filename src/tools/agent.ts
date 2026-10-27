// `pistack_agent` (Cursor's `Task`) and `pistack_agents` (list, wait, stop, clean up).

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { AgentManager, agentReport, agentSummaryLine, type AgentRecord, type StartRequest } from "../agents/manager.ts";
import { emptyUsage, toUsage, type UsageTotals } from "../agents/spawn.ts";
import { THINKING_LEVELS, type Thinking } from "../models.ts";

const NAMESPACE = {
  name: "pistack",
  description: "pstack workflows for pi: subagents, questions, todos, sessions, and loops.",
};

const AgentParams = Type.Object(
  {
    description: Type.String({ description: "Short label for the task, three to eight words." }),
    prompt: Type.String({
      description:
        "The complete brief: goal, context, constraints, done criteria, and what to report. The child sees nothing else from this conversation.",
    }),
    subagent_type: Type.Optional(
      Type.String({ description: "`general-purpose` (default), `poteto-agent`, or `comment-sicko`. Cursor's `generalPurpose` also works." }),
    ),
    readonly: Type.Optional(Type.Boolean({ description: "Read-only child: no file edits and no file-changing shell commands." })),
    isolation: Type.Optional(StringEnum(["worktree"] as const, { description: "Run in a new git worktree on branch `pistack/<id>`. Cursor's `environment: \"cloud\"`." })),
    base: Type.Optional(Type.String({ description: "Branch, tag, or commit the worktree starts from. Default: HEAD. Cursor's `cloud_base_branch`." })),
    background: Type.Optional(
      Type.Boolean({ description: "Return an agent id at once. The completion arrives later as a message, so do not poll. Cursor's `run_in_background`." }),
    ),
    resume: Type.Optional(Type.String({ description: "Id of a finished agent to continue, with `prompt` as the follow-up." })),
    files: Type.Optional(Type.Array(Type.String(), { description: "Paths the child should read. Cursor's `file_attachments`." })),
    model: Type.Optional(Type.String({ description: "pi model `[provider/]id[:thinking]`, a Cursor slug such as `claude-opus-5-5-xhigh`, or `inherit-parent`." })),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level; overrides one from `model` or `role`." })),
    role: Type.Optional(Type.String({ description: "A role from the model rule, such as `how explorer`. Used when `model` is not set." })),
    seat: Type.Optional(Type.Integer({ minimum: 0, description: "Which entry of a panel role to use, from 0." })),
    timeout_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Stop the child after this long. Default: 60." })),
  },
  { additionalProperties: false },
);
type AgentArgs = Static<typeof AgentParams>;

const AgentOutput = Type.Object({
  id: Type.String(),
  status: Type.String(),
  reply: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  transcript: Type.Optional(Type.String()),
  worktree: Type.Optional(Type.Object({ path: Type.String(), branch: Type.String(), kept: Type.Optional(Type.Boolean()) })),
  error: Type.Optional(Type.String()),
});

const KNOWN_KEYS = new Set(Object.keys(AgentParams.properties));

/** Accept Cursor's `Task` field names so upstream-style calls work unchanged. */
export function prepareAgentArgs(raw: unknown): AgentArgs {
  if (!raw || typeof raw !== "object") return raw as AgentArgs;
  const args: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const alias = (from: string, to: string, map: (value: unknown) => unknown = (value) => value) => {
    if (args[from] !== undefined && args[to] === undefined) args[to] = map(args[from]);
    delete args[from];
  };
  alias("run_in_background", "background");
  alias("cloud_base_branch", "base");
  alias("file_attachments", "files");
  alias("timeout", "timeout_minutes");
  if (args.environment === "cloud" && args.isolation === undefined) args.isolation = "worktree";
  delete args.environment;
  for (const key of ["readonly", "background"]) {
    if (typeof args[key] === "string") args[key] = args[key] === "true";
  }
  for (const key of Object.keys(args)) if (!KNOWN_KEYS.has(key)) delete args[key];
  return args as AgentArgs;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** structuredContent must be JSON: drop undefined fields. */
function json(value: Record<string, unknown>): { [key: string]: Json } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: Json };
}

function subtract(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    totalTokens: after.totalTokens - before.totalTokens,
    cost: after.cost - before.cost,
  };
}

function statusColor(status: string): "success" | "error" | "warning" | "accent" {
  if (status === "done") return "success";
  if (status === "failed" || status === "timeout") return "error";
  if (status === "aborted") return "warning";
  return "accent";
}

function renderRecord(record: AgentRecord | undefined, expanded: boolean, theme: Theme): Text {
  if (!record) return new Text("", 0, 0);
  let text = theme.fg(statusColor(record.status), agentSummaryLine(record));
  if (record.lastTool) text += `\n${theme.fg("muted", `→ ${record.lastTool}`)}`;
  if (record.worktree) text += `\n${theme.fg("dim", `worktree ${record.worktree.path}${record.worktree.summary ? `: ${record.worktree.summary}` : ""}`)}`;
  if (record.error) text += `\n${theme.fg("error", record.error.split("\n")[0])}`;
  const reply = record.finalText?.trim();
  if (reply) {
    const lines = reply.split("\n");
    const shown = expanded ? lines : lines.slice(0, 4);
    text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
    if (!expanded && lines.length > shown.length) text += `\n${theme.fg("dim", `… ${lines.length - shown.length} more lines`)}`;
  }
  return new Text(text, 0, 0);
}

export function registerAgentTools(pi: ExtensionAPI, manager: AgentManager): void {
  pi.registerTool({
    name: "pistack_agent",
    label: "pistack agent",
    description:
      "Run a pstack subagent: a separate pi process with its own context window (Cursor's `Task`). Returns the child's final reply, or an agent id at once with `background: true`. Supports read-only children, git worktree isolation, per-role models from the pstack model rule, and resuming a finished agent.",
    promptSnippet: "Delegate a task to a pstack subagent (Cursor's Task), optionally read-only, in a worktree, or in the background",
    promptGuidelines: [
      "Use pistack_agent wherever a pstack skill says to spawn a `Task` subagent. Write a complete brief: the child sees nothing else from this conversation.",
      "Background pistack_agent completions arrive as messages that wake you. Do not poll or sleep for them.",
    ],
    parameters: AgentParams,
    outputSchema: AgentOutput,
    namespace: NAMESPACE,
    defaultActive: false,
    prepareArguments: prepareAgentArgs,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request: StartRequest = {
        description: params.description,
        prompt: params.prompt,
        subagentType: params.subagent_type,
        readonly: params.readonly,
        isolation: params.isolation,
        base: params.base,
        background: params.background,
        resume: params.resume,
        files: params.files,
        model: params.model,
        thinking: params.thinking as Thinking | undefined,
        role: params.role,
        seat: params.seat,
        timeoutMinutes: params.timeout_minutes,
      };
      const before = params.resume ? { ...(manager.records.get(params.resume)?.usage ?? emptyUsage()) } : emptyUsage();
      if (params.background) {
        const record = await manager.start(request, ctx, signal);
        return {
          content: [
            {
              type: "text",
              text: `Started background agent ${record.id} (${record.subagentType}${record.readonly ? ", read-only" : ""}) on ${record.model ?? "the parent model"}${record.worktree ? ` in worktree ${record.worktree.path}` : ""}. Its completion arrives as a message; do not poll. pistack_agents can list, wait for, or stop it.${record.modelNote ? ` Note: ${record.modelNote}` : ""}`,
            },
          ],
          details: record as unknown as Record<string, unknown>,
          structuredContent: json({ id: record.id, status: record.status, model: record.model }),
        };
      }
      let last = 0;
      const record = await manager.start(request, ctx, signal, (progress) => {
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        onUpdate?.({ content: [{ type: "text", text: agentSummaryLine(progress) }], details: { ...progress } as unknown as Record<string, unknown> });
      });
      const failed = record.status !== "done";
      return {
        content: [{ type: "text", text: agentReport(record) }],
        details: record as unknown as Record<string, unknown>,
        usage: toUsage(subtract(record.usage, before)),
        isError: failed,
        structuredContent: json({
          id: record.id,
          status: record.status,
          reply: record.finalText,
          model: record.model,
          transcript: record.sessionFile,
          worktree: record.worktree ? { path: record.worktree.path, branch: record.worktree.branch, kept: record.worktree.kept } : undefined,
          error: record.error,
        }),
      };
    },
    renderCall(args, theme) {
      const flags = [args.readonly ? "read-only" : "", args.isolation ? "worktree" : "", args.background ? "background" : "", args.resume ? `resume ${args.resume}` : ""]
        .filter(Boolean)
        .join(", ");
      const text =
        theme.fg("toolTitle", theme.bold("agent ")) +
        theme.fg("accent", args.subagent_type ?? "general-purpose") +
        ` ${theme.fg("muted", args.description ?? "")}` +
        (flags ? theme.fg("dim", ` (${flags})`) : "");
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderRecord(result.details as unknown as AgentRecord | undefined, expanded, theme);
    },
  });

  pi.registerTool({
    name: "pistack_agents",
    label: "pistack agents",
    description:
      "Manage this session's pstack subagents. `list` shows them, `wait` blocks until the given (or all background) agents finish, `stop` aborts agents, and `cleanup` removes finished agents' worktrees that have no uncommitted changes (branches and commits stay).",
    promptSnippet: "List, wait for, stop, or clean up pstack subagents",
    parameters: Type.Object(
      {
        action: StringEnum(["list", "wait", "stop", "cleanup"] as const),
        ids: Type.Optional(Type.Array(Type.String(), { description: "Agent ids. `wait` defaults to every running background agent; `stop` requires ids." })),
        timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86_400, description: "How long `wait` blocks. Default: 600." })),
      },
      { additionalProperties: false },
    ),
    namespace: NAMESPACE,
    defaultActive: false,
    async execute(_toolCallId, params, signal) {
      switch (params.action) {
        case "list": {
          const records = [...manager.records.values()].sort((a, b) => b.startedAt - a.startedAt);
          const text = records.length
            ? records
                .map((record) => `${agentSummaryLine(record)}\n  ${record.description}${record.lastTool ? `\n  → ${record.lastTool}` : ""}${record.worktree ? `\n  worktree ${record.worktree.path} (${record.worktree.summary ?? "active"})` : ""}`)
                .join("\n")
            : "No pistack agents on this session branch.";
          return { content: [{ type: "text", text }], details: undefined };
        }
        case "wait": {
          const { records, timedOut } = await manager.wait(params.ids, (params.timeout_seconds ?? 600) * 1_000, signal);
          if (!records.length) return { content: [{ type: "text", text: "No background agents are running." }], details: undefined };
          const text = records.map((record) => agentReport(record)).join("\n\n====\n\n");
          return { content: [{ type: "text", text: timedOut ? `Timed out; some agents are still running.\n\n${text}` : text }], details: undefined };
        }
        case "stop": {
          if (!params.ids?.length) throw new Error("stop needs ids. pistack_agents list shows them.");
          const stopped = params.ids.map((id) => manager.stop(id));
          return { content: [{ type: "text", text: stopped.map((record) => `Stopping ${record.id} (${record.status}).`).join("\n") }], details: undefined };
        }
        case "cleanup":
          return { content: [{ type: "text", text: manager.cleanup().join("\n") }], details: undefined };
      }
    },
  });
}
