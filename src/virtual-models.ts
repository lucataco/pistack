// Each configured single-model role becomes a virtual model, `pstack/<role>`, that routes every
// request to the role's physical model and thinking level. `/model pstack/how-explainer` and
// `pi --model pstack/swarm-workers` then follow the model rule, and edits apply on the next request.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VIRTUAL_PROVIDER, isInherit, resolveSpec, roleSlug, type ModelsConfig, type Thinking } from "./models.ts";

export class VirtualModels {
  private readonly registered = new Map<string, string>();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  ids(): string[] {
    return [...this.registered.keys()].map((id) => `${VIRTUAL_PROVIDER}/${id}`);
  }

  sync(config: ModelsConfig): void {
    if (process.env.PISTACK_VIRTUAL_MODELS === "0") return;
    const wanted = new Map<string, { role: string; value: string }>();
    for (const [role, values] of config.roles) {
      const value = values[0];
      if (value && !isInherit(value)) wanted.set(roleSlug(role), { role, value });
    }
    for (const id of [...this.registered.keys()]) {
      if (wanted.has(id)) continue;
      this.pi.unregisterVirtualModel(VIRTUAL_PROVIDER, id);
      this.registered.delete(id);
    }
    const budget = config.budget?.thinking;
    for (const [id, { role, value }] of wanted) {
      const signature = `${value}|${budget ?? ""}`;
      if (this.registered.get(id) === signature) continue;
      this.pi.registerVirtualModel({
        provider: VIRTUAL_PROVIDER,
        id,
        name: `pstack · ${role}`,
        route(request, ctx) {
          // Thinking: the rule's suffix, then the budget, then the level chosen in pi.
          const resolution = resolveSpec(value, ctx.modelRegistry, { thinking: request.thinkingLevel as Thinking }, budget);
          const model = !resolution.inherited && resolution.provider && resolution.id ? ctx.modelRegistry.find(resolution.provider, resolution.id) : undefined;
          if (!model) throw new Error(`pstack role "${role}" maps to ${value}, which has no model with credentials in this pi. Run /setup-pstack.`);
          return { model, thinkingLevel: resolution.thinking ?? request.thinkingLevel };
        },
      });
      this.registered.set(id, signature);
    }
  }
}
