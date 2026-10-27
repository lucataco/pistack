// Run real pi processes against the faux provider in a throwaway agent dir and workspace.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonlReader } from "../../src/agents/spawn.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
export const FIXTURE = join(ROOT, "test", "fixtures", "faux.ts");

export interface Sandbox {
  root: string;
  agentDir: string;
  cwd: string;
  cleanup(): void;
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

export function sandbox(options: { git?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pistack-e2e-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (options.git) {
    git(cwd, "init", "-q", "-b", "main");
    writeFileSync(join(cwd, "README.md"), "fixture\n");
    git(cwd, "add", "README.md");
    git(cwd, "-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init");
  }
  return { root, agentDir, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface PiRun {
  code: number | null;
  events: Record<string, any>[];
  stderr: string;
  /** Text of every assistant message, in order. */
  replies: string[];
  final: string;
}

/** A clean environment: none of the developer's PI_* or PISTACK_* settings leak into a test. */
export function cleanEnv(agentDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PI_") && !key.startsWith("PISTACK_")) env[key] = value;
  }
  return { ...env, PI_CODING_AGENT_DIR: agentDir, ...extra };
}

export function runPi(box: Sandbox, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<PiRun> {
  const argv = [PI_CLI, "--mode", "json", "-p", "--offline", "-e", ROOT, "-e", FIXTURE, "--model", "pistack-faux/fixture", ...args];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, { cwd: box.cwd, env: cleanEnv(box.agentDir, options.env), stdio: ["ignore", "pipe", "pipe"] });
    const events: Record<string, any>[] = [];
    const reader = new JsonlReader();
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out.\nstderr:\n${stderr}`));
    }, options.timeoutMs ?? 90_000);
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk, (record) => events.push(record as Record<string, any>)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      reader.end((record) => events.push(record as Record<string, any>));
      const replies = events
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) =>
          (event.message.content ?? [])
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text)
            .join(""),
        );
      resolvePromise({ code, events, stderr, replies, final: replies.filter(Boolean).at(-1) ?? "" });
    });
  });
}

/** Every entry of every session file under the sandbox's agent dir (parents and subagents). */
export function sessionEntries(box: Sandbox): Record<string, any>[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl")) files.push(path);
    }
  };
  walk(box.agentDir);
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => ({ ...JSON.parse(line), __file: file })),
  );
}

export { git };
