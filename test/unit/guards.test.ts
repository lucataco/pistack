import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationNudge, mutatingCommand, unreadCitations } from "../../src/guards.ts";
import { parseDuration, parseLoopCommand } from "../../src/loop.ts";

describe("read-only command guard", () => {
  const readOnly = [
    "git status --porcelain",
    "git log --oneline -5 && git diff HEAD~1",
    "grep -rn foo src | head -20",
    "ls -la > /dev/null 2>&1",
    "cat package.json 2>/dev/null",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "rg TODO --json",
    "gh pr view 12 --json title",
    "gh api repos/o/r/pulls",
    "npm test",
    "git branch --list",
    "git stash list",
    "curl -s https://example.com",
    "node -e 'console.log(1)'",
  ];
  for (const command of readOnly) {
    it(`allows: ${command}`, () => assert.equal(mutatingCommand(command), undefined));
  }

  const mutating: [string, RegExp][] = [
    ["rm -rf dist", /rm/],
    ["echo hi > notes.txt", /redirect/],
    ["cat a >> b", /redirect/],
    ["git commit -m wip", /git commit/],
    ["git push origin main", /git push/],
    ["git checkout -b x", /git checkout/],
    ["git stash", /git stash/],
    ["git branch -D old", /branches/],
    ["git worktree add ../x", /worktree add/],
    ["sed -i '' s/a/b/ f.ts", /sed/],
    ["npm install left-pad", /npm install/],
    ["pnpm add x", /pnpm add/],
    ["sudo rm -rf /", /rm/],
    ["FOO=1 touch x", /touch/],
    ["ls && mv a b", /mv/],
    ["echo $(rm x)", /rm/],
    ["gh pr create --fill", /gh pr create/],
    ["gh api -X POST repos/o/r/issues", /write method/],
    ["curl -X DELETE https://api.example.com/x", /curl/],
    ["curl -d @body.json https://api.example.com", /curl/],
    ["find . | xargs rm", /rm/],
    ["perl -pi -e s/a/b/ f", /perl/],
  ];
  for (const [command, reason] of mutating) {
    it(`blocks: ${command}`, () => assert.match(mutatingCommand(command) ?? "", reason));
  }
});

describe("principle citations", () => {
  const slugs = ["fix-root-causes", "prove-it-works", "type-system-discipline"];

  it("finds cited principles that were not read", () => {
    assert.deepEqual(unreadCitations("Per principle-fix-root-causes and prove-it-works.", ["prove-it-works"], slugs), ["fix-root-causes"]);
    assert.deepEqual(unreadCitations("We fix root causes here.", [], slugs), [], "plain prose is not a citation");
    assert.deepEqual(unreadCitations("see fix-root-causes-later", [], slugs), [], "slug boundaries");
  });

  it("names the leaf skill to read", () => {
    assert.match(citationNudge(["fix-root-causes"]), /principle-fix-root-causes\/SKILL\.md/);
  });
});

describe("loop parsing", () => {
  it("parses durations", () => {
    assert.equal(parseDuration("30s"), 30_000);
    assert.equal(parseDuration("1h30m"), 5_400_000);
    assert.equal(parseDuration("soon"), undefined);
    assert.equal(parseDuration("0m"), undefined);
  });

  it("parses /pstack-loop arguments", () => {
    assert.deepEqual(parseLoopCommand("stop"), { action: "stop" });
    assert.deepEqual(parseLoopCommand(""), { action: "status" });
    assert.deepEqual(parseLoopCommand('15m until "npm test" --max 5 fix the flake'), {
      action: "start",
      every: "15m",
      until: "npm test",
      maxIterations: 5,
      prompt: "fix the flake",
    });
    assert.deepEqual(parseLoopCommand("until done keep going"), { action: "start", prompt: "keep going" });
  });
});
