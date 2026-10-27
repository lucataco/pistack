import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { childArgs, childSystemPrompt, childTools, loadAgentDefinitions, passthroughArgs } from "../../src/agents/child.ts";
import { normalizeSubagentType } from "../../src/agents/manager.ts";
import { JsonlReader } from "../../src/agents/spawn.ts";
import { ensureWorktree, planWorktree, removeCleanWorktree, settleWorktree, worktreeTaken } from "../../src/agents/worktree.ts";
import { POTETO_SKILL } from "../../src/paths.ts";
import { prepareAgentArgs } from "../../src/tools/agent.ts";

describe("child tools", () => {
  const parent = ["read", "bash", "edit", "write", "pistack_agent", "pistack_ask", "pistack_loop", "pistack_todo", "mcp__docs__search", "web_search"];

  it("inherits the parent's tools minus parent-only ones", () => {
    const tools = childTools(parent, { readonly: false, canSpawn: true });
    assert.ok(tools.includes("mcp__docs__search") && tools.includes("web_search") && tools.includes("pistack_agent"));
    assert.ok(!tools.includes("pistack_ask") && !tools.includes("pistack_loop"));
  });

  it("drops spawn tools at the depth limit", () => {
    const tools = childTools(parent, { readonly: false, canSpawn: false });
    assert.ok(!tools.includes("pistack_agent") && !tools.includes("pistack_agents"));
  });

  it("keeps only read tools and read-only-annotated tools for read-only children", () => {
    const tools = childTools(parent, { readonly: true, canSpawn: true, isReadOnlyTool: (name) => name === "web_search" });
    assert.deepEqual(tools.sort(), ["bash", "find", "grep", "ls", "pistack_sessions", "pistack_todo", "read", "web_search"]);
  });
});

describe("child launch", () => {
  it("passes resource flags through with absolute paths", () => {
    assert.deepEqual(passthroughArgs(["-e", "./ext", "--extension=npm:x", "--no-mcp", "--model", "a/b", "--skill", "s"], "/w"), [
      "-e", "/w/ext", "--extension", "npm:x", "--no-mcp", "--skill", "/w/s",
    ]);
  });

  it("ends options before the brief so it can never be read as a flag", () => {
    const args = childArgs({
      sessionDir: "/s", sessionId: "pistack-abc", model: "p/m", thinking: "high", tools: ["read", "bash"],
      systemPromptFile: "/s/abc.system.md", passthrough: ["-e", "/x"], trusted: false, prompt: "--help me", briefFile: "/s/brief.md",
    });
    const end = args.indexOf("--");
    assert.deepEqual(args.slice(end), ["--", "@/s/brief.md", "--help me"]);
    assert.ok(args.includes("--no-approve"));
    assert.deepEqual(args.slice(0, 7), ["--mode", "json", "-p", "--session-dir", "/s", "--session-id", "pistack-abc"]);
  });

  it("loads pstack's agents and gives poteto-agent the absolute skill path", () => {
    const definitions = loadAgentDefinitions();
    assert.deepEqual([...definitions.keys()].sort(), ["comment-sicko", "general-purpose", "poteto-agent"]);
    const prompt = childSystemPrompt({ id: "abc", definition: definitions.get("poteto-agent")!, depth: 1, maxDepth: 3, readonly: false, background: true });
    assert.ok(prompt.includes(POTETO_SKILL));
    assert.match(prompt, /run in the background/);
  });

  it("normalizes Cursor subagent types", () => {
    assert.equal(normalizeSubagentType("generalPurpose"), "general-purpose");
    assert.equal(normalizeSubagentType(undefined), "general-purpose");
    assert.equal(normalizeSubagentType("Poteto Agent"), "poteto-agent");
  });

  it("maps Cursor Task fields onto pistack_agent", () => {
    assert.deepEqual(
      prepareAgentArgs({
        description: "d", prompt: "p", run_in_background: true, environment: "cloud", cloud_base_branch: "main",
        file_attachments: ["a.ts"], readonly: "true", unknown_field: 1,
      }),
      { description: "d", prompt: "p", background: true, isolation: "worktree", base: "main", files: ["a.ts"], readonly: true },
    );
  });
});

describe("JSONL framing", () => {
  it("splits only on LF, joins chunks, and decodes UTF-8 across boundaries", () => {
    const records: unknown[] = [];
    const reader = new JsonlReader();
    const payload = Buffer.from(`${JSON.stringify({ a: "line\u2028sep" })}\r\n{"b":"é😀"}\nnot json\n{"c":1}`);
    for (let i = 0; i < payload.length; i += 3) reader.push(payload.subarray(i, i + 3), (record) => records.push(record));
    reader.end((record) => records.push(record));
    assert.deepEqual(records, [{ a: "line\u2028sep" }, { b: "é😀" }, { c: 1 }]);
  });
});

describe("worktrees", () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "pistack-wt-"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git("add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
    return dir;
  }

  it("removes untouched worktrees and keeps ones with commits", () => {
    const dir = repo();
    try {
      const clean = planWorktree(dir, "aaa111");
      ensureWorktree(clean);
      assert.ok(existsSync(join(clean.path, "a.txt")));
      assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /^\/\.pi\/worktrees\/$/m);
      assert.equal(settleWorktree(clean).kept, false);
      assert.ok(!existsSync(clean.path));

      const busy = planWorktree(dir, "bbb222");
      ensureWorktree(busy);
      writeFileSync(join(busy.path, "b.txt"), "b\n");
      spawnSync("git", ["add", "."], { cwd: busy.path });
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "b"], { cwd: busy.path });
      const outcome = settleWorktree(busy);
      assert.equal(outcome.kept, true);
      assert.match(outcome.summary, /1 commit on pistack\/bbb222/);
      assert.match(removeCleanWorktree(busy), /branch pistack\/bbb222 keeps 1 commit/);
      assert.ok(!existsSync(busy.path));
      assert.equal(worktreeTaken(planWorktree(dir, "bbb222")), true, "a leftover branch blocks reusing the id");
      assert.equal(worktreeTaken(planWorktree(dir, "ddd444")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pistack-nogit-"));
    try {
      assert.throws(() => planWorktree(dir, "ccc333"), /needs a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
