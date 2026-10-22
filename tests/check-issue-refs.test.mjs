import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkReferences, classify, extractCitedPaths, parseArgs, resolveRef } from "../scripts/check-issue-refs.mjs";

function fixtureRoot(files = ["AGENTS.md"]) {
  const root = mkdtempSync(join(tmpdir(), "bifrost-issue-refs-"));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "fixture\n");
  }
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

  it("ignores versioned model identifiers that look path-shaped", () => {
    const body = "Route to opencode-go/glm-5.1 or google/gemini-2.5-pro, not openai/gpt-4o.";
    assert.deepEqual(extractCitedPaths(body), []);
  });
});

describe("argument parsing", () => {
  it("accepts issue numbers, an explicit ref, offline and remote requirements", () => {
    assert.deepEqual(parseArgs(["146", "153", "--ref", "v2", "--offline"]), {
      issues: ["146", "153"],
      offline: true,
      ref: "v2",
      requireRemote: false,
    });
    assert.equal(parseArgs(["146", "--require-remote"]).requireRemote, true);
  });

  it("rejects unknown options, non-numeric issues, a missing ref and contradictory modes", () => {
    assert.match(parseArgs(["--nope", "146"]).error, /unknown option/);
    assert.match(parseArgs(["146", "abc"]).error, /numeric/);
    assert.match(parseArgs(["146", "--ref"]).error, /--ref/);
    assert.match(parseArgs(["146", "--offline", "--require-remote"]).error, /cannot be combined/);
    assert.match(parseArgs([]).error, /no issue numbers/);
  });
});

describe("reference checks", () => {
  it("classifies a local-only citation as unpublished and not missing", () => {
    const results = checkReferences(["AGENTS.md", "roadmap-next.md"], {
      root: fixtureRoot(["AGENTS.md", "roadmap-next.md"]),
      remoteExists: (path) => path === "AGENTS.md",
    });
    const { missing, unpublished, failures } = classify(results);
    assert.deepEqual(missing, []);
    assert.deepEqual(unpublished.map((result) => result.path), ["roadmap-next.md"]);
    assert.deepEqual(failures, []);
  });

  it("fails a citation that is missing from the working tree", () => {
    const results = checkReferences(["AGENTS.md", "missing.md"], { root: fixtureRoot() });
    const { missing, failures } = classify(results);
    assert.deepEqual(missing.map((result) => result.path), ["missing.md"]);
    assert.deepEqual(failures.map((result) => result.path), ["missing.md"]);
  });

  it("fails a local-only citation only when remote publication is required", () => {
    const results = checkReferences(["roadmap-next.md"], {
      root: fixtureRoot(["roadmap-next.md"]),
      remoteExists: () => false,
    });
    assert.deepEqual(classify(results).failures, []);
    assert.deepEqual(
      classify(results, { requireRemote: true }).failures.map((result) => result.path),
      ["roadmap-next.md"],
    );
  });

  it("leaves the remote unknown when no probe is supplied", () => {
    const results = checkReferences(["AGENTS.md"], { root: fixtureRoot() });
    assert.equal(results[0].local, true);
    assert.equal(results[0].remote, null);
    assert.deepEqual(classify(results, { requireRemote: true }).failures, []);
  });

  it("fails a remote-only workflow file as missing from the working tree", () => {
    const path = ".github/workflows/present.yml";
    const results = checkReferences([path], { root: fixtureRoot(), remoteExists: () => true });
    const { missing, unpublished } = classify(results);
    assert.deepEqual(missing.map((result) => result.path), [path]);
    assert.deepEqual(unpublished, []);
    assert.deepEqual(classify(results, { requireRemote: true }).failures.map((r) => r.path), [path]);
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
