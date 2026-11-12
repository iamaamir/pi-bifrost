import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertBaseAncestor,
  changedFilesForBase,
  evidenceCoverageProblems,
  evaluateEvidenceRebind,
  loadEvidenceManifest,
  rebindedManifest,
  resolveBaseRef,
  writeEvidenceManifest,
} from "../scripts/acceptance/evidence-rebind.mjs";
import { selectEvidenceManifest } from "../scripts/acceptance/evidence-selection.mjs";

function contract(id, files, overrides = {}) {
  return {
    id,
    requirement: "R16",
    files,
    boundary: "testing boundary",
    assertions: "observable assertions",
    boundaryTest: { exception: "the CLI cases below are the executed boundary proof" },
    invariant: { exception: "wiring and structural checks carry no separate invariant" },
    fault: { exception: "the CLI exit-code case below is the executed fault proof" },
    ...overrides,
  };
}

function manifest(base, contracts) {
  return { schemaVersion: 1, base, contracts };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function writeFile(root, name, contents) {
  writeFileSync(join(root, name), contents);
}

function readDeclaration(root) {
  return JSON.parse(readFileSync(join(root, "change-evidence.json"), "utf8"));
}

function writeDeclaration(root, declaration) {
  writeFile(root, "change-evidence.json", JSON.stringify(declaration, null, 2));
}

/**
 * Two-commit repo: a base commit with src.mjs, then a change commit that
 * writes new.test.mjs and a declaration covering the candidate diff.
 */
function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "evidence-rebind-test-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@invalid"]);
  git(root, ["config", "user.name", "Evidence Rebind Test"]);
  writeFile(root, "src.mjs", "export const seed = 0;\n");
  const base = commit(root, "base commit");
  writeFile(root, "src.mjs", "export const seed = 1;\n");
  writeFile(root, "new.test.mjs", "test('x', () => {});\n");
  writeDeclaration(root, manifest(base, [contract("change", ["src.mjs", "new.test.mjs"])]));
  const head = commit(root, "change commit");
  return { root, base, head };
}

/** Run the CLI as a subprocess; return {code, stdout, stderr}. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "scripts", "acceptance", "evidence-rebind.mjs");

function runCli(root, args, cli = CLI) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** A commit object with no ancestry, so it exists but is not inside HEAD. */
function orphanCommit(root) {
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  return execFileSync("git", ["commit-tree", tree], { cwd: root, input: "orphan", encoding: "utf8" }).trim();
}

