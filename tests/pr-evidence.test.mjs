import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBody, extractShas, parseArgs, revisionClaims } from "../scripts/check-pr-evidence.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HEAD = "1fd89e5de7e474f6416a6f4faebe6d2324d6d311";
const OTHER = "3b05c44ba4e1a9d37da510a9f87b738ecb666f69";
const ORIGINAL_BASE = "23ded2a58e877818a24678f996404125dcee4c7a";
const REBASED_ONTO = "4538a81edd13e463bc95eb7e7c7653ef2d23696d";

describe("revision extraction", () => {
  it("finds full and abbreviated revisions", () => {
    assert.deepEqual(extractShas("`1fd89e5de7e474f6416a6f4faebe6d2324d6d311`"), [HEAD]);
    assert.deepEqual(extractShas("`4538a81…`, then `debebc7`"), ["4538a81", "debebc7"]);
  });

  it("does not read a branch-name fragment as a revision", () => {
    assert.deepEqual(extractShas("branch fix/issue-263-23ded2a"), []);
    assert.deepEqual(extractShas("Head: 1fd89e5 (branch fix/issue-263-23ded2a)"), ["1fd89e5"]);
  });

  it("ignores template placeholders and N/A", () => {
    const claims = revisionClaims([
      "Reviewed head SHA: <!-- N/A for non-UI -->",
      "Head: N/A",
      "Base: N/A for a docs-only change",
    ].join("\n"));
    assert.deepEqual(claims, []);
  });

  it("keeps a declared revision in several real body shapes", () => {
    const claims = revisionClaims([
      `**Head:** \`${HEAD}\``,
      `- Final head: \`${OTHER}\``,
      `**Original base:** ${ORIGINAL_BASE}`,
      `**Rebased onto:** ${REBASED_ONTO}`,
      "- Rebase targets: `4538a81…`, then `debebc7`",
    ].join("\n"));
    assert.deepEqual(claims, [
      { kind: "head", label: "Head", value: HEAD },
      { kind: "head", label: "Final head", value: OTHER },
      { kind: "base", label: "Original base", value: ORIGINAL_BASE },
      { kind: "base", label: "Rebased onto", value: REBASED_ONTO },
      { kind: "base", label: "Rebase targets", value: "4538a81" },
      { kind: "base", label: "Rebase targets", value: "debebc7" },
    ]);
  });

  it("recognizes real PR label shapes", () => {
    const claims = revisionClaims([
      "Current head: 1fd89e5",
      "PR head: a158e44",
      "Original required base commit: 23ded2a58e877818a24678f996404125dcee4c7a",
      "Rebase targets on updated main: 6705ab6, then 7d453cd",
    ].join("\n"));
    assert.deepEqual(claims, [
      { kind: "head", label: "Current head", value: "1fd89e5" },
      { kind: "head", label: "PR head", value: "a158e44" },
      { kind: "base", label: "Original required base commit", value: "23ded2a58e877818a24678f996404125dcee4c7a" },
      { kind: "base", label: "Rebase targets on updated main", value: "6705ab6" },
      { kind: "base", label: "Rebase targets on updated main", value: "7d453cd" },
    ]);
  });

  it("ignores a revision claim hidden in an HTML comment", () => {
    assert.deepEqual(revisionClaims("<!--\nHead: deadbeef\n-->"), []);
  });

  it("warns about a real label with no revision, without treating N/A as one", () => {
    assert.deepEqual(revisionClaims("Head: TBD"), [{ kind: "head", label: "Head", value: null }]);
  });
});

