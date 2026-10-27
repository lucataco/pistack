// `/setup-pstack`: upstream setup-pstack's steps with pi's native dialogs and model registry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  BUDGETS,
  INHERIT,
  ROLES,
  VIRTUAL_PROVIDER,
  applyBudget,
  isInherit,
  parseModels,
  resolveSpec,
  serializeModels,
  type ModelsConfig,
  type Thinking,
} from "./models.ts";
import { legacyModelsFile, userModelsFile } from "./paths.ts";

/** Values in the rule that do not resolve to a model with credentials. */
export function invalidValues(config: ModelsConfig, registry: ExtensionCommandContext["modelRegistry"]): string[] {
  const problems: string[] = [];
  for (const [role, values] of config.roles) {
    for (const value of values) {
      if (isInherit(value)) continue;
      if (resolveSpec(value, registry, {}).note) problems.push(`${role}: ${value}`);
    }
  }
  return problems;
}

/** Map the upstream role table onto two models: a fast one for code and a strong one for judgment. */
export function twoModelRule(fast: string, strong: string): ModelsConfig {
  const roles = new Map<string, string[]>();
  for (const role of ROLES) {
    if (role.kind === "code") roles.set(role.label, [fast]);
    else if (role.kind === "judgment") roles.set(role.label, [strong]);
    else roles.set(role.label, strong === fast ? [strong] : [strong, fast]);
  }
  return { roles };
}

export function inheritRule(): ModelsConfig {
  return { roles: new Map(ROLES.map((role) => [role.label, [INHERIT]])) };
}

export async function runSetup(ctx: ExtensionCommandContext, onSaved: (config: ModelsConfig) => void): Promise<void> {
  const file = userModelsFile();
  if (!ctx.hasUI) {
    ctx.ui.notify(`/setup-pstack needs an interactive session. Edit ${file} by hand, or run /skill:setup-pstack.`, "warning");
    return;
  }
  const available = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.provider !== VIRTUAL_PROVIDER)
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  if (!available.length) {
    ctx.ui.notify("No models have credentials in this pi. Log in with /login, then run /setup-pstack again.", "error");
    return;
  }

  const existing = existsSync(file) ? parseModels(readFileSync(file, "utf8")) : undefined;
  let config: ModelsConfig | undefined;

  const legacy = legacyModelsFile();
  if (!existing && existsSync(legacy)) {
    const imported = parseModels(readFileSync(legacy, "utf8"));
    if (imported.roles.size && (await ctx.ui.confirm("Import your tstack model rule?", `${legacy} has ${imported.roles.size} pstack role lines. Use it as the pistack model rule?`))) {
      config = imported;
    }
  }

  if (!config) {
    const current = existing?.budget?.label;
    const budgetLabels = BUDGETS.map((budget) => `${budget.label} — ${budget.thinking} reasoning`);
    const budgetPick = await ctx.ui.select(
      current ? `Reasoning budget (current: ${current})` : "Reasoning budget (large matches the skill defaults)",
      budgetLabels,
    );
    if (!budgetPick) return;
    const budget = BUDGETS[budgetLabels.indexOf(budgetPick)];

    const KEEP = "Keep my current roles and apply this budget";
    const TWO = "Two models: a fast one for code, a strong one for judgment (panels get both)";
    const INHERIT_ALL = "Every role on the parent chat model (inherit-parent)";
    const EDIT = "Write the rule myself in an editor";
    const approach = await ctx.ui.select("How should pstack pick models?", [...(existing?.roles.size ? [KEEP] : []), TWO, INHERIT_ALL, EDIT]);
    if (!approach) return;

    if (approach === KEEP) config = existing!;
    else if (approach === INHERIT_ALL) config = inheritRule();
    else if (approach === TWO) {
      const fast = await ctx.ui.select("Fast model for code, exploration, and swarm workers", [INHERIT, ...available]);
      if (!fast) return;
      const strong = await ctx.ui.select("Strong model for judgment, explanation, and synthesis", [INHERIT, ...available]);
      if (!strong) return;
      config = twoModelRule(fast, strong);
    } else {
      config = existing?.roles.size ? existing : twoModelRule(INHERIT, INHERIT);
    }
    config = applyBudget(config, budget.thinking as Thinking);
  }

  const header = `# Detected models: ${available.slice(0, 40).join(", ")}${available.length > 40 ? ", …" : ""}\n`;
  const edited = await ctx.ui.editor("Review the pstack model rule, then save", `${serializeModels(config)}${header}`);
  if (edited === undefined) {
    ctx.ui.notify("Setup cancelled; nothing was written.", "info");
    return;
  }
  const final = parseModels(edited);
  const problems = invalidValues(final, ctx.modelRegistry);
  if (problems.length) {
    const keep = await ctx.ui.confirm(
      "Some models are not available",
      `These values have no model with credentials, so their roles would run on the parent model:\n${problems.join("\n")}\n\nSave anyway?`,
    );
    if (!keep) {
      ctx.ui.notify("Nothing was written. Run /setup-pstack again to pick available models.", "info");
      return;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeModels(final));
  onSaved(final);
  ctx.ui.notify(
    `Wrote ${file} (${final.roles.size} roles${final.budget ? `, budget ${final.budget.label}` : ""}). It applies from the next turn. Want proof tooling too? /skill:create-verification-skill and /skill:create-formal-verification-skill generate project skills.`,
    "info",
  );
}
