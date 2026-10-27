// Static checks on the package manifest, the generated pstack tree, and the docs.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SKILL_ALIASES } from "../../src/index.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function skillDirs(base: string): string[] {
  return readdirSync(base).filter((name) => existsSync(join(base, name, "SKILL.md")));
}

function frontmatter(file: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => [match[1], match[2].trim()]),
  );
}

describe("package manifest", () => {
  it("is a pi package with one extension entry and both skill trees", () => {
    assert.ok(pkg.keywords.includes("pi-package"));
    assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
    assert.deepEqual(pkg.pi.skills, ["./pstack/skills", "./cursor-team-kit/skills"]);
    for (const peer of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      assert.equal(pkg.peerDependencies[peer], "*", `${peer} is a "*" peer, as pi's packages doc requires`);
    }
    for (const file of pkg.files) assert.ok(existsSync(join(ROOT, file)), `${file} listed in files exists`);
  });
});

describe("generated pstack tree", () => {
  const skills = skillDirs(join(ROOT, "pstack", "skills"));

  it("ships all 58 upstream pstack skills and the 3 team-kit skills", () => {
    assert.equal(skills.length, 58);
    assert.deepEqual(skillDirs(join(ROOT, "cursor-team-kit", "skills")).sort(), ["control-cli", "control-ui", "deslop"]);
  });

  it("keeps skill names equal to their directories, as pi requires", () => {
    for (const dir of [...skills.map((name) => join(ROOT, "pstack", "skills", name)), ...skillDirs(join(ROOT, "cursor-team-kit", "skills")).map((name) => join(ROOT, "cursor-team-kit", "skills", name))]) {
      const meta = frontmatter(join(dir, "SKILL.md"));
      assert.equal(meta.name, dir.split("/").pop(), dir);
      assert.ok(meta.description, `${dir} has a description`);
    }
  });

  it("resolves every relative markdown link inside the shipped trees", () => {
    const broken: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (name.name.endsWith(".md")) {
          const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
          for (const match of text.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
            const target = match[1];
            // Skip URLs and template placeholders such as `[PR #123](url)` in upstream output formats.
            if (/^[a-z]+:/i.test(target) || target.startsWith("<") || target.includes("{") || !/[./]/.test(target)) continue;
            if (!existsSync(resolve(dirname(path), decodeURIComponent(target)))) broken.push(`${path.slice(ROOT.length + 1)} -> ${target}`);
          }
        }
      }
    };
    walk(join(ROOT, "pstack"));
    walk(join(ROOT, "cursor-team-kit"));
    assert.deepEqual(broken, []);
  });

  it("documents every pistack tool in the pi adapter", () => {
    const adapter = readFileSync(join(ROOT, "pstack", "docs", "harness", "pi.md"), "utf8");
    for (const tool of ["pistack_agent", "pistack_agents", "pistack_ask", "pistack_todo", "pistack_loop", "pistack_sessions"]) {
      assert.ok(adapter.includes(tool), `${tool} is in the adapter`);
    }
  });

  it("only aliases skills that exist", () => {
    for (const name of SKILL_ALIASES) assert.ok(skills.includes(name), name);
  });
});
