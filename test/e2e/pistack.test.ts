// End-to-end: real pi 1.4 processes, real subagent processes, the faux provider. No tokens, no network.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { git, runPi, sandbox, sessionEntries, type Sandbox } from "./helpers.ts";

const PISTACK_TOOLS = ["pistack_agent", "pistack_agents", "pistack_ask", "pistack_loop", "pistack_sessions", "pistack_todo"];

function stateReply(final: string): { sections: string[]; pistackSection: string | null; potetoSection: string | null; tools: string[] } {
  const json = /E2E_STATE_REPLY (\{.*\})$/s.exec(final)?.[1];
  assert.ok(json, `expected a state reply, got: ${final}`);
  return JSON.parse(json);
}

describe("pistack e2e", { concurrency: false }, () => {
  let box: Sandbox | undefined;
  afterEach(() => {
    box?.cleanup();
    box = undefined;
  });

  it("stays out of the way until a pstack skill is used", async () => {
    box = sandbox();
    const run = await runPi(box, ["--", "E2E_STATE"]);
    assert.equal(run.code, 0, run.stderr);
    const state = stateReply(run.final);
    assert.equal(state.pistackSection, null);
    assert.deepEqual(state.tools.filter((tool) => tool.startsWith("pistack_")), []);
  });

  it("engages on /skill:poteto-mode: prompt section and tools before the first request", async () => {
    box = sandbox();
    const run = await runPi(box, ["--", "/skill:poteto-mode E2E_STATE"]);
    assert.equal(run.code, 0, run.stderr);
    const state = stateReply(run.final);
    assert.match(state.pistackSection ?? "", /Pi adapter: `.*pstack\/docs\/harness\/pi\.md`/);
    assert.equal(state.potetoSection, null, "a one-off skill run is not sticky mode");
    for (const tool of PISTACK_TOOLS) assert.ok(state.tools.includes(tool), `${tool} should be active`);
  });

  it("--poteto turns on sticky mode with its reminder section", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_STATE"]);
    assert.equal(run.code, 0, run.stderr);
    const state = stateReply(run.final);
    assert.match(state.potetoSection ?? "", /Poteto mode is on/);
    assert.ok(state.pistackSection);
    const saved = sessionEntries(box).filter((entry) => entry.type === "custom" && entry.customType === "pistack-state");
    assert.equal(saved.at(-1)?.data.poteto, true);
  });

  it("runs a read-only foreground subagent as a separate pi process", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_FOREGROUND"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.final, /^AFTER_pistack_agent depth=0: pistack agent [0-9a-f]{8} \(general-purpose, read-only\): done/);
    const tools = /E2E_CHILD_OK depth=1 readonly=1 tools=(\S+)/.exec(run.final)?.[1]?.split(",");
    assert.ok(tools, run.final);
    assert.ok(!tools.includes("edit") && !tools.includes("write"), "read-only children lose edit and write");
    assert.ok(!tools.includes("pistack_agent") && !tools.includes("pistack_ask") && !tools.includes("pistack_loop"));
    for (const tool of ["read", "grep", "find", "ls", "bash", "pistack_todo", "pistack_sessions"]) assert.ok(tools.includes(tool), tool);
    const childSessions = sessionEntries(box).filter((entry) => entry.type === "session" && entry.__file.includes(join("pstack", "agents")));
    assert.equal(childSessions.length, 1, "the child keeps its own transcript under pstack/agents");
  });

  it("accepts Cursor Task field names (subagent_type: generalPurpose, run_in_background)", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_CURSOR_TASK"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.final, /\(general-purpose, read-only\): done/);
    assert.match(run.final, /E2E_CHILD_OK depth=1/);
  });

  it("delivers a background agent's completion before a print run exits", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_BACKGROUND"]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.replies.some((reply) => /^AFTER_pistack_agent depth=0: Started background agent [0-9a-f]{8}/.test(reply)), run.replies.join("\n---\n"));
    assert.equal(run.final, "E2E_BG_DELIVERED with-reply");
  });

  it("blocks file-changing commands in read-only subagents", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_READONLY"]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!existsSync(join(box.cwd, "e2e-should-not-exist")), "the blocked command must not run");
    assert.match(run.final, /AFTER_bash depth=1: This subagent is read-only, and that command runs touch\./);
  });

  it("isolates a subagent in a git worktree and keeps its commits", async () => {
    box = sandbox({ git: true });
    const run = await runPi(box, ["--poteto", "--", "E2E_WORKTREE"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.final, /Worktree: .*\.pi\/worktrees\/[0-9a-f]{8} on branch pistack\/[0-9a-f]{8}: kept: 1 commit on pistack\/[0-9a-f]{8}/);
    assert.ok(!existsSync(join(box.cwd, "wt.txt")), "the parent checkout is untouched");
    const branch = git(box.cwd, "branch", "--list", "pistack/*").replace(/^[*+ ]+/, "");
    assert.match(branch, /^pistack\/[0-9a-f]{8}$/);
    assert.equal(git(box.cwd, "show", `${branch}:wt.txt`), "hi");
    assert.equal(git(box.cwd, "status", "--porcelain"), "", ".pi/worktrees is excluded from the parent's git status");
  });

  it("nests subagents up to PISTACK_MAX_DEPTH", async () => {
    box = sandbox();
    const nested = await runPi(box, ["--poteto", "--", "E2E_NESTED"]);
    assert.equal(nested.code, 0, nested.stderr);
    assert.match(nested.final, /E2E_CHILD_OK depth=2/);

    const limited = await runPi(box, ["--poteto", "--", "E2E_NESTED"], { env: { PISTACK_MAX_DEPTH: "1" } });
    assert.equal(limited.code, 0, limited.stderr);
    assert.doesNotMatch(limited.final, /E2E_CHILD_OK depth=2/);
    assert.match(limited.final, /AFTER_pistack_agent depth=1: Tool pistack_agent not found/, "a child at the depth limit has no spawn tool");
  });

  it("runs a bounded loop until its shell predicate passes", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_LOOP"]);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(existsSync(join(box.cwd, "loop.flag")));
    const notes = sessionEntries(box)
      .filter((entry) => entry.type === "custom_message" && entry.customType === "pistack-loop")
      .map((entry) => String(entry.content));
    assert.ok(notes.some((note) => note.includes("iteration 1/3")), notes.join("\n"));
    assert.ok(notes.some((note) => /Loop stopped after 1 iteration: `test -f loop.flag` exited 0/.test(note)), notes.join("\n"));
  });

  it("makes the agent read a principle it cited without reading", async () => {
    box = sandbox();
    const run = await runPi(box, ["--", "/skill:poteto-mode E2E_CITATION"]);
    assert.equal(run.code, 0, run.stderr);
    const entries = sessionEntries(box);
    const nudge = entries.find((entry) => entry.type === "custom_message" && entry.customType === "pistack-citation");
    assert.ok(nudge, "a citation nudge was added");
    assert.match(String(nudge.content), /principle-fix-root-causes\/SKILL\.md/);
    assert.match(run.final, /^AFTER_read depth=0: /);
    const state = entries.filter((entry) => entry.type === "custom" && entry.customType === "pistack-state").at(-1);
    assert.deepEqual(state?.data.principlesRead, ["fix-root-causes"]);
  });

  it("routes `--model pstack/<role>` through a saved model rule, and roles resolve for subagents", async () => {
    box = sandbox();
    mkdirSync(join(box.agentDir, "pstack"), { recursive: true });
    writeFileSync(join(box.agentDir, "pstack", "models.md"), "# budget: medium (high)\nhow explorer: pistack-faux/other:low\n");
    const run = await runPi(box, ["--model", "pstack/how-explorer", "--", "hello"]);
    assert.equal(run.code, 0, run.stderr);
    const reply = run.events.find((event) => event.type === "message_end" && event.message?.role === "assistant");
    assert.equal(`${reply?.message.provider}/${reply?.message.model}`, "pistack-faux/other");
    assert.equal(run.final, "E2E_ECHO hello");

    const role = await runPi(box, ["--poteto", "--", "E2E_ROLE"]);
    assert.equal(role.code, 0, role.stderr);
    assert.match(role.final, /Model: pistack-faux\/other \(low\), from role "how explorer" \(pistack-faux\/other:low\)/);
    assert.match(role.final, /E2E_CHILD_OK depth=1/);
  });

  it("answers pistack_ask honestly when nobody can respond", async () => {
    box = sandbox();
    const run = await runPi(box, ["--poteto", "--", "E2E_ASK"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.final, /No one can answer pistack_ask in this mode/);
  });

  it("names the transcript for pistack_sessions and tracks todos", async () => {
    box = sandbox();
    const sessions = await runPi(box, ["--poteto", "--", "E2E_SESSIONS"]);
    assert.match(sessions.final, /Current session: .*\.jsonl/);
    const todos = await runPi(box, ["--poteto", "--", "E2E_TODO"]);
    assert.match(todos.final, /0\/2 completed\n\[~\] 1\. first\n\[ \] 2\. second/);
  });
});
