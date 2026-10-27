// pistack: Lauren Tan's pstack (cursor/plugins, MIT) as a pi 1.4 package.
// One entry wires everything: tools, commands, the --poteto flag, prompt sections, and guards.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { passthroughArgs } from "./agents/child.ts";
import { AGENT_DONE_MESSAGE, AgentManager, agentReport, agentSummaryLine, type AgentRecord } from "./agents/manager.ts";
import { citationNudge, mutatingCommand, unreadCitations } from "./guards.ts";
import { LoopController, registerLoop } from "./loop.ts";
import { loadModels, type LoadedModels } from "./models.ts";
import { SKILLS_DIR, principleSlugs, storeDir } from "./paths.ts";
import { pistackSection, potetoSection } from "./prompt.ts";
import { runSetup } from "./setup.ts";
import { StateStore, expandedSkills, isPistackPath, pathsInCommand, playbookFromPath, principleFromPath } from "./state.ts";
import { registerAgentTools } from "./tools/agent.ts";
import { registerAskTool } from "./tools/ask.ts";
import { registerSessionsTool, workspaceSessionDir } from "./tools/sessions.ts";
import { TodoState, registerTodoTool } from "./tools/todo.ts";
import { VirtualModels } from "./virtual-models.ts";

export const PISTACK_TOOLS = ["pistack_agent", "pistack_agents", "pistack_ask", "pistack_todo", "pistack_loop", "pistack_sessions"] as const;
const SPAWN_TOOLS = new Set(["pistack_agent", "pistack_agents"]);
/** Tools a read-only child may call even without a read-only annotation. */
const READONLY_ALLOWED = new Set(["read", "grep", "find", "ls", "bash", "pistack_todo", "pistack_sessions"]);
const CITATION_MESSAGE = "pistack-citation";
const TS_SKILL = "typescript-best-practices";

/** Skill aliases: `/how …` runs `/skill:how …`. Every skill also works as `/skill:<name>`. */
export const SKILL_ALIASES = [
  "how", "why", "architect", "arena", "swarm", "interrogate", "reflect", "unslop", "figure-it-out", "tdd", "recall", "poteto-help",
] as const;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), min), max) : fallback;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function agentDoneEntry(record: AgentRecord): SessionBoundaryDraft {
  return { type: "custom_message", customType: AGENT_DONE_MESSAGE, content: agentReport(record), display: true, details: { id: record.id, status: record.status } };
}

