import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PSTACK_DIR, SKILLS_DIR, principleSlugs } from "../../src/paths.ts";
import { pistackSection, potetoSection } from "../../src/prompt.ts";
import { citedPrinciples, expandedSkills, initialState, isPistackPath, pathsInCommand, playbookFromPath, principleFromPath } from "../../src/state.ts";
import { activeBranch, renderEntry } from "../../src/tools/sessions.ts";
import { applyTodos, formatTodos } from "../../src/tools/todo.ts";

describe("session state helpers", () => {
  it("reads skills pi expanded into a prompt", () => {
    const prompt = `<skill name="poteto-mode" location="${join(SKILLS_DIR, "poteto-mode", "SKILL.md")}">\n...\n</skill>\n\nfix it`;
    assert.deepEqual(expandedSkills(prompt), [{ name: "poteto-mode", location: join(SKILLS_DIR, "poteto-mode", "SKILL.md") }]);
  });

  it("recognizes principle and playbook files", () => {
    const principle = join(SKILLS_DIR, "principle-fix-root-causes", "SKILL.md");
    assert.equal(principleFromPath(principle), "fix-root-causes");
    assert.equal(playbookFromPath(join(SKILLS_DIR, "poteto-mode", "playbooks", "bug-fix.md")), "bug-fix");
    assert.ok(isPistackPath(principle));
    assert.ok(!isPistackPath("/etc/passwd"));
    assert.deepEqual(pathsInCommand(`cat "${principle}" | head && sed -n 1,5p a/b.md`), [principle, "a/b.md"]);
  });

  it("ships 24 principles, all cited by slug only", () => {
    const slugs = principleSlugs();
    assert.equal(slugs.length, 24);
    assert.ok(slugs.every((slug) => slug.includes("-")), "multi-word slugs keep citation matching precise");
    assert.deepEqual(citedPrinciples("principle-laziness-protocol and model-the-domain", slugs), ["laziness-protocol", "model-the-domain"]);
  });
});

describe("prompt sections", () => {
  it("lists paths and the model rule", () => {
    const section = pistackSection({
      sessionFile: "/s/x.jsonl",
      sessionDir: "/s",
      store: "/store/x",
      models: { scope: "user", path: "/m.md", text: "# budget: large\n# comment\nhow explorer: p/m\n", roles: new Map() },
    });
    assert.ok(section.includes(PSTACK_DIR));
    assert.match(section, /# budget: large\n {2}how explorer: p\/m/);
    assert.doesNotMatch(section, /# comment/);
  });

  it("tracks principles read in the poteto reminder", () => {
    assert.match(potetoSection({ ...initialState(), poteto: true }), /No principle skill has been read/);
    assert.match(potetoSection({ ...initialState(), poteto: true, playbook: "bug-fix", principlesRead: ["fix-root-causes"] }), /Current playbook: bug-fix\.\nPrinciple skills read on this branch: fix-root-causes/);
  });
});

describe("todos", () => {
  it("merges by id or replaces", () => {
    const first = applyTodos([], [{ id: "1", content: "a" }, { id: "2", content: "b" }], false);
    const merged = applyTodos(first, [{ id: "1", status: "completed" }, { id: "3", content: "c" }], true);
    assert.equal(formatTodos(merged), "1/3 completed\n[x] 1. a\n[ ] 2. b\n[ ] 3. c");
    assert.deepEqual(applyTodos(merged, [{ content: "only" }], false), [{ id: "1", content: "only", status: "pending" }]);
  });
});

describe("transcripts", () => {
  it("walks the active branch from the leaf, not file order", () => {
    const entries = [
      { type: "message", id: "a", parentId: null, message: { role: "user", content: "root" } },
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
      { type: "message", id: "c", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "kept" }] } },
    ];
    assert.deepEqual(activeBranch(entries).map((entry) => entry.id), ["a", "c"]);
  });

  it("collapses expanded skills and summarizes tool results", () => {
    assert.equal(renderEntry({ type: "message", message: { role: "user", content: '<skill name="how" location="/x">long body</skill> go' } }, false), "[user] [skill how loaded] go");
    assert.equal(renderEntry({ type: "message", message: { role: "toolResult", toolName: "bash", content: "12345" } }, false), "[tool result: bash] (5 chars)");
  });
});
