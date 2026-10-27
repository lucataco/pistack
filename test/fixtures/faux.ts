// Deterministic provider for end-to-end tests: real pi processes (parents and subagents), scripted
// replies, zero tokens, no network. Each reply depends only on the transcript, so the same script
// drives parents and children.

import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textOf(message: Message | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) => (part?.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

/** The sections and tools in effect at the end of the transcript. */
export function currentView(messages: readonly Message[]): { sections: Record<string, string>; tools: string[] } {
  const sections: Record<string, string> = {};
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[name];
      else sections[name] = value;
    }
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { sections, tools: [...tools].sort() };
}

const call = (name: string, args: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function reply(messages: readonly Message[]): AssistantMessage {
  const turns = messages.filter((message) => message.role !== "system");
  const last = turns.at(-1);
  const text = textOf(last);
  const view = currentView(messages);
  const depth = process.env.PISTACK_DEPTH ?? "0";

  if (last?.role === "toolResult") {
    if (text.includes("E2E_STOP_AFTER_TOOL")) return fauxAssistantMessage("E2E_DONE");
    return fauxAssistantMessage(`AFTER_${last.toolName} depth=${depth}: ${text.slice(0, 4_000)}`);
  }

  // Subagent briefs.
  if (text.includes("E2E_CHILD_ECHO")) {
    return fauxAssistantMessage(`E2E_CHILD_OK depth=${depth} readonly=${process.env.PISTACK_READONLY} tools=${view.tools.join(",")}`);
  }
  if (text.includes("E2E_CHILD_WRITE")) return call("bash", { command: "touch e2e-should-not-exist" });
  if (text.includes("E2E_CHILD_COMMIT")) {
    return call("bash", { command: "echo hi > wt.txt && git add wt.txt && git -c user.email=e2e@example.com -c user.name=e2e commit -qm wt && echo committed" });
  }
  if (text.includes("E2E_CHILD_SPAWN")) return call("pistack_agent", { description: "grandchild", prompt: "E2E_CHILD_ECHO" });

  // pistack messages that start or continue runs.
  if (text.includes("pistack check:")) {
    const path = /`([^`]+principle-[^`]+SKILL\.md)`/.exec(text)?.[1];
    return path ? call("read", { path }) : fauxAssistantMessage("E2E_NO_PATH");
  }
  if (text.includes("pistack loop, iteration")) return call("bash", { command: "touch loop.flag" });
  if (/pistack agent [0-9a-f]+ .*: done/.test(text)) return fauxAssistantMessage(`E2E_BG_DELIVERED ${text.includes("E2E_CHILD_OK") ? "with-reply" : "no-reply"}`);

  // Scenarios started by a test prompt.
  if (text.includes("E2E_STATE")) {
    return fauxAssistantMessage(
      `E2E_STATE_REPLY ${JSON.stringify({
        sections: Object.keys(view.sections).sort(),
        pistackSection: view.sections.pistack ?? null,
        potetoSection: view.sections["poteto-mode"] ?? null,
        tools: view.tools,
      })}`,
    );
  }
  if (text.includes("E2E_FOREGROUND")) return call("pistack_agent", { description: "echo child", prompt: "E2E_CHILD_ECHO", readonly: true });
  if (text.includes("E2E_CURSOR_TASK")) {
    // Cursor `Task` field names, as upstream skills write them.
    return call("pistack_agent", { description: "cursor-style child", prompt: "E2E_CHILD_ECHO", subagent_type: "generalPurpose", readonly: true });
  }
  if (text.includes("E2E_BACKGROUND")) return call("pistack_agent", { description: "background child", prompt: "E2E_CHILD_ECHO", run_in_background: true });
  if (text.includes("E2E_READONLY")) return call("pistack_agent", { description: "read-only child", prompt: "E2E_CHILD_WRITE", readonly: true });
  if (text.includes("E2E_WORKTREE")) return call("pistack_agent", { description: "worktree child", prompt: "E2E_CHILD_COMMIT", isolation: "worktree" });
  if (text.includes("E2E_NESTED")) return call("pistack_agent", { description: "nesting child", prompt: "E2E_CHILD_SPAWN" });
  if (text.includes("E2E_ROLE")) return call("pistack_agent", { description: "role child", prompt: "E2E_CHILD_ECHO", role: "how explorer" });
  if (text.includes("E2E_LOOP")) return call("pistack_loop", { action: "start", until: "test -f loop.flag", max_iterations: 3 });
  if (text.includes("E2E_CITATION")) return fauxAssistantMessage("Root cause found. This follows principle-fix-root-causes.");
  if (text.includes("E2E_ASK")) return call("pistack_ask", { questions: [{ id: "q", prompt: "Pick one", options: [{ id: "a", label: "A" }] }] });
  if (text.includes("E2E_SESSIONS_READ")) return call("pistack_sessions", { action: "read" });
  if (text.includes("E2E_SESSIONS_OUTSIDE")) return call("pistack_sessions", { action: "read", file: process.env.E2E_OUTSIDE_FILE ?? "/nonexistent.jsonl" });
  if (text.includes("E2E_SESSIONS")) return call("pistack_sessions", { action: "current" });
  if (text.includes("E2E_TODO")) {
    return call("pistack_todo", { todos: [{ id: "1", content: "first", status: "in_progress" }, { id: "2", content: "second" }] });
  }
  return fauxAssistantMessage(`E2E_ECHO ${text.slice(0, 200)}`);
}

export default function fixture(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: "pistack-faux", api: "pistack-faux", models: [{ id: "fixture", reasoning: true }, { id: "other", reasoning: true }] });
  faux.setResponses(Array.from({ length: 200 }, () => (context) => reply(context.messages)));
  pi.registerProvider(faux.provider);
}
