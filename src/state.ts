import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, isInside } from "./paths.ts";

export const STATE_ENTRY = "pistack-state";

export interface SessionState {
  /** Sticky poteto mode (Cursor's Custom Mode): a reminder on every turn. */
  poteto: boolean;
  /** A pstack skill is in use on this branch, so pistack's tools and context are active. */
  engaged: boolean;
  /** Principle slugs whose leaf skill was read on this branch. */
  principlesRead: string[];
  /** The poteto-mode playbook read most recently. */
  playbook?: string;
}

export function initialState(): SessionState {
  return { poteto: false, engaged: false, principlesRead: [] };
}

/** Session state persisted as custom entries, so it follows /tree and /fork and survives compaction. */
export class StateStore {
  state: SessionState = initialState();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  restore(ctx: ExtensionContext): void {
    let latest: SessionState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data && typeof entry.data === "object") {
        latest = entry.data as SessionState;
      }
    }
    this.state = latest
      ? { ...initialState(), ...latest, principlesRead: [...(latest.principlesRead ?? [])] }
      : initialState();
  }

  update(patch: Partial<SessionState>): boolean {
    const next: SessionState = { ...this.state, ...patch };
    if (patch.principlesRead) next.principlesRead = [...new Set(patch.principlesRead)].sort();
    if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
    this.state = next;
    this.pi.appendEntry(STATE_ENTRY, next);
    return true;
  }

  markPrincipleRead(slug: string): boolean {
    if (this.state.principlesRead.includes(slug)) return false;
    return this.update({ principlesRead: [...this.state.principlesRead, slug] });
  }
}

const SKILL_BLOCK = /<skill name="([^"]+)" location="([^"]+)">/g;

/** Skills pi expanded into a prompt (`/skill:name` produces `<skill name=… location=…>`). */
export function expandedSkills(prompt: string): { name: string; location: string }[] {
  return [...prompt.matchAll(SKILL_BLOCK)].map((match) => ({ name: match[1], location: match[2] }));
}

export function isPistackPath(path: string): boolean {
  return isInside(path, PACKAGE_ROOT);
}

export function principleFromPath(path: string): string | undefined {
  return /principle-([a-z0-9-]+)[\\/]SKILL\.md$/.exec(path)?.[1];
}

export function playbookFromPath(path: string): string | undefined {
  return /poteto-mode[\\/]playbooks[\\/]([a-z0-9-]+)\.md$/.exec(path)?.[1];
}

/** Paths of pstack files a shell command reads, such as `cat …/principle-x/SKILL.md`. */
export function pathsInCommand(command: string): string[] {
  return [...command.matchAll(/[^\s'"`;|&<>()]+\.md\b/g)].map((match) => match[0]);
}

/** Principle slugs a reply cites, as `principle-x`, `x`, or in prose with hyphens. */
export function citedPrinciples(text: string, slugs: readonly string[]): string[] {
  const cited: string[] = [];
  for (const slug of slugs) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\w-])(?:principle-)?${escaped}(?![\\w-])`, "i").test(text)) cited.push(slug);
  }
  return cited;
}
