// `pistack_ask`: Cursor's `AskQuestion` through pi's native dialogs (TUI and RPC clients).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OTHER = "Other (type an answer)";
const DONE = "Done";

const AskParams = Type.Object(
  {
    title: Type.Optional(Type.String({ description: "Heading shown above the questions." })),
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({ description: "Key for this question's answer." }),
          prompt: Type.String({ description: "The question." }),
          options: Type.Array(
            Type.Object({ id: Type.String(), label: Type.String() }, { additionalProperties: false }),
            { minItems: 1, maxItems: 12 },
          ),
          allow_multiple: Type.Optional(Type.Boolean({ description: "Let the user pick several options." })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  { additionalProperties: false },
);

interface Answer {
  option_ids: string[];
  labels: string[];
  other?: string;
}

export const NO_UI_ANSWER =
  "No one can answer pistack_ask in this mode (print, JSON, or a subagent). Ask the question in plain text in your reply, then stop and wait, or proceed on a stated assumption if the brief allows it.";

export function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pistack_ask",
    label: "pistack ask",
    description:
      "Ask the user one or more multiple-choice questions in pi's UI (Cursor's `AskQuestion`). Each question has an id, a prompt, options of { id, label }, and optional allow_multiple. Users can also type their own answer.",
    promptSnippet: "Ask the user multiple-choice questions (Cursor's AskQuestion)",
    parameters: AskParams,
    exposure: "model-only",
    defaultActive: false,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI || process.env.PISTACK_CHILD === "1") {
        return { content: [{ type: "text", text: NO_UI_ANSWER }], details: { answered: false } };
      }
      const answers: Record<string, Answer> = {};
      for (const [index, question] of params.questions.entries()) {
        const heading = [params.title, params.questions.length > 1 ? `(${index + 1}/${params.questions.length})` : ""].filter(Boolean).join(" ");
        const title = heading ? `${heading}\n${question.prompt}` : question.prompt;
        const answer: Answer = { option_ids: [], labels: [] };
        if (question.allow_multiple) {
          for (;;) {
            const choices = question.options.map((option) => `${answer.option_ids.includes(option.id) ? "☑" : "☐"} ${option.label}`);
            const picked = await ctx.ui.select(title, [...choices, OTHER, DONE]);
            if (picked === undefined) return dismissed(answers);
            if (picked === DONE) break;
            if (picked === OTHER) {
              const typed = await ctx.ui.input(question.prompt, "Your answer");
              if (typed?.trim()) answer.other = typed.trim();
              continue;
            }
            const option = question.options[choices.indexOf(picked)];
            if (!option) continue;
            const at = answer.option_ids.indexOf(option.id);
            if (at === -1) {
              answer.option_ids.push(option.id);
              answer.labels.push(option.label);
            } else {
              answer.option_ids.splice(at, 1);
              answer.labels.splice(at, 1);
            }
          }
        } else {
          const picked = await ctx.ui.select(title, [...question.options.map((option) => option.label), OTHER]);
          if (picked === undefined) return dismissed(answers);
          if (picked === OTHER) {
            const typed = await ctx.ui.input(question.prompt, "Your answer");
            if (typed === undefined) return dismissed(answers);
            answer.other = typed.trim();
          } else {
            const option = question.options.find((candidate) => candidate.label === picked)!;
            answer.option_ids.push(option.id);
            answer.labels.push(option.label);
          }
        }
        answers[question.id] = answer;
      }
      const text = params.questions
        .map((question) => {
          const answer = answers[question.id];
          const parts = [...answer.labels.map((label, i) => `${label} [${answer.option_ids[i]}]`), ...(answer.other ? [`"${answer.other}" (typed)`] : [])];
          return `${question.id}: ${parts.join(", ") || "(no selection)"}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }], details: { answered: true, answers } as unknown as Record<string, unknown> };
    },
  });
}

function dismissed(partial: Record<string, Answer>) {
  return {
    content: [{ type: "text" as const, text: "The user dismissed the question without answering. Do not repeat it unprompted; continue on a stated assumption or ask in plain text." }],
    details: { answered: false, partial } as unknown as Record<string, unknown>,
  };
}
