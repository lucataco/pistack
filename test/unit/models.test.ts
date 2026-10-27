import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  ROLES,
  applyBudget,
  parseCursorSlug,
  parseModels,
  parseSpec,
  resolveSpec,
  roleSlug,
  serializeModels,
  type RegistryLike,
} from "../../src/models.ts";
import { inheritRule, invalidValues, twoModelRule } from "../../src/setup.ts";

function registry(ids: string[], withoutAuth: string[] = []): RegistryLike {
  const models = ids.map((full) => {
    const [provider, ...rest] = full.split("/");
    return { provider, id: rest.join("/") } as unknown as Model<Api>;
  });
  const authed = (model: Model<Api>) => !withoutAuth.includes(`${model.provider}/${model.id}`);
  return {
    getAvailable: () => models.filter(authed),
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: authed,
  };
}

const parent = { provider: "opencode-cf", id: "claude-opus-5-5", thinking: "high" as const };

describe("model rule file", () => {
  it("parses the tstack format: budget, panels, thinking suffixes, aliases", () => {
    const config = parseModels(
      [
        "# budget: unlimited (max)",
        "how explorer: glm-5.3:xhigh",
        "Arena runners: claude-opus-5-5:max, gpt-6.1-sol:max, glm-5.3:xhigh",
        "swarm workers: inherit-parent",
        "not a role line",
      ].join("\n"),
    );
    assert.deepEqual(config.budget, { label: "unlimited", thinking: "max" });
    assert.deepEqual(config.roles.get("how explorer"), ["glm-5.3:xhigh"]);
    assert.deepEqual(config.roles.get("arena runners"), ["claude-opus-5-5:max", "gpt-6.1-sol:max", "glm-5.3:xhigh"]);
    assert.deepEqual(config.roles.get("swarm workers"), ["inherit-parent"]);
    assert.equal(config.roles.size, 3);
  });

  it("round-trips through serializeModels in upstream role order", () => {
    const config = parseModels("swarm workers: a\nhow explorer: b\n# budget: small\ncustom role: c\n");
    const again = parseModels(serializeModels(config));
    assert.deepEqual([...again.roles.keys()], ["how explorer", "swarm workers", "custom role"]);
    assert.deepEqual(again.budget, { label: "small", thinking: "medium" });
  });

  it("tolerates a pasted Cursor .mdc header", () => {
    const config = parseModels("---\ndescription: pstack models\nalwaysApply: true\n---\nbug-fix: grok-4.7-xhigh-fast\n");
    assert.deepEqual([...config.roles.keys()], ["bug-fix"]);
  });

  it("applies a budget to real models and leaves aliases alone", () => {
    const config = applyBudget(parseModels("a: x/y:low\nb: inherit-parent\nc: z\n"), "xhigh");
    assert.deepEqual(config.roles.get("a"), ["x/y:xhigh"]);
    assert.deepEqual(config.roles.get("b"), ["inherit-parent"]);
    assert.deepEqual(config.roles.get("c"), ["z:xhigh"]);
    assert.equal(config.budget?.label, "large");
  });
});

describe("model specs", () => {
  it("splits provider, id, and thinking", () => {
    assert.deepEqual(parseSpec("anthropic/claude-x:high"), { raw: "anthropic/claude-x:high", inherit: false, base: "anthropic/claude-x", provider: "anthropic", id: "claude-x", thinking: "high" });
    assert.equal(parseSpec("auto").inherit, true);
    assert.equal(parseSpec("model:with:colons").thinking, undefined);
  });

  it("reads Cursor slugs", () => {
    assert.deepEqual(parseCursorSlug("grok-4.7-xhigh-fast"), { id: "grok-4.7", thinking: "xhigh" });
    assert.deepEqual(parseCursorSlug("claude-opus-5-5-xhigh"), { id: "claude-opus-5-5", thinking: "xhigh" });
    assert.deepEqual(parseCursorSlug("gpt-6-thinking"), { id: "gpt-6", thinking: undefined });
    assert.equal(parseCursorSlug("glm-5.3"), undefined);
  });

  it("resolves explicit providers, bare ids, and Cursor slugs to models with credentials", () => {
    const reg = registry(["opencode-cf/claude-opus-5-5", "opencode-cf/glm-5.3", "openrouter/anthropic/claude-x", "other/glm-5.3"]);
    assert.deepEqual(resolveSpec("other/glm-5.3:low", reg, parent), { provider: "other", id: "glm-5.3", thinking: "low", inherited: false });
    // A bare id prefers the parent's provider.
    assert.equal(resolveSpec("glm-5.3", reg, parent).provider, "opencode-cf");
    // Slashes may belong to the id.
    assert.deepEqual(resolveSpec("anthropic/claude-x", reg, parent), { provider: "openrouter", id: "anthropic/claude-x", thinking: "high", inherited: false });
    // Cursor slug: effort becomes thinking.
    assert.deepEqual(resolveSpec("claude-opus-5-5-xhigh", reg, parent), { provider: "opencode-cf", id: "claude-opus-5-5", thinking: "xhigh", inherited: false });
  });

  it("falls back to the parent model with a note, never to another provider's lookalike", () => {
    const reg = registry(["a/known"], ["a/known"]);
    const resolution = resolveSpec("a/known", reg, parent);
    assert.equal(resolution.inherited, true);
    assert.equal(resolution.provider, "opencode-cf");
    assert.match(resolution.note ?? "", /not available/);
  });

  it("never routes to pstack virtual models", () => {
    const reg = registry(["pstack/how-explorer", "real/how-explorer"]);
    assert.equal(resolveSpec("how-explorer", reg, parent).provider, "real");
  });

  it("uses the budget when the value has no thinking suffix", () => {
    const reg = registry(["p/m"]);
    assert.equal(resolveSpec("p/m", reg, parent, "max").thinking, "max");
    assert.equal(resolveSpec("p/m:low", reg, parent, "max").thinking, "low");
  });
});

describe("setup presets", () => {
  it("covers every upstream role and gives panels both models", () => {
    const config = twoModelRule("p/fast", "p/strong");
    assert.equal(config.roles.size, ROLES.length);
    assert.deepEqual(config.roles.get("how explorer"), ["p/fast"]);
    assert.deepEqual(config.roles.get("why synthesizer"), ["p/strong"]);
    assert.deepEqual(config.roles.get("arena runners"), ["p/strong", "p/fast"]);
    assert.ok([...inheritRule().roles.values()].every((values) => values[0] === "inherit-parent"));
  });

  it("flags values with no model", () => {
    const reg = registry(["p/fast"]);
    assert.deepEqual(invalidValues(parseModels("a: p/fast\nb: p/missing\nc: auto\n"), reg as never), ["b: p/missing"]);
  });

  it("names virtual models after roles", () => {
    assert.equal(roleSlug("reflect judgment, divergent, synthesizer"), "reflect-judgment-divergent-synthesizer");
  });
});
