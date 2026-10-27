// System-prompt sections. Rebuilt before every run, so they survive compaction and follow the
// session branch; pi appends changes as transcript deltas instead of resetting the prompt cache.

import type { LoadedModels } from "./models.ts";
import { ADAPTER_PATH, POTETO_SKILL, PSTACK_DIR, TEAM_KIT_SKILLS_DIR, userModelsFile } from "./paths.ts";
import type { SessionState } from "./state.ts";

export interface PistackSectionInput {
  sessionFile?: string;
  sessionDir: string;
  store: string;
  rootStore?: string;
  models: LoadedModels;
  child?: { depth: number; maxDepth: number; readonly: boolean };
}

function modelRule(models: LoadedModels): string {
  if (models.scope === "none") {
    return `- Model rule (Cursor's \`pstack-models.mdc\`): none yet. A role runs on its skill's default model when you have that model, otherwise on the parent model. \`/setup-pstack\` writes \`${userModelsFile()}\`.`;
  }
  const lines = (models.text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith("#") || /^#\s*budget:/i.test(line)));
  return [`- Model rule (Cursor's \`pstack-models.mdc\`), from \`${models.path}\`:`, "  ```", ...lines.map((line) => `  ${line}`), "  ```"].join("\n");
}

export function pistackSection(input: PistackSectionInput): string {
  const lines = [
    "pstack is installed through pistack. pstack skills use Cursor names, so read the pi adapter once per session before you follow one. It maps them to the pistack_* tools.",
    `- \`<pstack>\` = \`${PSTACK_DIR}\`. Skills: \`<pstack>/skills/<name>/SKILL.md\`. Agents: \`<pstack>/agents/\`. Guide: \`<pstack>/docs/guide/\`.`,
    `- Pi adapter: \`${ADAPTER_PATH}\``,
    `- cursor-team-kit skills (deslop, control-ui, control-cli): \`${TEAM_KIT_SKILLS_DIR}/<name>/SKILL.md\``,
    `- Transcripts (Cursor's agent-transcripts): this session is \`${input.sessionFile ?? "(not persisted)"}\`; this workspace's sessions are in \`${input.sessionDir}\`. Read them with pistack_sessions.`,
    `- Agent store: \`${input.store}\`${input.rootStore && input.rootStore !== input.store ? `. Root agent store: \`${input.rootStore}\`` : ""}`,
    modelRule(input.models),
  ];
  if (input.child) {
    lines.push(
      `- You are a subagent at depth ${input.child.depth} of ${input.child.maxDepth}${input.child.readonly ? ", read-only" : ""}.${input.child.depth >= input.child.maxDepth ? " You cannot spawn further subagents." : ""}`,
    );
  }
  return lines.join("\n");
}

export function potetoSection(state: SessionState): string {
  const lines = [
    `Poteto mode is on (sticky, like a Cursor Custom Mode). New task? Playbook match or rigor needed → apply poteto-mode: if \`${POTETO_SKILL}\` is not in your context, read it in full first. Casual turn or the user opts out → don't. The user turns it off with \`/poteto-mode off\`.`,
  ];
  if (state.playbook) lines.push(`Current playbook: ${state.playbook}.`);
  lines.push(
    state.principlesRead.length
      ? `Principle skills read on this branch: ${state.principlesRead.join(", ")}. Cite only principles whose leaf skill you have read this session.`
      : "No principle skill has been read on this branch yet. Read a principle's leaf skill before you cite it.",
  );
  return lines.join("\n");
}