describe("evidence rebind helper", () => {
  describe("structural coverage", () => {
    it("passes when declared files exactly cover the candidate diff", () => {
      assert.deepEqual(
        evidenceCoverageProblems(
          manifest("0".repeat(40), [contract("ok", ["tests/one.test.mjs"])]),
          ["tests/one.test.mjs"],
        ),
        { notInDiff: [], changedNotDeclared: [], declaredCount: 1, changedCount: 1 },
      );
    });

    it("reports declared files missing from the diff and changed files missing from the declaration", () => {
      const problems = evidenceCoverageProblems(
        manifest("0".repeat(40), [contract("ghost", ["tests/None.mjs"])]),
        ["source.ts", "tests/new.test.mjs"],
      );
      assert.deepEqual(problems.notInDiff, ["tests/None.mjs"]);
      assert.deepEqual(problems.changedNotDeclared, ["source.ts", "tests/new.test.mjs"]);
    });

    it("rejects duplicate coverage, a malformed base, and malformed contracts", () => {
      assert.throws(
        () => evidenceCoverageProblems(
          manifest("0".repeat(40), [contract("a", ["same.mjs"]), contract("b", ["same.mjs"])]),
          ["same.mjs"],
        ),
        /duplicate file coverage: same\.mjs declared by a and b/,
      );
      assert.throws(
        () => evidenceCoverageProblems(
          manifest("not-a-sha", [contract("a", ["same.mjs"])]),
          ["same.mjs"],
        ),
        /full base commit sha/,
      );
      assert.throws(
        () => evidenceCoverageProblems(
          manifest("0".repeat(40), [{ id: "", requirement: "R16", files: ["x"], boundary: "b", assertions: "a" }]),
          ["x"],
        ),
        /contract IDs must be unique and nonempty/,
      );
    });
  });

  describe("base handling", () => {
    it("resolves refs to full shas and requires them to be inside HEAD", () => {
      const { root, base } = initRepo();
      try {
        assert.equal(resolveBaseRef(root, base), base);
        assert.doesNotThrow(() => assertBaseAncestor(root, base));
        assert.throws(
          () => assertBaseAncestor(root, orphanCommit(root)),
          /not an ancestor of HEAD/,
        );
        // A git-level failure is not an ancestry verdict and keeps its cause.
        assert.throws(
          () => assertBaseAncestor(mkdtempSync(join(tmpdir(), "evidence-rebind-nogit-")), "a".repeat(40)),
          (error) => !/not an ancestor of HEAD/.test(error.message) && error.status === 128,
        );
        assert.throws(() => resolveBaseRef(root, "HEAD~999"), /Needed a single revision|unknown revision|Evidence rebind:/);
        const missing = "f".repeat(40);
        assert.throws(() => resolveBaseRef(root, missing), /Needed a single revision|unknown revision|ambiguous argument|Evidence rebind:/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("wraps declaration read failures with the manifest path", () => {
      const { root } = initRepo();
      try {
        writeFile(root, "change-evidence.json", "{ not json");
        assert.throws(() => loadEvidenceManifest(root), (error) => {
          assert.match(error.message, /Evidence rebind: the declaration at .* is not valid JSON/);
          return true;
        });
        assert.throws(() => loadEvidenceManifest(tmpdir()), (error) => {
          assert.match(error.message, /cannot read the declaration at .*change-evidence\.json/);
          return true;
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("lists the full candidate diff including declarations for selected-manifest filtering", () => {
      const { root, base } = initRepo();
      try {
        assert.deepEqual(changedFilesForBase(root, base), ["change-evidence.json", "new.test.mjs", "src.mjs"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps a changed non-selected declaration in the real selected-manifest diff", () => {
      const { root, base } = initRepo();
      try {
        const routine = readDeclaration(root);
        routine.base = "e".repeat(40);
        writeDeclaration(root, routine);
        const declaration = manifest(base, [contract("release", ["src.mjs", "new.test.mjs"])]);
        writeFile(root, "release-evidence.json", JSON.stringify(declaration));
        git(root, ["add", "release-evidence.json"]);
        git(root, ["commit", "--amend", "--no-gpg-sign", "-m", "release declaration"]);
        const selection = selectEvidenceManifest({ root, base });
        assert.equal(selection.file, "release-evidence.json");
        const changed = changedFilesForBase(root, base);
        assert.ok(changed.includes("change-evidence.json"), "the real candidate diff includes the non-selected declaration");
        const problems = evidenceCoverageProblems(selection.manifest, changed, selection.file);
        assert.deepEqual(problems.changedNotDeclared, ["change-evidence.json"]);
        selection.manifest.contracts[0].files.push("change-evidence.json");
        assert.deepEqual(evidenceCoverageProblems(selection.manifest, changed, selection.file).changedNotDeclared, []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("preflight rejects an unsupported schema on a uniquely base-matching declaration", () => {
      const { root, base } = initRepo();
      try {
        const declaration = readDeclaration(root);
        declaration.schemaVersion = 2;
        writeDeclaration(root, declaration);
        assert.throws(() => evaluateEvidenceRebind({ root, baseRef: base }), /schemaVersion 1/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("preflight rejects an empty contract list even when only the selected manifest changed", () => {
      const { root, base } = initRepo();
      try {
        const declaration = readDeclaration(root);
        declaration.contracts = [];
        writeDeclaration(root, declaration);
        assert.throws(() => evaluateEvidenceRebind({ root, baseRef: base }), /at least one contract/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("rebinding", () => {
    it("rewrites only the base commit and stays idempotent", () => {
      const { root, head } = initRepo();
      try {
        // An unknown top-level key rides along through the rewrite.
        const rebinding = rebindedManifest({ ...readDeclaration(root), note: "kept" }, head);
        assert.equal(rebinding.note, "kept", "rebinding keeps unknown declaration keys");
        assert.equal(writeEvidenceManifest(root, rebinding), true, "the first write lands");
        assert.deepEqual(readDeclaration(root), rebinding, "the written file matches the rebinding object exactly");
        assert.deepEqual(Object.keys(readDeclaration(root)), Object.keys(rebinding), "key order survives the rewrite");
        assert.equal(writeEvidenceManifest(root, rebinding), false, "identical bytes are a no-op");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not follow a pre-existing temporary symlink while rebinding", () => {
    const { root, head } = initRepo();
    const outside = mkdtempSync(join(tmpdir(), "evidence-rebind-target-"));
    const victim = join(outside, "victim");
    const tempPath = join(root, `change-evidence.json.rebind-${process.pid}.tmp`);
    const original = readFileSync(join(root, "change-evidence.json"), "utf8");
    try {
      writeFileSync(victim, "untouched\\n");
      symlinkSync(victim, tempPath);
      assert.throws(
        () => writeEvidenceManifest(root, rebindedManifest(readDeclaration(root), head)),
        { code: "EEXIST" },
      );
      assert.equal(readFileSync(victim, "utf8"), "untouched\\n");
      assert.equal(readFileSync(join(root, "change-evidence.json"), "utf8"), original);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never reaches disk when the rebinding is structurally invalid", () => {
      const { root, base, head } = initRepo();
      try {
        const broken = readDeclaration(root);
        broken.contracts = [contract("a", ["src.mjs"]), contract("b", ["src.mjs"])];
        writeDeclaration(root, broken);
        const target = head === base ? git(root, ["rev-parse", "HEAD"]) : head;
        assert.throws(
          () => evaluateEvidenceRebind({ root, baseRef: target, apply: true }),
          /duplicate file coverage: src\.mjs declared by a and b/,
        );
        assert.equal(readDeclaration(root).base, base, "a failed apply leaves the on-disk declaration untouched");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses a rewrite that would exceed the size cap and leaves the on-disk file untouched", () => {
      const { root, base } = initRepo();
      try {
        // A compact on-disk declaration under the 256 KiB cap whose pretty
        // rewrite would land above it (every entry gains indent bytes).
        const contracts = Array.from({ length: 2700 }, (_, i) => ({
          id: `c${i}`,
          requirement: "R16",
          files: [`c${i}.mjs`],
          boundary: "b",
          assertions: "a",
        }));
        const onDisk = JSON.stringify({ schemaVersion: 1, base, contracts });
        const rewriteBytes = Buffer.byteLength(`${JSON.stringify({ ...JSON.parse(onDisk), base }, null, 2)}\n`);
        const loaded = Buffer.byteLength(onDisk);
        assert.ok(loaded <= 256 * 1024, `fixture must load under the cap, got ${loaded}`);
        assert.ok(rewriteBytes > 256 * 1024, `fixture rewrite must exceed the cap, got ${rewriteBytes}`);
        writeFileSync(join(root, "change-evidence.json"), onDisk);

        assert.throws(
          () => evaluateEvidenceRebind({ root, baseRef: base, apply: true }),
          /the rewritten declaration would be \d+ bytes; the cap is 262144/,
        );
        assert.equal(readFileSync(join(root, "change-evidence.json"), "utf8"), onDisk,
          "a refused rewrite leaves the compact declaration untouched");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("validates against the requested base and --apply rebases only the declaration base", () => {
      const { root, base, head } = initRepo();
      try {
        const clean = evaluateEvidenceRebind({ root, baseRef: base });
        assert.equal(clean.status, "passed");
        assert.equal(clean.declarationMatches, true);
        assert.equal(clean.changedCount, 2);

        assert.throws(() => evaluateEvidenceRebind({ root, baseRef: head }), /missing, unsupported or stale declaration/,
          "a stale declaration cannot be selected for a different event base");

        const applied = evaluateEvidenceRebind({ root, baseRef: head, apply: true });
        assert.equal(applied.wrote, true);
        assert.equal(applied.declarationMatches, true, "apply rewrites the declaration base");
        assert.equal(applied.status, "failed", "apply must not invent coverage for an empty diff");
        assert.deepEqual(applied.notInDiff, ["src.mjs", "new.test.mjs"]);
        assert.equal(readDeclaration(root).base, head);

        // Validation without --apply never rewrites the declaration.
        const after = evaluateEvidenceRebind({ root, baseRef: head });
        assert.equal(after.declarationMatches, true, "the applied declaration now names head");
        assert.equal(after.status, "failed", "but coverage is still judged against the requested diff");

        // Coverage can be clean while the declaration names another base: then and
        // only then the declaration-match factor alone decides failure.
        assert.throws(() => evaluateEvidenceRebind({ root, baseRef: base }), /missing, unsupported or stale declaration/,
          "the rebased declaration cannot be reused for an older base");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("CLI", () => {
    it("pre-push validates a committed candidate against an explicit base", () => {
      const { root, base } = initRepo();
      try {
        assert.equal(runCli(root, ["--pre-push"]).code, 1);
        assert.equal(runCli(root, ["--pre-push", "--apply", base]).code, 1);
        assert.equal(runCli(root, ["--pre-push", base]).code, 0);
        assert.equal(runCli(root, ["--pre-push", "HEAD"]).code, 1, "a stale base fails");
        writeFile(root, "src.mjs", "uncommitted\n");
        assert.match(runCli(root, ["--pre-push", base]).stderr, /commit tracked changes/);
        git(root, ["checkout", "--", "src.mjs"]);
        writeFile(root, "release-evidence.json", "{}\n");
        assert.match(runCli(root, ["--pre-push", base]).stderr, /commit evidence declarations/);
        rmSync(join(root, "release-evidence.json"));
        writeFile(root, "extra.mjs", "export default 1;\n");
        assert.equal(runCli(root, ["--pre-push", base]).code, 0, "unrelated untracked files are allowed");
        commit(root, "adds extra");
        const missing = runCli(root, ["--pre-push", base]);
        assert.equal(missing.code, 1);
        assert.deepEqual(JSON.parse(missing.stdout).changedNotDeclared, ["extra.mjs"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fault control: ignored evidence cannot make pre-push validation pass", () => {
      const { root, base } = initRepo();
      const mutantDir = mkdtempSync(join(tmpdir(), "evidence-pre-push-mutant-"));
      try {
        git(root, ["rm", "change-evidence.json"]);
        git(root, ["commit", "--no-gpg-sign", "-m", "remove declaration"]);
        writeFileSync(join(root, ".git", "info", "exclude"), "release-evidence.json\n");
        writeFile(root, "release-evidence.json", JSON.stringify(manifest(base, [contract("release", ["src.mjs", "new.test.mjs"])])));
        const rejectIgnoredDeclaration = (cli) => {
          const result = runCli(root, ["--pre-push", base], cli);
          assert.equal(result.code, 1);
          assert.match(result.stderr, /commit evidence declarations/);
        };
        rejectIgnoredDeclaration(CLI);
        const source = readFileSync(CLI, "utf8");
        const guard = '"--untracked-files=all", "--ignored", "--", ...EVIDENCE_MANIFESTS';
        assert.ok(source.includes(guard), "fault target must exist");
        const mutant = join(realpathSync(mutantDir), "evidence-rebind.mjs");
        writeFileSync(mutant, source.replace(guard, '"--untracked-files=all", "--", ...EVIDENCE_MANIFESTS'));
        for (const file of ["core.mjs", "evidence-selection.mjs"]) copyFileSync(join(dirname(CLI), file), join(mutantDir, file));
        const bypassed = runCli(root, ["--pre-push", base], mutant);
        assert.equal(bypassed.code, 0, bypassed.stderr);
        assert.equal(JSON.parse(bypassed.stdout).status, "passed");
        assert.throws(() => rejectIgnoredDeclaration(mutant), { code: "ERR_ASSERTION" });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(mutantDir, { recursive: true, force: true });
      }
    });

    it("exits 0 with the passed report and exits 1 on a stale diff report", () => {
      const { root, base } = initRepo();
      try {
        const ok = runCli(root, [base]);
        assert.equal(ok.code, 0);
        const report = JSON.parse(ok.stdout);
        assert.equal(report.status, "passed");
        assert.equal(report.wrote, false);
        assert.equal(report.changedCount, 2);

        writeFile(root, "extra.mjs", "export default 1;\n");
        commit(root, "adds extra");
        const stale = runCli(root, [base]);
        assert.equal(stale.code, 1, "an undeclared changed file fails the structural check");
        const staleReport = JSON.parse(stale.stdout);
        assert.equal(staleReport.status, "failed");
        assert.deepEqual(staleReport.changedNotDeclared, ["extra.mjs"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails loudly for an unreachable base and for malformed operands", () => {
      const { root } = initRepo();
      try {
        const unreachable = runCli(root, ["f".repeat(40)]);
        assert.equal(unreachable.code, 1);
        assert.equal(unreachable.stdout, "", "no report is printed for a base that cannot resolve");
        assert.match(
          unreachable.stderr,
          /Evidence rebind: the base ref f{40} does not resolve to a commit: fatal:/,
          "the prefixed resolution error names the ref and keeps git's cause",
        );

        const doubledFlag = runCli(root, ["--apply", "--apply"]);
        assert.equal(doubledFlag.code, 1);
        assert.match(doubledFlag.stderr, /^usage: node scripts\/acceptance\/evidence-rebind\.mjs/);

        const unknownFlag = runCli(root, ["--flatten"]);
        assert.equal(unknownFlag.code, 1);
        assert.match(unknownFlag.stderr, /^usage: node scripts\/acceptance\/evidence-rebind\.mjs/);

        const unusable = runCli(root, ["one", "two"]);
        assert.equal(unusable.code, 1);
        assert.match(unusable.stderr, /^usage: node scripts\/acceptance\/evidence-rebind\.mjs/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