describe("body check", () => {
  it("accepts a full or abbreviated head that matches the live head", () => {
    assert.deepEqual(checkBody(`Head: \`${HEAD}\``, { head: HEAD }).findings, []);
    assert.deepEqual(checkBody("Head: 1fd89e5", { head: HEAD }).findings, []);
  });

  it("fails a head claim that does not match the live head", () => {
    const { findings } = checkBody(`Head: ${OTHER}`, { head: HEAD });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, "error");
    assert.match(findings[0].message, new RegExp(OTHER));
    assert.match(findings[0].message, new RegExp(HEAD));
  });

  it("produces no finding when the body declares no head (optional metadata)", () => {
    const { findings } = checkBody("No revision claim here.", { head: HEAD });
    assert.deepEqual(findings, []);
  });

  it("fails instead of throwing when no live head is supplied", () => {
    const { findings } = checkBody(`Head: ${HEAD}`, { head: null });
    assert.equal(findings.some((finding) => finding.level === "error" && /no live PR head/u.test(finding.message)), true);
    assert.equal(findings.some((finding) => finding.level === "error" && /declares/u.test(finding.message)), false);
  });

  it("fails a base claim that is not in the head history", () => {
    const body = `Original base: ${ORIGINAL_BASE}`;
    const { findings } = checkBody(body, { head: HEAD, isAncestor: () => false });
    assert.equal(findings.some((finding) => finding.level === "error" && /ancestor/u.test(finding.message)), true);
  });

  it("fails when a base claim cannot be verified locally", () => {
    const body = `Head: ${HEAD}\nOriginal base: ${ORIGINAL_BASE}`;
    const { findings } = checkBody(body, { head: HEAD, isAncestor: () => null });
    assert.equal(findings.some((finding) => finding.level === "error" && /cannot be verified/u.test(finding.message)), true);
    assert.equal(findings.some((finding) => finding.level === "error" && /ancestor/u.test(finding.message)), false);
  });

  it("accepts a current base claim that matches the live base", () => {
    const body = `Head: ${HEAD}\nBase: ${REBASED_ONTO}`;
    const { findings } = checkBody(body, { head: HEAD, base: REBASED_ONTO, isAncestor: () => true });
    assert.deepEqual(findings, []);
  });

  it("fails a stale current base even when it is an ancestor", () => {
    const body = `Head: ${HEAD}\nBase: ${ORIGINAL_BASE}`;
    const { findings } = checkBody(body, { head: HEAD, base: REBASED_ONTO, isAncestor: () => true });
    assert.equal(findings.some((finding) => finding.level === "error" && /live PR base/u.test(finding.message)), true);
  });

  it("fails a malformed active revision claim", () => {
    const { findings } = checkBody(`Head: TBD`, { head: HEAD });
    assert.equal(findings.some((finding) => finding.level === "error" && /does not name a valid revision/u.test(finding.message)), true);
  });

  it("treats an explicit N/A as optional metadata", () => {
    const { findings } = checkBody(`Head: N/A`, { head: HEAD });
    assert.deepEqual(findings, []);
  });

  it("accepts a base claim that is in the head history", () => {
    const body = `Head: ${HEAD}\nOriginal base: ${ORIGINAL_BASE}`;
    const { findings } = checkBody(body, { head: HEAD, isAncestor: () => true });
    assert.deepEqual(findings, []);
  });

  it("finds a forbidden phrase regardless of case or line wrapping", () => {
    const { findings } = checkBody(`Head: ${HEAD}\nThe notice reports FILE\nMTIME.`, {
      head: HEAD,
      forbid: ["file mtime"],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, "error");
    assert.match(findings[0].message, /forbidden phrase: file mtime/u);
  });

  it("ignores a forbidden phrase inside a hidden HTML comment", () => {
    const { findings } = checkBody("Head: 1fd89e5\n<!-- file mtime -->", {
      head: HEAD,
      forbid: ["file mtime"],
    });
    assert.deepEqual(findings, []);
  });

  it("reports each forbidden phrase once", () => {
    const { findings } = checkBody(`Head: ${HEAD}\nfile mtime and file mtime`, {
      head: HEAD,
      forbid: ["file mtime"],
    });
    assert.equal(findings.length, 1);
  });
});

describe("command line", () => {
  it("returns 2 for an invalid pull request number", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-pr-evidence.mjs"), "abc"], { encoding: "utf8" });
    assert.equal(result.status, 2);
  });

  it("returns 2 when no PR is supplied", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "check-pr-evidence.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 2);
  });
});

describe("argument parsing", () => {
  it("accepts one PR and repeated forbidden phrases", () => {
    assert.deepEqual(parseArgs(["301", "--forbid", "file mtime", "--forbid", "report file age"]), {
      pr: 301,
      forbid: ["file mtime", "report file age"],
    });
  });

  it("rejects a missing or non-numeric PR", () => {
    assert.match(parseArgs([]).error, /no pull request number/u);
    assert.match(parseArgs(["abc"]).error, /must be numeric/u);
  });

  it("rejects an empty phrase and unknown options", () => {
    assert.match(parseArgs(["301", "--forbid"]).error, /non-empty phrase/u);
    assert.match(parseArgs(["301", "--unknown"]).error, /unknown option/u);
  });
});
