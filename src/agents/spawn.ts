// Run one pi child in JSON mode and fold its event stream into a result.
// Children are separate `pi` processes, so they load the user's own providers, extensions, MCP
// servers, and settings exactly as an interactive session would.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";

/** Strict JSONL framing: split only on LF, strip one CR, decode UTF-8 across chunk boundaries. */
export class JsonlReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string, onRecord: (record: unknown) => void): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      this.emit(this.buffer.slice(0, newline), onRecord);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(onRecord: (record: unknown) => void): void {
    this.buffer += this.decoder.end();
    if (this.buffer) this.emit(this.buffer, onRecord);
    this.buffer = "";
  }

  private emit(line: string, onRecord: (record: unknown) => void): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
    try {
      onRecord(JSON.parse(text));
    } catch {
      // Stdout is reserved for JSONL; a malformed record is dropped rather than failing the run.
    }
  }
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addUsage(totals: UsageTotals, usage: Partial<Usage> | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.totalTokens += usage.totalTokens ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

export function toUsage(totals: UsageTotals): Usage {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    totalTokens: totals.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.cost },
  };
}

export interface ChildProgress {
  turns: number;
  lastTool?: string;
  text?: string;
  usage: UsageTotals;
}

export interface ChildRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ChildProgress) => void;
}

export interface ChildRunResult {
  exitCode: number | null;
  sessionId?: string;
  finalText: string;
  turns: number;
  usage: UsageTotals;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  aborted: boolean;
  timedOut: boolean;
  stderr: string;
}

/** Run the same pi the parent runs, so children never pick up a different version from PATH. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args };
  return { command: "pi", args };
}

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function describeToolCall(name: string, args: Record<string, unknown> | undefined): string {
  const value = args?.command ?? args?.path ?? args?.file_path ?? args?.pattern ?? args?.description;
  const detail = typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 80) : "";
  return detail ? `${name} ${detail}` : name;
}

export function runPiJson(options: ChildRunOptions): Promise<ChildRunResult> {
  const result: ChildRunResult = {
    exitCode: null,
    finalText: "",
    turns: 0,
    usage: emptyUsage(),
    aborted: false,
    timedOut: false,
    stderr: "",
  };
  const progress: ChildProgress = { turns: 0, usage: result.usage };
  const report = () => options.onProgress?.({ ...progress, usage: { ...result.usage } });

  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const reader = new JsonlReader();
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const onRecord = (record: unknown) => {
      if (!record || typeof record !== "object") return;
      const event = record as Record<string, any>;
      switch (event.type) {
        case "session":
          if (typeof event.id === "string") result.sessionId = event.id;
          break;
        case "message_end": {
          const message = event.message;
          if (message?.role !== "assistant") break;
          result.turns++;
          progress.turns = result.turns;
          addUsage(result.usage, message.usage);
          if (message.provider && message.model) result.model = `${message.provider}/${message.model}`;
          if (message.stopReason) result.stopReason = message.stopReason;
          if (message.errorMessage) result.errorMessage = message.errorMessage;
          const text = textOf(message);
          if (text) {
            result.finalText = text;
            progress.text = text;
          }
          report();
          break;
        }
        case "tool_execution_start":
          progress.lastTool = describeToolCall(String(event.toolName ?? "tool"), event.args);
          report();
          break;
        case "agent_settled":
          if (event.aborted) result.aborted = true;
          break;
      }
    };

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
      killTimer.unref?.();
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          result.timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();

    const onAbort = () => {
      result.aborted = true;
      kill();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk, onRecord));
    child.stderr.on("data", (chunk: Buffer) => {
      if (result.stderr.length < 64 * 1024) result.stderr += chunk.toString("utf8");
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      reader.end(onRecord);
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      result.exitCode = code;
      resolve(result);
    };
    child.on("error", (error) => {
      result.stderr += `\n${error.message}`;
      finish(child.exitCode ?? 1);
    });
    child.on("close", (code) => finish(code));
  });
}
