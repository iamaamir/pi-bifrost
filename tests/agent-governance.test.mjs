import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const roles = ["issue-challenger", "axiom"];

test("governance roles declare independent file-reading tools and project context", () => {
  for (const role of roles) {
    const text = read(`.agents/${role}.md`);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(frontmatter, `${role} needs closed frontmatter`);
    assert.match(frontmatter, new RegExp(`^name: ${role}$`, "m"));
    assert.match(frontmatter, /^tools: read, grep, find, ls$/m);
    assert.match(frontmatter, /^inheritProjectContext: true$/m);
    assert.match(frontmatter, /^inheritSkills: false$/m);
    assert.match(text, /never claim/i);
    assert.doesNotMatch(text, /AGENT-DELIVERY\.md|system_one|misplaced blank line|P2.*report-only/);
  }
});

test("governance documentation resolves local links", () => {
  for (const path of ["AGENTS.md", "docs/agent-governance.md"]) {
    const base = new URL(`../${path}`, import.meta.url);
    for (const [, link] of read(path).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(link)) continue;
      assert.ok(existsSync(new URL(link.split("#")[0], base)), `${path}: missing ${link}`);
    }
  }
});

test("readiness, adjudication and review remain distinct from authorization", () => {
  const guide = read("AGENTS.md");
  const challenger = read(".agents/issue-challenger.md");
  const axiom = read(".agents/axiom.md");
  assert.match(guide, /challenge → adjudication → implementation → independent review/);
  assert.match(guide, /ACCEPT \/ REJECT \/ DEFER \/ NEEDS EVIDENCE/);
  assert.match(guide, /at most two substantive correction rounds/);
  assert.match(challenger, /READY \/ NEEDS_REVISION \/ BLOCKED \/ ALREADY_SATISFIED \/ DEFERRED/);
  assert.match(challenger, /DEFERRED cannot waive mandatory criteria/);
  assert.match(axiom, /APPROVED \/ CHANGES REQUIRED \/ REVIEW INCOMPLETE/);
  assert.match(axiom, /APPROVED permits nonblocking observations/);
  assert.match(axiom, /missing required check is a verification blocker/);
  assert.match(axiom, /code approval never authorizes merge or issue closure/);
});
