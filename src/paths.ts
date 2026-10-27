import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PSTACK_DIR = join(PACKAGE_ROOT, "pstack");
export const SKILLS_DIR = join(PSTACK_DIR, "skills");
export const AGENTS_DIR = join(PSTACK_DIR, "agents");
export const ADAPTER_PATH = join(PSTACK_DIR, "docs", "harness", "pi.md");
export const TEAM_KIT_SKILLS_DIR = join(PACKAGE_ROOT, "cursor-team-kit", "skills");
export const POTETO_SKILL = join(SKILLS_DIR, "poteto-mode", "SKILL.md");

/** `~/.pi/agent/pstack`, honoring PI_CODING_AGENT_DIR. */
export function configDir(): string {
  return join(getAgentDir(), "pstack");
}

export function userModelsFile(): string {
  return join(configDir(), "models.md");
}

export function projectModelsFile(cwd: string): string {
  return join(cwd, ".pi", "pstack", "models.md");
}

/** The tstack-era role file, offered as an import source by /setup-pstack. */
export function legacyModelsFile(): string {
  return join(getAgentDir(), "tstack", "models.md");
}

/** Cursor's "agent store": a scratch directory owned by one agent session. */
export function storeDir(sessionId: string): string {
  return join(configDir(), "store", sessionId);
}

/** Subagent sessions spawned by one parent session. */
export function childSessionsDir(parentSessionId: string): string {
  return join(configDir(), "agents", parentSessionId);
}

let principleCache: string[] | undefined;

/** Principle slugs without the `principle-` prefix, from the shipped skills. */
export function principleSlugs(): string[] {
  if (!principleCache) {
    principleCache = existsSync(SKILLS_DIR)
      ? readdirSync(SKILLS_DIR)
          .filter((name) => name.startsWith("principle-") && existsSync(join(SKILLS_DIR, name, "SKILL.md")))
          .map((name) => name.slice("principle-".length))
          .sort()
      : [];
  }
  return principleCache;
}

export function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}
