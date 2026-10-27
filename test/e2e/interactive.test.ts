// Interactive behavior through pi's RPC mode: commands, dialogs, the status line, and background delivery.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sandbox, type Sandbox } from "./helpers.ts";
import { RpcPi } from "./rpc.ts";

describe("pistack interactive (RPC)", { concurrency: false }, () => {
  let box: Sandbox | undefined;
  let pi: RpcPi | undefined;
  afterEach(async () => {
    await pi?.close();
    box?.cleanup();
    pi = undefined;
    box = undefined;
  });

  it("toggles sticky poteto mode and shows it in the status line", async () => {
    box = sandbox();
    pi = new RpcPi(box);
    const on = await pi.prompt("/poteto-mode on");
    assert.equal(on.response.data.disposition, "handled");
    assert.ok(pi.ui("notify", on.since).some((r) => /Poteto mode on/.test(r.message)));
    const status = await pi.waitFor((r) => r.method === "setStatus" && r.statusKey === "pistack" && /poteto/.test(r.statusText ?? ""), { since: on.since });
    assert.doesNotMatch(status.statusText, /\u001b\[/, "RPC clients get plain text");

    const off = await pi.prompt("/poteto-mode off");
    assert.ok(pi.ui("notify", off.since).some((r) => /Poteto mode off/.test(r.message)));
  });

  it("runs /poteto-mode <task> and skill aliases through the skill", async () => {
    box = sandbox();
    pi = new RpcPi(box);
    const task = await pi.prompt("/poteto-mode E2E_STATE");
    const first = await pi.waitFor((r) => r.type === "agent_settled", { since: task.since });
    assert.ok(first);
    let last = await pi.command({ type: "get_last_assistant_text" });
    const state = JSON.parse(/E2E_STATE_REPLY (\{.*\})$/s.exec(last.data.text)![1]);
    assert.match(state.potetoSection, /Poteto mode is on/, "the command turns sticky mode on");
    assert.ok(state.tools.includes("pistack_agent"));

    const alias = await pi.prompt("/how E2E_STATE");
    await pi.waitFor((r) => r.type === "agent_settled", { since: alias.since });
    const messages = await pi.command({ type: "get_messages" });
    const users = messages.data.messages.filter((m: { role: string }) => m.role === "user").map((m: { content: unknown }) => JSON.stringify(m.content));
    assert.ok(users.some((text: string) => text.includes('<skill name=\\"how\\"')), "the alias expanded /skill:how");
    last = await pi.command({ type: "get_last_assistant_text" });
    assert.match(last.data.text, /^E2E_STATE_REPLY/);
  });

  it("asks pistack_ask questions through the client's dialogs", async () => {
    box = sandbox();
    pi = new RpcPi(box);
    pi.answer = (request) => (request.method === "select" ? { value: "A" } : { cancelled: true });
    await pi.prompt("/poteto-mode on");
    const run = await pi.prompt("E2E_ASK");
    const select = pi.ui("select", run.since)[0];
    assert.equal(select.title, "Pick one");
    assert.deepEqual(select.options, ["A", "Other (type an answer)"]);
    const last = await pi.command({ type: "get_last_assistant_text" });
    assert.match(last.data.text, /AFTER_pistack_ask depth=0: q: A \[a\]/);
  });

  it("writes the model rule with /setup-pstack and registers role models", async () => {
    box = sandbox();
    pi = new RpcPi(box);
    const titles: string[] = [];
    pi.answer = (request) => {
      titles.push(request.title);
      if (request.method === "select" && /budget/i.test(request.title)) return { value: request.options.find((o: string) => o.startsWith("large")) };
      if (request.method === "select" && /How should pstack pick models/.test(request.title)) return { value: request.options.find((o: string) => o.startsWith("Two models")) };
      if (request.method === "select" && /^Fast model/.test(request.title)) return { value: "pistack-faux/fixture" };
      if (request.method === "select" && /^Strong model/.test(request.title)) return { value: "pistack-faux/other" };
      if (request.method === "editor") return { value: request.prefill };
      return { cancelled: true };
    };
    const setup = await pi.prompt("/setup-pstack");
    await pi.waitFor((r) => r.method === "notify" && /Wrote /.test(r.message ?? ""), { since: setup.since });
    const file = join(box.agentDir, "pstack", "models.md");
    assert.ok(existsSync(file), titles.join(" | "));
    const rule = readFileSync(file, "utf8");
    assert.match(rule, /^# budget: large \(xhigh\)$/m);
    assert.match(rule, /^how explorer: pistack-faux\/fixture:xhigh$/m);
    assert.match(rule, /^how explainer: pistack-faux\/other:xhigh$/m);
    assert.match(rule, /^arena runners: pistack-faux\/other:xhigh, pistack-faux\/fixture:xhigh$/m);

    const models = await pi.command({ type: "get_available_models" });
    const ids = models.data.models.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`);
    assert.ok(ids.includes("pstack/how-explorer"), ids.join(", "));

    // The virtual model routes each request to the role's physical model.
    const switched = await pi.command({ type: "set_model", provider: "pstack", modelId: "how-explainer" });
    assert.equal(switched.success, true, JSON.stringify(switched));
    const run = await pi.prompt("route check");
    const reply = await pi.waitFor((r) => r.type === "message_end" && r.message?.role === "assistant", { since: run.since });
    assert.equal(`${reply.message.provider}/${reply.message.model}`, "pistack-faux/other");
  });

  it("wakes the session when a background agent finishes, with a live widget meanwhile", async () => {
    box = sandbox();
    pi = new RpcPi(box);
    await pi.prompt("/poteto-mode on");
    const since = pi.records.length;
    await pi.command({ type: "prompt", message: "E2E_BACKGROUND" });
    const delivered = await pi.waitFor(
      (r) => r.type === "message_end" && r.message?.role === "assistant" && JSON.stringify(r.message.content).includes("E2E_BG_DELIVERED with-reply"),
      { since, timeoutMs: 60_000 },
    );
    assert.ok(delivered);
    const widgets = pi.ui("setWidget", since).filter((r) => r.widgetKey === "pistack-agents");
    assert.ok(widgets.some((r) => Array.isArray(r.widgetLines) && r.widgetLines.join("\n").includes("background child")), "the widget listed the running agent");
    assert.ok(widgets.some((r) => r.widgetLines === undefined), "the widget cleared when the agent finished");

    const listed = await pi.prompt("/pstack-agents");
    assert.ok(pi.ui("notify", listed.since).some((r) => /pistack agent [0-9a-f]{8} \(general-purpose\): done/.test(r.message)));
  });
});
