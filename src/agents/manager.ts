// Lifecycle of pistack subagents: model resolution, worktrees, concurrency, background delivery, resume.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadModels, resolveSpec, roleValues, type Resolution, type Thinking } from "../models.ts";
import { childSessionsDir, storeDir } from "../paths.ts";
import {
  GENERAL_PURPOSE,
  MAX_INLINE_BRIEF_BYTES,
  childArgs,
  childBrief,
  childSystemPrompt,
  childTools,
  loadAgentDefinitions,
} from "./child.ts";
import { addUsage, emptyUsage, piInvocation, runPiJson, type UsageTotals } from "./spawn.ts";
import { ensureWorktree, planWorktree, removeCleanWorktree, settleWorktree, worktreeTaken, type Worktree } from "./worktree.ts";

export const AGENT_ENTRY = "pistack-agent";
export const AGENT_DONE_MESSAGE = "pistack-agent-done";

export type AgentStatus = "queued" | "running" | "done" | "failed" | "aborted" | "timeout";
const ACTIVE: readonly AgentStatus[] = ["queued", "running"];

export interface AgentWorktree extends Worktree {
  kept?: boolean;
  summary?: string;
}

export interface AgentRecord {
  id: string;
  description: string;
  subagentType: string;
  readonly: boolean;
  background: boolean;
  status: AgentStatus;
  model?: string;
  thinking?: string;
  modelSource: string;
  modelNote?: string;
  cwd: string;
  worktree?: AgentWorktree;
  sessionDir: string;
  sessionId: string;
  sessionFile?: string;
  outputFile?: string;
  startedAt: number;
  endedAt?: number;
  runs: number;
  turns: number;
  usage: UsageTotals;
  finalText?: string;
  error?: string;
  lastTool?: string;
}

export interface StartRequest {
  description: string;
  prompt: string;
  subagentType?: string;
  readonly?: boolean;
  isolation?: "worktree";
  base?: string;
  background?: boolean;
  resume?: string;
  files?: string[];
  model?: string;
  thinking?: Thinking;
  role?: string;
  seat?: number;
  timeoutMinutes?: number;
}

export interface ManagerOptions {
  pi: ExtensionAPI;
  /** Depth of this pi process: 0 for the root session. */
  depth: number;
  maxDepth: number;
  maxConcurrency: number;
  defaultTimeoutMinutes: number;
  passthrough: string[];
  rootStore: () => string | undefined;
  onChange: () => void;
}

class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];

  constructor(size: number) {
    this.available = Math.max(1, size);
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    const release = () => {
      const next = this.queue.shift();
      if (next) next();
      else this.available++;
    };
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        resolve(release);
      };
      const cancel = () => {
        const index = this.queue.indexOf(grant);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new Error("stopped while queued"));
      };
      if (signal.aborted) return cancel();
      signal.addEventListener("abort", cancel, { once: true });
      this.queue.push(grant);
    });
  }
}

