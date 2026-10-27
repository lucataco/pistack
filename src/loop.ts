// pi's stand-in for Cursor's `/loop`: a heartbeat (`every`), a shell predicate (`until`), or an
// agent-driven loop that runs until the agent stops it. Always bounded by max_iterations.

import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const LOOP_ENTRY = "pistack-loop";
export const LOOP_MESSAGE = "pistack-loop";
const DEFAULT_MAX = 25;
const CHECK_TIMEOUT_MS = 10 * 60_000;

export interface LoopSpec {
  every?: string;
  until?: string;
  prompt?: string;
  maxIterations?: number;
}

export interface LoopState {
  every?: string;
  everyMs?: number;
  until?: string;
  prompt: string;
  maxIterations: number;
  iterations: number;
  startedAt: number;
  lastCheck?: { code: number; tail: string };
}

export function parseDuration(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  if (!/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(value)) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const [, amount, , suffix] of value.matchAll(/(\d+(\.\d+)?)(ms|s|m|h|d)/g)) total += Number(amount) * unit[suffix];
  return total > 0 ? total : undefined;
}

export type LoopCommand = { action: "stop" } | { action: "status" } | ({ action: "start" } & LoopSpec);

/** `/pstack-loop [stop|status] | [<every>] [until "<cmd>"|until done] [--max N] [prompt…]` */
export function parseLoopCommand(input: string): LoopCommand {
  const tokens = [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (tokens[0] === "stop" || tokens[0] === "off") return { action: "stop" };
  if (!tokens.length || tokens[0] === "status") return { action: "status" };
  const spec: LoopSpec = {};
  let index = 0;
  if (parseDuration(tokens[index] ?? "")) spec.every = tokens[index++];
  while (index < tokens.length) {
    if (tokens[index] === "until") {
      const predicate = tokens[index + 1];
      index += 2;
      if (predicate && predicate !== "done") spec.until = predicate;
    } else if (tokens[index] === "--max" || tokens[index] === "max") {
      spec.maxIterations = Number(tokens[index + 1]) || undefined;
      index += 2;
    } else break;
  }
  const prompt = tokens.slice(index).join(" ").trim();
  if (prompt) spec.prompt = prompt;
  return { action: "start", ...spec };
}

export class LoopController {
  state?: LoopState;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly pi: ExtensionAPI;
  private readonly context: () => ExtensionContext | undefined;
  private readonly onChange: () => void;
  /** Print and JSON runs exit at settlement, so heartbeats there act as `until` checks. */
  oneShot = false;

  constructor(pi: ExtensionAPI, context: () => ExtensionContext | undefined, onChange: () => void) {
    this.pi = pi;
    this.context = context;
    this.onChange = onChange;
  }

  start(spec: LoopSpec): string {
    this.clearTimer();
    const everyMs = spec.every ? parseDuration(spec.every) : undefined;
    if (spec.every && !everyMs) throw new Error(`Cannot read the interval "${spec.every}". Use a value such as 30s, 15m, or 1h.`);
    const prompt =
      spec.prompt?.trim() ||
      (spec.until
        ? `Keep driving toward the exit condition. The loop stops when \`${spec.until}\` exits 0.`
        : "Keep driving toward the run's exit condition. When it is met, call pistack_loop with action \"stop\".");
    this.state = {
      every: spec.every,
      everyMs,
      until: spec.until,
      prompt,
      maxIterations: Math.max(1, Math.min(spec.maxIterations ?? DEFAULT_MAX, 500)),
      iterations: 0,
      startedAt: Date.now(),
    };
    this.pi.appendEntry(LOOP_ENTRY, { event: "start", ...this.state });
    if (everyMs && !this.oneShot) {
      this.timer = setInterval(() => void this.tick(), everyMs);
      this.timer.unref?.();
    }
    this.onChange();
    return this.describe();
  }

  stop(reason: string): string {
    if (!this.state) return "No loop is running.";
    const summary = `Loop stopped after ${this.state.iterations} iteration${this.state.iterations === 1 ? "" : "s"}: ${reason}.`;
    this.pi.appendEntry(LOOP_ENTRY, { event: "stop", reason, iterations: this.state.iterations });
    this.clearTimer();
    this.state = undefined;
    this.onChange();
    return summary;
  }

  describe(): string {
    const state = this.state;
    if (!state) return "No loop is running.";
    const parts = [];
    if (state.every) parts.push(`wakes every ${state.every}${this.oneShot ? " (ignored in print mode)" : ""}`);
    parts.push(state.until ? `until \`${state.until}\` exits 0` : "until the agent stops it with pistack_loop");
    parts.push(`iteration ${state.iterations}/${state.maxIterations}`);
    return `Loop running: ${parts.join(", ")}. Each wake: ${state.prompt}`;
  }

  status(): string {
    return this.describe();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.clearTimer();
    this.state = undefined;
  }

  private async check(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ passed: boolean; tail: string }> {
    const state = this.state!;
    const result = await this.pi.exec("sh", ["-c", state.until!], { cwd: ctx.cwd, timeout: CHECK_TIMEOUT_MS, signal });
    const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-1_500);
    state.lastCheck = { code: result.code, tail };
    return { passed: result.code === 0 && !result.killed, tail };
  }

  private wakeText(extra?: string): string {
    const state = this.state!;
    const header = `pistack loop, iteration ${state.iterations}/${state.maxIterations}.`;
    return [header, extra, state.prompt].filter(Boolean).join("\n\n");
  }

  /** Called from `agent_before_settle`. Returns a continuation when the loop should go on. */
  async onSettle(ctx: ExtensionContext, outcome: string, signal?: AbortSignal): Promise<{ entries: SessionBoundaryDraft[]; continue: boolean } | undefined> {
    const state = this.state;
    if (!state) return undefined;
    if (outcome !== "completed") {
      const summary = this.stop(outcome === "aborted" ? "the run was aborted" : "the run ended with an error");
      return { entries: [note(summary)], continue: false };
    }
    let checkInfo: string | undefined;
    if (state.until) {
      const { passed, tail } = await this.check(ctx, signal);
      if (passed) return { entries: [note(this.stop(`\`${state.until}\` exited 0`))], continue: false };
      checkInfo = `\`${state.until}\` still fails (exit ${state.lastCheck?.code}).${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
    }
    // A heartbeat loop waits for its timer; everything else continues now.
    if (state.everyMs && !this.oneShot) return undefined;
    if (state.iterations >= state.maxIterations) return { entries: [note(this.stop(`reached max_iterations (${state.maxIterations})`))], continue: false };
    state.iterations++;
    this.onChange();
    return { entries: [{ type: "custom_message", customType: LOOP_MESSAGE, content: this.wakeText(checkInfo), display: true }], continue: true };
  }

  private async tick(): Promise<void> {
    const ctx = this.context();
    const state = this.state;
    if (!ctx || !state || this.ticking || !ctx.isIdle()) return;
    this.ticking = true;
    try {
      let checkInfo: string | undefined;
      if (state.until) {
        const { passed, tail } = await this.check(ctx);
        if (passed) {
          this.pi.sendMessage({ customType: LOOP_MESSAGE, content: this.stop(`\`${state.until}\` exited 0`), display: true });
          return;
        }
        checkInfo = `\`${state.until}\` still fails (exit ${state.lastCheck?.code}).${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
      }
      if (state.iterations >= state.maxIterations) {
        this.pi.sendMessage({ customType: LOOP_MESSAGE, content: this.stop(`reached max_iterations (${state.maxIterations})`), display: true });
        return;
      }
      state.iterations++;
      this.onChange();
      this.pi.sendMessage({ customType: LOOP_MESSAGE, content: this.wakeText(checkInfo), display: true }, { triggerTurn: true, deliverAs: "followUp" });
    } finally {
      this.ticking = false;
    }
  }
}

function note(text: string): SessionBoundaryDraft {
  return { type: "custom_message", customType: LOOP_MESSAGE, content: text, display: true };
}

export function registerLoop(pi: ExtensionAPI, loop: LoopController): void {
  pi.registerTool({
    name: "pistack_loop",
    label: "pistack loop",
    description:
      "Arm, stop, or inspect a loop that wakes this session (Cursor's `/loop`). `every` (\"30m\", \"1h\") wakes on a heartbeat while idle; `until` is a shell command that ends the loop when it exits 0; with neither, the loop continues after each turn until you call action \"stop\". Bounded by max_iterations (default 25). The loop lives in this pi process.",
    promptSnippet: "Arm or stop a bounded wake loop (Cursor's /loop)",
    parameters: Type.Object(
      {
        action: StringEnum(["start", "stop", "status"] as const),
        every: Type.Optional(Type.String({ description: "Heartbeat interval such as 30m or 1h." })),
        until: Type.Optional(Type.String({ description: "Shell predicate; the loop ends when it exits 0." })),
        prompt: Type.Optional(Type.String({ description: "What each wake should do." })),
        max_iterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        reason: Type.Optional(Type.String({ description: "Why the loop stops (for `stop`)." })),
      },
      { additionalProperties: false },
    ),
    defaultActive: false,
    async execute(_toolCallId, params) {
      if (process.env.PISTACK_CHILD === "1") throw new Error("Subagents cannot arm loops. Report back to the parent instead.");
      let text: string;
      if (params.action === "start") text = loop.start({ every: params.every, until: params.until, prompt: params.prompt, maxIterations: params.max_iterations });
      else if (params.action === "stop") text = loop.stop(params.reason?.trim() || "stopped by the agent");
      else text = loop.status();
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerCommand("pstack-loop", {
    description: "Run a bounded wake loop: /pstack-loop [30m] [until \"npm test\"|until done] [--max N] [prompt] | stop | status",
    getArgumentCompletions: (prefix) =>
      ["stop", "status", "until done", 'until "npm test"', "30m", "1h"]
        .filter((option) => option.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const command = parseLoopCommand(args);
      try {
        if (command.action === "stop") ctx.ui.notify(loop.stop("stopped by the user"), "info");
        else if (command.action === "status") ctx.ui.notify(loop.status(), "info");
        else {
          const text = loop.start(command);
          ctx.ui.notify(text, "info");
          if (ctx.isIdle()) pi.sendMessage({ customType: LOOP_MESSAGE, content: `${text}\n\nStart now.`, display: true }, { triggerTurn: true });
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
