import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkReferences, extractCitedPaths, parseArgs, report, resolveRef } from "../scripts/check-issue-refs.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "bifrost-issue-refs-"));
  writeFileSync(join(root, "AGENTS.md"), "# agents\n");
  return root;
}

describe("cited path extraction", () => {
  it("finds root documents, nested documents and code paths", () => {
    const body = "Read `AGENTS.md`, `docs/product-philosophy.md` and `scripts/verify-release.mjs`.";
    assert.deepEqual(extractCitedPaths(body), [
      "AGENTS.md",
      "docs/product-philosophy.md",
      "scripts/verify-release.mjs",
    ]);
  });

  it("ignores identifiers, provider/model pairs and bare version numbers", () => {
    const body = "Route to provider/model, see c.group and the v2 branch. Version 1.0.1.";
    assert.deepEqual(extractCitedPaths(body), []);
  });

  it("deduplicates and sorts repeated citations", () => {
    const body = "`roadmap-next.md` twice: roadmap-next.md, plus `docs/adr/0023-bounded-allowance-recovery.md`.";
    assert.deepEqual(extractCitedPaths(body), [
      "docs/adr/0023-bounded-allowance-recovery.md",
      "roadmap-next.md",
    ]);
  });

  it("drops a sentence-ending period and a leading ./ from a path", () => {
    assert.deepEqual(extractCitedPaths("See roadmap-next.md. Then read ./docs/tracker-workflow.md."), [
      "docs/tracker-workflow.md",
      "roadmap-next.md",
    ]);
  });

  it("finds workflow, shell, python and text files", () => {
    const body = "See `.github/workflows/missing.yml`, `scripts/release.sh`, `tools/check.py` and notes.txt.";
    assert.deepEqual(extractCitedPaths(body), [
      ".github/workflows/missing.yml",
      "notes.txt",
      "scripts/release.sh",
      "tools/check.py",
    ]);
  });

  it("checks an unlisted extension once the token is already path-shaped", () => {
    assert.deepEqual(extractCitedPaths("Committed in scripts/tool.ps1 today."), ["scripts/tool.ps1"]);
  });
});

describe("argument parsing", () => {
  it("accepts issue numbers, an explicit ref and offline mode", () => {
    assert.deepEqual(parseArgs(["146", "153", "--ref", "v2", "--offline"]), {
      issues: ["146", "153"],
      offline: true,
      ref: "v2",
    });
  });

  it("rejects unknown options, non-numeric issues and a missing ref value", () => {
    assert.match(parseArgs(["--nope", "146"]).error, /unknown option/);
    assert.match(parseArgs(["146", "abc"]).error, /numeric/);
    assert.match(parseArgs(["146", "--ref"]).error, /--ref/);
    assert.match(parseArgs([]).error, /no issue numbers/);
  });
});

describe("reference checks", () => {
  it("reports local presence and remote presence independently", () => {
    const root = fixtureRoot();
    const results = checkReferences(["AGENTS.md", "roadmap-next.md"], {
      root,
      remoteExists: (path) => path === "AGENTS.md",
    });
    assert.deepEqual(
      results.map(({ path, local, remote }) => ({ path, local, remote })),
      [
        { path: "AGENTS.md", local: true, remote: true },
        { path: "roadmap-next.md", local: false, remote: false },
      ],
    );
  });

  it("leaves the remote unknown when no probe is supplied", () => {
    const [result] = checkReferences(["AGENTS.md"], { root: fixtureRoot() });
    assert.equal(result.local, true);
    assert.equal(result.remote, null);
  });

  it("returns only the references that are not readable everywhere", () => {
    const root = fixtureRoot();
    const results = checkReferences(["AGENTS.md", "missing.md"], { root, remoteExists: () => true });
    const missing = report(results, { write: () => true });
    assert.deepEqual(missing, [{ path: "missing.md", local: false, remote: true }]);
  });

  it("treats a remote miss as missing even when the file is local", () => {
    const results = checkReferences(["AGENTS.md"], {
      root: fixtureRoot(),
      remoteExists: () => false,
    });
    const missing = report(results, { write: () => true });
    assert.deepEqual(missing, [{ path: "AGENTS.md", local: true, remote: false }]);
  });

  it("reports a cited workflow file that is remote-only as missing", () => {
    const results = checkReferences([".github/workflows/missing.yml"], {
      root: fixtureRoot(),
      remoteExists: () => true,
    });
    assert.deepEqual(report(results, { write: () => true }), [
      { path: ".github/workflows/missing.yml", local: false, remote: true },
    ]);
  });
});

describe("ref resolution", () => {
  it("asks the selected repository for its default branch", () => {
    const asked = [];
    const ref = resolveRef({
      repo: "owner/other",
      offline: false,
      query: (target) => {
        asked.push(target);
        return "master";
      },
    });
    assert.equal(ref, "master");
    assert.deepEqual(asked, ["owner/other"]);
  });

  it("prefers an explicit ref and needs no query offline", () => {
    const query = () => {
      throw new Error("must not query");
    };
    assert.equal(resolveRef({ repo: "owner/repo", offline: false, explicitRef: "v2", query }), "v2");
    assert.equal(resolveRef({ repo: "owner/repo", offline: true, query }), "");
  });
});