export function normalizeSubagentType(value: string | undefined): string {
  const type = (value ?? GENERAL_PURPOSE).trim();
  if (/^general[-_ ]?purpose$|^general$/i.test(type)) return GENERAL_PURPOSE;
  return type.toLowerCase().replace(/\s+/g, "-");
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const REPLY_LIMIT = 30_000;

export function agentSummaryLine(record: AgentRecord): string {
  const elapsed = (record.endedAt ?? Date.now()) - record.startedAt;
  const parts = [`${record.status}`, `${record.turns} turn${record.turns === 1 ? "" : "s"}`];
  if (record.usage.totalTokens) parts.push(`${formatTokens(record.usage.totalTokens)} tokens`);
  if (record.usage.cost) parts.push(`$${record.usage.cost.toFixed(4)}`);
  parts.push(formatDuration(elapsed));
  return `pistack agent ${record.id} (${record.subagentType}${record.readonly ? ", read-only" : ""}): ${parts.join(" · ")}`;
}

/** The report a parent receives for a finished agent: facts first, then the child's own reply. */
export function agentReport(record: AgentRecord): string {
  const lines = [agentSummaryLine(record), `Task: ${record.description}`];
  lines.push(`Model: ${record.model ?? "parent model"}${record.thinking ? ` (${record.thinking})` : ""}, from ${record.modelSource}${record.modelNote ? `. Note: ${record.modelNote}` : ""}`);
  if (record.worktree) lines.push(`Worktree: ${record.worktree.path} on branch ${record.worktree.branch}: ${record.worktree.summary ?? "pending"}`);
  if (record.sessionFile) lines.push(`Transcript: ${record.sessionFile}`);
  if (!ACTIVE.includes(record.status)) lines.push(`Resume: pistack_agent with resume: "${record.id}" and a follow-up prompt.`);
  if (record.error) lines.push(`Error: ${record.error}`);
  const reply = record.finalText?.trim();
  if (reply) {
    lines.push("", "--- agent reply ---");
    if (reply.length > REPLY_LIMIT) {
      lines.push(reply.slice(0, REPLY_LIMIT), "", `[Reply truncated at ${REPLY_LIMIT} characters. Full reply: ${record.outputFile}]`);
    } else lines.push(reply);
  } else if (!ACTIVE.includes(record.status)) {
    lines.push("", "(The agent ended without a final reply.)");
  }
  return lines.join("\n");
}

function findSessionFile(dir: string, sessionId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const byName = files.find((name) => name.includes(sessionId));
  if (byName) return join(dir, byName);
  for (const name of files) {
    try {
      const head = readFileSync(join(dir, name), "utf8").split("\n", 1)[0];
      if (JSON.parse(head).id === sessionId) return join(dir, name);
    } catch {
      // Unreadable headers are not ours.
    }
  }
  return undefined;
}

export class AgentManager {
  readonly records = new Map<string, AgentRecord>();
  private readonly live = new Map<string, { controller: AbortController; done: Promise<AgentRecord>; background: boolean }>();
  private readonly waiting = new Map<string, number>();
  private readonly delivered = new Set<string>();
  private readonly pending: AgentRecord[] = [];
  private readonly semaphore: Semaphore;
  private readonly options: ManagerOptions;
  /** In print and JSON mode nothing can wake the parent later, so completions wait for settlement. */
  deliverAtSettle = false;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.semaphore = new Semaphore(options.maxConcurrency);
  }

  get canSpawn(): boolean {
    return this.options.depth < this.options.maxDepth;
  }

  restore(ctx: ExtensionContext): void {
    // Running agents keep their in-memory record, which their run updates; entries hold snapshots.
    const liveRecords = [...this.records.values()].filter((record) => this.live.has(record.id));
    this.records.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== AGENT_ENTRY || !entry.data) continue;
      const record = entry.data as AgentRecord;
      this.records.set(record.id, { ...record, usage: { ...emptyUsage(), ...record.usage } });
    }
    for (const record of liveRecords) this.records.set(record.id, record);
    for (const record of this.records.values()) {
      if (ACTIVE.includes(record.status) && !this.live.has(record.id)) {
        record.status = "aborted";
        record.error = "pi restarted or the session changed while this agent ran.";
      }
    }
  }

  running(): AgentRecord[] {
    return [...this.records.values()].filter((record) => ACTIVE.includes(record.status));
  }

  hasLiveBackground(): boolean {
    return [...this.live.values()].some((entry) => entry.background);
  }

  private persist(record: AgentRecord): void {
    const stored: AgentRecord = { ...record, finalText: record.finalText?.slice(0, 4_000) };
    this.options.pi.appendEntry(AGENT_ENTRY, stored);
  }

  private resolveModel(request: StartRequest, ctx: ExtensionContext, resumed?: AgentRecord): { resolution: Resolution; source: string } {
    const models = loadModels(ctx.cwd, ctx.isProjectTrusted());
    const parent = { provider: ctx.model?.provider, id: ctx.model?.id, thinking: this.options.pi.getThinkingLevel() as Thinking };
    const budget = models.budget?.thinking;
    let resolution: Resolution;
    let source: string;
    if (request.model) {
      resolution = resolveSpec(request.model, ctx.modelRegistry, parent, budget);
      source = `model "${request.model}"`;
    } else if (request.role) {
      const values = roleValues(models, request.role);
      const value = values?.[Math.min(Math.max(request.seat ?? 0, 0), values.length - 1)];
      resolution = resolveSpec(value, ctx.modelRegistry, parent, budget);
      source = values ? `role "${request.role}" (${value})` : `role "${request.role}", which has no line in the model rule`;
    } else if (resumed?.model) {
      resolution = resolveSpec(`${resumed.model}${resumed.thinking ? `:${resumed.thinking}` : ""}`, ctx.modelRegistry, parent);
      source = "the resumed agent's model";
    } else {
      resolution = resolveSpec(undefined, ctx.modelRegistry, parent);
      source = "the parent session";
    }
    if (request.thinking) resolution = { ...resolution, thinking: request.thinking };
    return { resolution, source };
  }

  async start(
    request: StartRequest,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onProgress?: (record: AgentRecord) => void,
  ): Promise<AgentRecord> {
    const { depth, maxDepth } = this.options;
    if (!this.canSpawn) throw new Error(`pistack subagents nest at most ${maxDepth} levels deep; this agent is at depth ${depth}.`);
    const resumed = request.resume ? this.records.get(request.resume) : undefined;
    if (request.resume && !resumed) {
      throw new Error(`No agent "${request.resume}" on this session branch. pistack_agents with action "list" shows agents you can resume.`);
    }
    if (resumed && ACTIVE.includes(resumed.status)) throw new Error(`Agent ${resumed.id} is still ${resumed.status}. Wait for it before resuming it.`);

    const definitions = loadAgentDefinitions();
    const subagentType = resumed?.subagentType ?? normalizeSubagentType(request.subagentType);
    const definition = definitions.get(subagentType);
    if (!definition) throw new Error(`Unknown subagent_type "${request.subagentType}". Available: ${[...definitions.keys()].join(", ")}.`);

    // New ids never reuse a record, a worktree path, or a branch left by an earlier agent.
    let id = resumed?.id ?? "";
    let worktree: AgentWorktree | undefined = resumed?.worktree;
    while (!resumed) {
      id = randomBytes(4).toString("hex");
      if (this.records.has(id)) continue;
      if (request.isolation === "worktree") {
        worktree = planWorktree(ctx.cwd, id, request.base);
        if (worktreeTaken(worktree)) continue;
      }
      break;
    }
    const sessionDir = resumed?.sessionDir ?? childSessionsDir(ctx.sessionManager.getSessionId());
    const sessionId = resumed?.sessionId ?? `pistack-${id}`;
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const { resolution, source } = this.resolveModel(request, ctx, resumed);
    const readonly = resumed?.readonly ?? request.readonly ?? false;
    const background = request.background ?? false;

    if (worktree) ensureWorktree(worktree);
    const cwd = worktree?.path ?? resumed?.cwd ?? ctx.cwd;

    const record: AgentRecord = {
      id,
      description: resumed?.description ?? request.description,
      subagentType,
      readonly,
      background,
      status: "queued",
      model: resolution.provider && resolution.id ? `${resolution.provider}/${resolution.id}` : undefined,
      thinking: resolution.thinking,
      modelSource: source,
      modelNote: resolution.note,
      cwd,
      worktree: worktree ? { ...worktree, kept: undefined, summary: undefined } : undefined,
      sessionDir,
      sessionId,
      sessionFile: resumed?.sessionFile,
      startedAt: Date.now(),
      runs: (resumed?.runs ?? 0) + 1,
      turns: resumed?.turns ?? 0,
      usage: resumed ? { ...resumed.usage } : emptyUsage(),
    };
    this.records.set(id, record);
    this.delivered.delete(id);
    this.persist(record);
    this.options.onChange();

    const systemPromptFile = join(sessionDir, `${id}.system.md`);
    writeFileSync(
      systemPromptFile,
      childSystemPrompt({ id, definition, depth: depth + 1, maxDepth, readonly, background, worktree }),
      { mode: 0o600 },
    );
    const header = resumed
      ? `Follow-up from your parent session (agent ${id}, run ${record.runs}):`
      : `Brief from your parent session (agent ${id}: ${record.description}):`;
    const brief = resumed ? request.prompt : childBrief(request.prompt, request.files, cwd);
    let prompt = `${header}\n\n${brief}`;
    let briefFile: string | undefined;
    if (Buffer.byteLength(prompt) > MAX_INLINE_BRIEF_BYTES) {
      briefFile = join(sessionDir, `${id}.brief-${record.runs}.md`);
      writeFileSync(briefFile, brief, { mode: 0o600 });
      prompt = `${header}\n\nYour brief is in the attached file. Follow it.`;
    }
    const readOnlyTools = new Set(
      this.options.pi
        .getAllTools()
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name),
    );
    const tools = childTools(this.options.pi.getActiveTools(), {
      readonly,
      canSpawn: depth + 1 < maxDepth,
      isReadOnlyTool: (name) => readOnlyTools.has(name),
    });
    const invocation = piInvocation(
      childArgs({
        sessionDir,
        sessionId,
        model: record.model,
        thinking: record.thinking,
        tools,
        systemPromptFile,
        passthrough: this.options.passthrough,
        trusted: ctx.isProjectTrusted(),
        prompt,
        briefFile,
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PISTACK_CHILD: "1",
      PISTACK_DEPTH: String(depth + 1),
      PISTACK_AGENT_ID: id,
      PISTACK_READONLY: readonly ? "1" : "0",
      PISTACK_SUBAGENT_TYPE: subagentType,
      PISTACK_ROOT_STORE: this.options.rootStore() ?? "",
      PISTACK_PARENT_SESSION: ctx.sessionManager.getSessionFile() ?? "",
    };

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (!background) signal?.addEventListener("abort", onParentAbort, { once: true });
    const timeoutMs = Math.round((request.timeoutMinutes ?? this.options.defaultTimeoutMinutes) * 60_000);
    const priorTurns = record.turns;
    const priorUsage = { ...record.usage };
    const ownStore = storeDir(ctx.sessionManager.getSessionId());

    const done = (async () => {
      let release: (() => void) | undefined;
      try {
        release = await this.semaphore.acquire(controller.signal);
        record.status = "running";
        record.startedAt = Date.now();
        this.options.onChange();
        const result = await runPiJson({
          command: invocation.command,
          args: invocation.args,
          cwd,
          env,
          timeoutMs,
          signal: controller.signal,
          onProgress: (progress) => {
            record.turns = priorTurns + progress.turns;
            record.usage = { ...priorUsage };
            addUsage(record.usage, { ...progress.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: progress.usage.cost } });
            record.lastTool = progress.lastTool;
            if (progress.text) record.finalText = progress.text;
            onProgress?.(record);
            this.options.onChange();
          },
        });
        record.turns = priorTurns + result.turns;
        record.usage = { ...priorUsage };
        addUsage(record.usage, { ...result.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: result.usage.cost } });
        if (result.model) record.model = result.model;
        if (result.finalText) record.finalText = result.finalText;
        if (result.timedOut) {
          record.status = "timeout";
          record.error = `Stopped after ${request.timeoutMinutes ?? this.options.defaultTimeoutMinutes} minutes. Raise timeout_minutes for longer work.`;
        } else if (result.aborted || controller.signal.aborted) {
          record.status = "aborted";
        } else if (result.exitCode === 0 && result.stopReason !== "error") {
          record.status = "done";
        } else {
          record.status = "failed";
          record.error = result.errorMessage || result.stderr.trim().slice(-2_000) || `pi exited with code ${result.exitCode}`;
        }
        record.sessionFile = findSessionFile(sessionDir, result.sessionId ?? sessionId) ?? record.sessionFile;
      } catch (error) {
        record.status = controller.signal.aborted ? "aborted" : "failed";
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        release?.();
        signal?.removeEventListener("abort", onParentAbort);
      }
      if (worktree) {
        try {
          const outcome = settleWorktree(worktree);
          record.worktree = { ...worktree, kept: outcome.kept, summary: outcome.summary };
        } catch (error) {
          record.worktree = { ...worktree, kept: true, summary: `kept; could not inspect it: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      record.endedAt = Date.now();
      record.lastTool = undefined;
      record.outputFile = this.writeOutput(ownStore, record);
      this.live.delete(id);
      this.persist(record);
      this.options.onChange();
      if (background) this.complete(record);
      return record;
    })();
    this.live.set(id, { controller, done, background });
    if (background) {
      done.catch(() => undefined);
      return record;
    }
    return done;
  }

  private writeOutput(store: string, record: AgentRecord): string | undefined {
    try {
      const dir = join(store, "agents");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${record.id}.md`);
      writeFileSync(file, `${agentSummaryLine(record)}\n\n${record.finalText ?? "(no reply)"}\n`, { mode: 0o600 });
      return file;
    } catch {
      return undefined;
    }
  }

  private complete(record: AgentRecord): void {
    if (this.delivered.has(record.id) || (this.waiting.get(record.id) ?? 0) > 0) return;
    if (this.deliverAtSettle) {
      this.pending.push(record);
      return;
    }
    this.delivered.add(record.id);
    this.options.pi.sendMessage(
      { customType: AGENT_DONE_MESSAGE, content: agentReport(record), display: true, details: { id: record.id, status: record.status } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /** Print/JSON mode: wait for background agents, then hand back every undelivered completion. */
  async drainForSettle(signal?: AbortSignal): Promise<AgentRecord[]> {
    const live = [...this.live.values()].filter((entry) => entry.background).map((entry) => entry.done);
    if (live.length) {
      await Promise.race([
        Promise.allSettled(live),
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
      ]);
    }
    const ready = this.pending.splice(0).filter((record) => !this.delivered.has(record.id));
    for (const record of ready) this.delivered.add(record.id);
    return ready;
  }

  async wait(ids: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ records: AgentRecord[]; timedOut: boolean }> {
    const targets = ids?.length ? ids : [...this.live.entries()].filter(([, entry]) => entry.background).map(([id]) => id);
    for (const id of targets) {
      if (!this.records.has(id)) throw new Error(`No agent "${id}" on this session branch.`);
    }
    for (const id of targets) this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
    let timedOut = false;
    try {
      const all = Promise.allSettled(targets.map((id) => this.live.get(id)?.done ?? Promise.resolve(this.records.get(id)!)));
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
          timer.unref?.();
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }),
      ]);
    } finally {
      for (const id of targets) {
        const count = (this.waiting.get(id) ?? 1) - 1;
        if (count > 0) this.waiting.set(id, count);
        else this.waiting.delete(id);
      }
    }
    const records = targets.map((id) => this.records.get(id)!);
    for (const record of records) {
      if (!ACTIVE.includes(record.status)) {
        this.delivered.add(record.id);
        const index = this.pending.indexOf(record);
        if (index !== -1) this.pending.splice(index, 1);
      }
    }
    return { records, timedOut };
  }

  stop(id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`No agent "${id}" on this session branch.`);
    this.delivered.add(id);
    this.live.get(id)?.controller.abort();
    return record;
  }

  stopAll(): void {
    for (const [id, entry] of this.live) {
      this.delivered.add(id);
      entry.controller.abort();
    }
  }

  cleanup(): string[] {
    const lines: string[] = [];
    for (const record of this.records.values()) {
      if (!record.worktree || ACTIVE.includes(record.status) || !existsSync(record.worktree.path)) continue;
      try {
        lines.push(removeCleanWorktree(record.worktree));
      } catch (error) {
        lines.push(`${record.worktree.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return lines.length ? lines : ["No finished agent has a worktree left on disk."];
  }
}
