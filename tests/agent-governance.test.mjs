import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const roles = ["issue-challenger", "axiom", "product-ux-reviewer"];

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


test("reusable governance resolves ticket and planning context at handoff", () => {
  const lifecycle = read("AGENTS.md").split("## Delivery lifecycle\n")[1]?.split("## Verification\n")[0];
  assert.ok(lifecycle);
  for (const text of [lifecycle, read("docs/agent-governance.md"), ...roles.map(role => read(`.agents/${role}.md`))]) {
    assert.doesNotMatch(text, /(?:#|\/issues\/)\d+|roadmap[-\w]*\.md/i);
  }
});

test("Axiom requires a justified, revision-bound product review only for material user impact", () => {
  const guide = read("AGENTS.md");
  const axiom = read(".agents/axiom.md");
  const specialist = read(".agents/product-ux-reviewer.md");
  const handoff = read("docs/agent-governance.md");
  assert.match(guide, /Axiom must assess whether the diff needs a separate/);
  assert.match(guide, /An absent or incomplete specialist review makes the code verdict REVIEW INCOMPLETE/);
  assert.match(axiom, /Product & UX review: REQUIRED \/ NOT REQUIRED/);
  assert.match(axiom, /A touched UI\/docs file alone is not a trigger/);
  assert.match(axiom, /If REQUIRED, request a fresh, independent/);
  assert.match(axiom, /even when technical checks pass/);
  assert.match(specialist, /smallest viable alternative, including no change/);
  assert.match(specialist, /public JSON\/API consumers separately/);
  assert.match(specialist, /APPROVED \/ CHANGES REQUIRED \/ REVIEW INCOMPLETE/);
  assert.match(specialist, /not Axiom approval, CI clearance, issue closure or merge authorization/);
  assert.match(handoff, /Axiom returns REVIEW INCOMPLETE when a required specialist review/);
  assert.match(handoff, /No agent is automatically dispatched/);
  assert.match(handoff, /\*\*Conditional product review \(only when Axiom requires it\):\*\*/);
});
