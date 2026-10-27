// The pstack model rule for pi: `~/.pi/agent/pstack/models.md`, the counterpart of Cursor's
// always-applied `~/.cursor/rules/pstack-models.mdc`. Same role labels and `# budget` line as
// upstream setup-pstack; model values use pi's `[provider/]id[:thinking]` syntax.

import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { projectModelsFile, userModelsFile } from "./paths.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const BUDGETS = [
  { label: "unlimited", thinking: "max" },
  { label: "large", thinking: "xhigh" },
  { label: "medium", thinking: "high" },
  { label: "small", thinking: "medium" },
] as const satisfies readonly { label: string; thinking: Thinking }[];

export type RoleKind = "code" | "judgment" | "panel";

/** Upstream setup-pstack's role table (step 5), in its order, with upstream's default slugs. */
export const ROLES: readonly { label: string; kind: RoleKind; defaults: string[] }[] = [
  { label: "feature, refactoring", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "bug-fix", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "perf-issue", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "hillclimb", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "judgment and prose", kind: "judgment", defaults: ["claude-opus-5-5-xhigh"] },
  { label: "hardest tasks", kind: "judgment", defaults: ["claude-opus-5-5-xhigh"] },
  { label: "how explorer", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "how explainer", kind: "judgment", defaults: ["claude-opus-5-5-xhigh"] },
  { label: "why investigators", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "why synthesizer", kind: "judgment", defaults: ["claude-opus-5-5-xhigh"] },
  { label: "reflect tooling", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "reflect judgment, divergent, synthesizer", kind: "judgment", defaults: ["claude-opus-5-5-xhigh"] },
  { label: "arena runners", kind: "panel", defaults: ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"] },
  { label: "arena cross-judge pool", kind: "panel", defaults: ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"] },
  { label: "swarm workers", kind: "code", defaults: ["grok-4.7-xhigh-fast"] },
  { label: "architect runners", kind: "panel", defaults: ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"] },
  { label: "interrogate reviewers", kind: "panel", defaults: ["claude-opus-5-5-xhigh", "grok-4.7-xhigh-fast"] },
];

export const INHERIT = "inherit-parent";
export const VIRTUAL_PROVIDER = "pstack";

export interface ModelsConfig {
  budget?: { label: string; thinking: Thinking };
  /** Role label -> model values, in file order. */
  roles: Map<string, string[]>;
}

export interface LoadedModels extends ModelsConfig {
  path?: string;
  text?: string;
  scope: "project" | "user" | "none";
}

export function isThinking(value: string | undefined): value is Thinking {
  return value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isInherit(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !v || v === INHERIT || v === "auto" || v === "inherit";
}

export function parseModels(text: string): ModelsConfig {
  const roles = new Map<string, string[]>();
  let budget: ModelsConfig["budget"];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    const budgetMatch = /^#\s*budget:\s*([a-z]+)\b/i.exec(line);
    if (budgetMatch) {
      const found = BUDGETS.find((b) => b.label === budgetMatch[1].toLowerCase());
      if (found) budget = { label: found.label, thinking: found.thinking };
      continue;
    }
    if (line.startsWith("#")) continue;
    if (/^(description|alwaysApply|globs):/.test(line)) continue; // tolerate a pasted .mdc header
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const role = line.slice(0, colon).trim().toLowerCase();
    const values = line
      .slice(colon + 1)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length) roles.set(role, values);
  }
  return { budget, roles };
}

export function serializeModels(config: ModelsConfig): string {
  const lines = [
    "# pstack model configuration for pi (pistack). One line per role. Delete a line to fall back to the skill default.",
    "# `inherit-parent` or `auto`: the role runs on the parent chat model. Alias entries in a panel list still count toward its fan-out.",
    "# Model syntax: [provider/]id[:thinking]. Thinking: off|minimal|low|medium|high|xhigh|max.",
  ];
  if (config.budget) lines.push(`# budget: ${config.budget.label} (${config.budget.thinking})`);
  const known = ROLES.map((role) => role.label);
  const ordered = [...known.filter((label) => config.roles.has(label)), ...[...config.roles.keys()].filter((label) => !known.includes(label))];
  for (const label of ordered) lines.push(`${label}: ${config.roles.get(label)!.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/** The project rule replaces the user rule when the project is trusted. */
export function loadModels(cwd: string, projectTrusted: boolean): LoadedModels {
  const candidates: { path: string; scope: "project" | "user" }[] = [];
  if (projectTrusted) candidates.push({ path: projectModelsFile(cwd), scope: "project" });
  candidates.push({ path: userModelsFile(), scope: "user" });
  for (const { path, scope } of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    return { ...parseModels(text), path, text, scope };
  }
  return { roles: new Map(), scope: "none" };
}

export interface ParsedSpec {
  raw: string;
  inherit: boolean;
  /** The value without a thinking suffix. */
  base: string;
  provider?: string;
  id: string;
  thinking?: Thinking;
}

export function parseSpec(raw: string): ParsedSpec {
  const value = raw.trim();
  if (isInherit(value)) return { raw: value, inherit: true, base: INHERIT, id: INHERIT };
  let base = value;
  let thinking: Thinking | undefined;
  const colon = value.lastIndexOf(":");
  if (colon > 0 && isThinking(value.slice(colon + 1).toLowerCase())) {
    thinking = value.slice(colon + 1).toLowerCase() as Thinking;
    base = value.slice(0, colon);
  }
  const slash = base.indexOf("/");
  if (slash > 0) return { raw: value, inherit: false, base, provider: base.slice(0, slash), id: base.slice(slash + 1), thinking };
  return { raw: value, inherit: false, base, id: base, thinking };
}

/** Cursor slugs put the effort last, before an optional `-fast`: `grok-4.7-xhigh-fast`, `claude-opus-5-5-xhigh`. */
export function parseCursorSlug(raw: string): { id: string; thinking?: Thinking } | undefined {
  let slug = raw.trim();
  let changed = false;
  if (slug.endsWith("-fast")) {
    slug = slug.slice(0, -"-fast".length);
    changed = true;
  }
  let thinking: Thinking | undefined;
  const effort = /^(.*)-(max|xhigh|high|medium|low|minimal)$/.exec(slug);
  if (effort) {
    slug = effort[1];
    thinking = effort[2] as Thinking;
    changed = true;
  }
  if (slug.endsWith("-thinking")) {
    slug = slug.slice(0, -"-thinking".length);
    changed = true;
  }
  return changed && slug ? { id: slug, thinking } : undefined;
}

export interface RegistryLike {
  getAvailable(): Model<Api>[];
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface ParentModel {
  provider?: string;
  id?: string;
  thinking?: Thinking;
}

export interface Resolution {
  provider?: string;
  id?: string;
  thinking?: Thinking;
  inherited: boolean;
  /** Set when the requested model could not be used. */
  note?: string;
}

function pick(registry: RegistryLike, id: string, preferProvider: string | undefined): Model<Api> | undefined {
  const wanted = id.toLowerCase();
  const matches = registry.getAvailable().filter((model) => model.provider !== VIRTUAL_PROVIDER && model.id.toLowerCase() === wanted);
  return matches.find((model) => model.provider === preferProvider) ?? matches[0];
}

/**
 * Turn a model value (pi spec, Cursor slug, or alias) into a physical model with credentials.
 * Unavailable models fall back to the parent model with a note, never to an unrelated provider.
 */
export function resolveSpec(raw: string | undefined, registry: RegistryLike, parent: ParentModel, budget?: Thinking): Resolution {
  const inherit: Resolution = { provider: parent.provider, id: parent.id, thinking: parent.thinking, inherited: true };
  if (!raw || isInherit(raw)) return inherit;
  const spec = parseSpec(raw);
  const thinkingFor = (explicit?: Thinking) => explicit ?? spec.thinking ?? budget ?? parent.thinking;
  if (spec.provider) {
    const model = registry.find(spec.provider, spec.id);
    if (model && model.provider !== VIRTUAL_PROVIDER && registry.hasConfiguredAuth(model)) {
      return { provider: model.provider, id: model.id, thinking: thinkingFor(), inherited: false };
    }
  }
  // A slash may belong to the id itself (OpenRouter's `anthropic/claude-x`), so try the whole value as an id.
  const direct = pick(registry, spec.base, parent.provider);
  if (direct) return { provider: direct.provider, id: direct.id, thinking: thinkingFor(), inherited: false };
  if (spec.provider) {
    const byId = pick(registry, spec.id, parent.provider);
    if (byId) return { provider: byId.provider, id: byId.id, thinking: thinkingFor(), inherited: false };
  }
  const slug = parseCursorSlug(spec.provider ? spec.id : spec.base);
  if (slug) {
    const model = pick(registry, slug.id, parent.provider);
    if (model) return { provider: model.provider, id: model.id, thinking: thinkingFor(slug.thinking), inherited: false };
  }
  return { ...inherit, note: `model "${raw}" is not available with your credentials; using the parent model` };
}

export function formatResolution(resolution: Resolution): string {
  const name = resolution.provider && resolution.id ? `${resolution.provider}/${resolution.id}` : "the parent model";
  return resolution.thinking ? `${name} (${resolution.thinking})` : name;
}

/** Set the effort of every real model to the budget level; aliases stay. */
export function applyBudget(config: ModelsConfig, thinking: Thinking): ModelsConfig {
  const roles = new Map<string, string[]>();
  for (const [role, values] of config.roles) {
    roles.set(
      role,
      values.map((value) => (isInherit(value) ? value : `${parseSpec(value).base}:${thinking}`)),
    );
  }
  const budget = BUDGETS.find((b) => b.thinking === thinking);
  return { budget: budget ? { label: budget.label, thinking: budget.thinking } : config.budget, roles };
}

export function roleValues(config: ModelsConfig, role: string): string[] | undefined {
  return config.roles.get(role.trim().toLowerCase());
}

export function roleSlug(role: string): string {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
