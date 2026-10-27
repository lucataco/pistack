// A minimal pi RPC client for tests: commands, events, and scripted answers to extension dialogs.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { JsonlReader } from "../../src/agents/spawn.ts";
import { FIXTURE, PI_CLI, ROOT, cleanEnv, type Sandbox } from "./helpers.ts";

type Record_ = Record<string, any>;
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class RpcPi {
  readonly records: Record_[] = [];
  /** Answers extension dialogs. Return the response fields: `{ value }`, `{ confirmed }`, or `{ cancelled: true }`. */
  answer: (request: Record_) => Record_ = () => ({ cancelled: true });
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader = new JsonlReader();
  private readonly waiters = new Set<{ test: (record: Record_) => boolean; resolve: (record: Record_) => void }>();
  private nextId = 0;
  stderr = "";

  constructor(box: Sandbox, args: string[] = []) {
    this.child = spawn(
      process.execPath,
      [PI_CLI, "--mode", "rpc", "--offline", "-e", ROOT, "-e", FIXTURE, "--model", "pistack-faux/fixture", ...args],
      { cwd: box.cwd, env: cleanEnv(box.agentDir) },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.reader.push(chunk, (record) => this.receive(record as Record_)));
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString("utf8")));
  }

  private receive(record: Record_): void {
    this.records.push(record);
    if (record.type === "extension_ui_request" && DIALOGS.has(record.method)) {
      this.send({ type: "extension_ui_response", id: record.id, ...this.answer(record) });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.test(record)) {
        this.waiters.delete(waiter);
        waiter.resolve(record);
      }
    }
  }

  send(record: Record_): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Resolve with the first record, from `since` on, that passes `test`. */
  waitFor(test: (record: Record_) => boolean, options: { since?: number; timeoutMs?: number } = {}): Promise<Record_> {
    const seen = this.records.slice(options.since ?? 0).find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve: (record: Record_) => (clearTimeout(timer), resolve(record)) };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for an RPC record.\nLast records:\n${this.records.slice(-8).map((r) => JSON.stringify(r).slice(0, 400)).join("\n")}\nstderr:\n${this.stderr}`));
      }, options.timeoutMs ?? 30_000);
      this.waiters.add(waiter);
    });
  }

  async command(record: Record_): Promise<Record_> {
    const id = `t${++this.nextId}`;
    const since = this.records.length;
    this.send({ ...record, id });
    return this.waitFor((r) => r.type === "response" && r.id === id, { since });
  }

  /** Send a prompt and wait until pi settles (for runs) or the command was handled. */
  async prompt(message: string): Promise<{ since: number; response: Record_ }> {
    const since = this.records.length;
    const response = await this.command({ type: "prompt", message });
    if (response.data?.disposition === "started") await this.waitFor((r) => r.type === "agent_settled", { since });
    return { since, response };
  }

  ui(method: string, since = 0): Record_[] {
    return this.records.slice(since).filter((record) => record.type === "extension_ui_request" && record.method === method);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 10_000);
      this.child.on("close", () => (clearTimeout(timer), resolve()));
    });
  }
}