export default function pistack(pi: ExtensionAPI): void {
  const isChild = process.env.PISTACK_CHILD === "1";
  const depth = isChild ? envInt("PISTACK_DEPTH", 1, 1, 10) : 0;
  const maxDepth = envInt("PISTACK_MAX_DEPTH", 3, 1, 6);
  const childReadonly = isChild && process.env.PISTACK_READONLY === "1";

  const state = new StateStore(pi);
  const todos = new TodoState();
  const virtualModels = new VirtualModels(pi);
  let current: ExtensionContext | undefined;
  let models: LoadedModels = loadModels(process.cwd(), false);
  let nudged = false;
  let tsHinted = false;
  let ticker: NodeJS.Timeout | undefined;

  const manager = new AgentManager({
    pi,
    depth,
    maxDepth,
    maxConcurrency: envInt("PISTACK_MAX_CONCURRENCY", 4, 1, 16),
    defaultTimeoutMinutes: envInt("PISTACK_AGENT_TIMEOUT_MINUTES", 60, 1, 1_440),
    passthrough: passthroughArgs(process.argv.slice(2)),
    rootStore: () => process.env.PISTACK_ROOT_STORE || (current ? storeDir(current.sessionManager.getSessionId()) : undefined),
    onChange: () => refresh(),
  });
  const loop = new LoopController(pi, () => current, () => refresh());

  registerAgentTools(pi, manager);
  registerAskTool(pi);
  registerTodoTool(pi, todos, () => refresh());
  registerSessionsTool(pi, manager);
  registerLoop(pi, loop);
  virtualModels.sync(models);

  pi.registerFlag("poteto", { type: "boolean", description: "Start with sticky poteto mode on (like a Cursor Custom Mode)" });

  // ---- engagement: pistack's tools and prompt section switch on once a pstack skill is in use ----

  function activateTools(): void {
    if (isChild) return; // children receive their tools through --tools
    const active = new Set(pi.getActiveTools());
    const before = active.size;
    for (const name of PISTACK_TOOLS) if (manager.canSpawn || !SPAWN_TOOLS.has(name)) active.add(name);
    if (active.size !== before) pi.setActiveTools([...active]);
  }

  function engage(): void {
    if (!state.state.engaged) {
      state.update({ engaged: true });
      activateTools();
    }
    refresh();
  }

  function setPoteto(on: boolean, ctx: ExtensionContext): void {
    current = ctx;
    state.update({ poteto: on });
    if (on) engage();
    else refresh();
  }

  function reloadModels(ctx: ExtensionContext): void {
    models = loadModels(ctx.cwd, ctx.isProjectTrusted());
    virtualModels.sync(models);
  }

  // ---- status line and agent widget ----

  function refresh(): void {
    const ctx = current;
    if (!ctx?.hasUI) return;
    // RPC clients get plain text: they have no theme and may not render ANSI.
    const styled = ctx.mode === "tui" ? ctx.ui.theme : undefined;
    const theme = {
      fg: (color: Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0], text: string) => (styled ? styled.fg(color, text) : text),
    };
    const s = state.state;
    const running = manager.running();
    if (running.length && !ticker) {
      ticker = setInterval(() => refresh(), 1_000);
      ticker.unref?.();
    } else if (!running.length && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!s.poteto && !s.engaged && !running.length && !loop.state) {
      ctx.ui.setStatus("pistack", undefined);
      ctx.ui.setWidget("pistack-agents", undefined);
      return;
    }
    const parts = [s.poteto ? theme.fg("accent", "👑 poteto") : theme.fg("muted", "pstack")];
    if (s.playbook) parts.push(s.playbook);
    const progress = todos.progress();
    if (progress.total) {
      const filled = Math.round((progress.done / progress.total) * 8);
      parts.push(`${theme.fg("success", "■".repeat(filled))}${theme.fg("dim", "□".repeat(8 - filled))} ${progress.done}/${progress.total}`);
    }
    if (s.principlesRead.length) parts.push(`${s.principlesRead.length} principle${s.principlesRead.length === 1 ? "" : "s"}`);
    if (running.length) parts.push(theme.fg("warning", `${running.length} agent${running.length === 1 ? "" : "s"}`));
    if (loop.state) parts.push(theme.fg("accent", `↻ ${loop.state.iterations}/${loop.state.maxIterations}`));
    ctx.ui.setStatus("pistack", parts.join(theme.fg("dim", " · ")));
    ctx.ui.setWidget(
      "pistack-agents",
      running.length
        ? running.map((record) => {
            const line = `${theme.fg("warning", "●")} ${agentSummaryLine(record).replace(/^pistack agent /, "")} ${theme.fg("muted", record.description)}`;
            return record.lastTool ? `${line}\n  ${theme.fg("dim", `→ ${record.lastTool}`)}` : line;
          })
        : undefined,
    );
  }

  // ---- session lifecycle ----

  function restore(ctx: ExtensionContext): void {
    current = ctx;
    state.restore(ctx);
    todos.restore(ctx);
    manager.restore(ctx);
    if (state.state.engaged) activateTools();
    refresh();
  }

  pi.on("session_start", async (_event, ctx) => {
    manager.deliverAtSettle = ctx.mode === "print" || ctx.mode === "json";
    loop.oneShot = manager.deliverAtSettle;
    tsHinted = false;
    restore(ctx);
    reloadModels(ctx);
    if (pi.getFlag("poteto") === true && !state.state.poteto && !isChild) setPoteto(true, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    const running = manager.running().length;
    manager.stopAll();
    loop.dispose();
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    if (running && ctx.hasUI) ctx.ui.notify(`pistack stopped ${running} running subagent${running === 1 ? "" : "s"}.`, "warning");
  });

  // ---- prompt sections, rebuilt every run so they follow the branch and survive compaction ----

  pi.on("before_agent_start", async (event, ctx) => {
    current = ctx;
    nudged = false;
    if (event.messageType === "user") {
      for (const skill of expandedSkills(event.prompt)) {
        if (!isPistackPath(skill.location)) continue;
        const principle = principleFromPath(skill.location);
        if (principle) state.markPrincipleRead(principle);
        engage();
      }
    }
    if (!isChild && !state.state.engaged && !state.state.poteto) return;
    reloadModels(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const store = storeDir(sessionId);
    try {
      mkdirSync(store, { recursive: true, mode: 0o700 });
    } catch {
      // The store is a convenience; a read-only home must not break the run.
    }
    const sections = event.systemPromptOptions.sections;
    sections.pistack = pistackSection({
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionDir: workspaceSessionDir(ctx),
      store,
      rootStore: process.env.PISTACK_ROOT_STORE || store,
      models,
      child: isChild ? { depth, maxDepth, readonly: childReadonly } : undefined,
    });
    if (state.state.poteto) sections["poteto-mode"] = potetoSection(state.state);
  });

  // ---- guards ----

  pi.on("tool_call", async (event) => {
    if (!childReadonly) return;
    if (event.toolName === "bash") {
      const reason = mutatingCommand(String((event.input as { command?: unknown }).command ?? ""));
      if (reason) return { block: true, reason: `This subagent is read-only, and that command ${reason}. Report the change you would make instead.` };
      return;
    }
    if (READONLY_ALLOWED.has(event.toolName)) return;
    const annotations = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
    if (annotations?.readOnlyHint === true) return;
    return { block: true, reason: `This subagent is read-only, and ${event.toolName} may change state. Report what you would do instead.` };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const input = event.input as { path?: unknown; command?: unknown };
    const paths =
      event.toolName === "read" && typeof input.path === "string"
        ? [resolve(ctx.cwd, expandHome(input.path))]
        : event.toolName === "bash" && typeof input.command === "string"
          ? pathsInCommand(input.command).map((path) => resolve(ctx.cwd, expandHome(path)))
          : [];
    let touched = false;
    for (const path of paths) {
      if (!isPistackPath(path)) continue;
      touched = true;
      const principle = principleFromPath(path);
      if (principle) state.markPrincipleRead(principle);
      const playbook = playbookFromPath(path);
      if (playbook) state.update({ playbook });
      if (path.includes(`${TS_SKILL}/SKILL.md`)) tsHinted = true;
    }
    if (touched) engage();

    // Cursor attaches typescript-best-practices through `paths:`; pi has no equivalent, so point at it once.
    if ((event.toolName === "edit" || event.toolName === "write") && !tsHinted && (state.state.engaged || isChild)) {
      if (typeof input.path === "string" && /\.(ts|tsx|mts|cts)$/.test(input.path)) {
        tsHinted = true;
        return {
          content: [
            ...event.content,
            {
              type: "text",
              text: `pistack: pstack's ${TS_SKILL} skill applies to TypeScript files (Cursor attaches it automatically). Read ${resolve(SKILLS_DIR, TS_SKILL, "SKILL.md")} before further TypeScript edits.`,
            },
          ],
        };
      }
    }
  });

  // ---- settlement: citation check, print-mode delivery of background agents, loops ----

  pi.on("agent_before_settle", async (event, ctx) => {
    const mine: SessionBoundaryDraft[] = [];
    let wantContinue = false;

    // `event.context` previews the context before our entries; the appended message makes continuation valid.
    if (event.outcome === "completed" && !nudged && (state.state.engaged || isChild)) {
      const unread = unreadCitations(lastAssistantText(event.context.contextMessages), state.state.principlesRead, principleSlugs());
      if (unread.length) {
        nudged = true;
        mine.push({ type: "custom_message", customType: CITATION_MESSAGE, content: citationNudge(unread), display: true });
        wantContinue = true;
      }
    }

    if (!wantContinue && manager.deliverAtSettle) {
      if (event.outcome !== "completed") manager.stopAll();
      const ready = await manager.drainForSettle(ctx.signal);
      mine.push(...ready.map(agentDoneEntry));
      if (ready.length && event.outcome === "completed") wantContinue = true;
    }

    if (!wantContinue) {
      const result = await loop.onSettle(ctx, event.outcome, ctx.signal);
      if (result) {
        mine.push(...result.entries);
        wantContinue = result.continue;
      }
    }

    if (!mine.length) return;
    return { entries: [...event.entries, ...mine], continue: wantContinue ? true : undefined };
  });

  pi.on("agent_settled", async () => refresh());

  // ---- commands ----

  pi.registerCommand("poteto-mode", {
    description: "Sticky poteto mode: /poteto-mode [on|off|status] or /poteto-mode <task>",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "off") {
        setPoteto(false, ctx);
        ctx.ui.notify("Poteto mode off.", "info");
      } else if (arg === "status") {
        const s = state.state;
        ctx.ui.notify(
          `Poteto mode ${s.poteto ? "on" : "off"}. Playbook: ${s.playbook ?? "none"}. Principles read: ${s.principlesRead.join(", ") || "none"}.`,
          "info",
        );
      } else {
        setPoteto(true, ctx);
        if (arg && arg !== "on") {
          pi.sendUserMessage(`/skill:poteto-mode ${arg}`, { expandPromptTemplates: true, deliverAs: ctx.isIdle() ? undefined : "followUp" });
        } else {
          ctx.ui.notify("👑 Poteto mode on. Every new task gets the poteto-mode reminder. /poteto-mode off to stop.", "info");
        }
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle sticky poteto mode",
    handler: (ctx) => {
      const on = !state.state.poteto;
      setPoteto(on, ctx);
      ctx.ui.notify(on ? "👑 Poteto mode on." : "Poteto mode off.", "info");
    },
  });

  pi.registerCommand("setup-pstack", {
    description: "Choose the models pstack roles use (writes ~/.pi/agent/pstack/models.md)",
    handler: async (_args, ctx) => {
      current = ctx;
      await runSetup(ctx, () => reloadModels(ctx));
    },
  });

  pi.registerCommand("pstack-agents", {
    description: "pstack subagents: /pstack-agents [stop <id>|stop all|cleanup]",
    getArgumentCompletions: (prefix) =>
      ["stop all", "cleanup", ...[...manager.records.keys()].map((id) => `stop ${id}`)]
        .filter((option) => option.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [action, target] = args.trim().split(/\s+/);
      try {
        if (action === "stop" && target === "all") {
          const count = manager.running().length;
          manager.stopAll();
          ctx.ui.notify(`Stopping ${count} agent${count === 1 ? "" : "s"}.`, "info");
        } else if (action === "stop" && target) {
          ctx.ui.notify(`Stopping ${manager.stop(target).id}.`, "info");
        } else if (action === "cleanup") {
          ctx.ui.notify(manager.cleanup().join("\n"), "info");
        } else {
          const records = [...manager.records.values()].sort((a, b) => b.startedAt - a.startedAt);
          ctx.ui.notify(records.length ? records.map((record) => `${agentSummaryLine(record)}\n  ${record.description}`).join("\n") : "No pistack agents on this branch.", "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  for (const name of SKILL_ALIASES) {
    pi.registerCommand(name, {
      description: `pstack: run /skill:${name}`,
      handler: async (args, ctx) => {
        pi.sendUserMessage(`/skill:${name}${args.trim() ? ` ${args.trim()}` : ""}`, {
          expandPromptTemplates: true,
          deliverAs: ctx.isIdle() ? undefined : "followUp",
        });
      },
    });
  }
}
