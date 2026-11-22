import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  analyze,
  candidateFingerprint,
  cognitive,
  compare,
  cyclomatic,
  inScopeFiles,
  main,
  measureRevision,
  policyAt,
  resolveRevision,
  resolveTarget,
  scopeOf,
} from "../scripts/check-complexity.mjs";
import { fixtureGitEnv } from "./fixtures/git-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-complexity.mjs");
const require = createRequire(join(ROOT, "package.json"));
const ts = require("typescript");

function parseFirstFunction(code) {
  const sourceFile = ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found;
  function walk(n) {
    if (!found && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && n.body) {
      found = n;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(sourceFile);
  if (!found) throw new Error("no function found");
  return found;
}

function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-complexity-"));
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "a.ts"),
    [
      "export function branches(x: boolean, y: boolean, items: number[]) {",
      "  if (x && y) {",
      "    for (const i of items) { if (i > 0) break; }",
      "  } else if (x || y) {",
      "    return 1;",
      "  }",
      "  return x ? 2 : 3;",
      "}",
      "",
      "export function outer(flag: boolean) {",
      "  if (flag) { return 1; }",
      "  const inner = (v: boolean) => { if (v) { return 2; } return 3; };",
      "  return inner(flag);",
      "}",
      "",
      "export const arrowExpr = (a: boolean) => (a ? 1 : 2);",
      "export const arrowBlock = (a: boolean) => { return a ? 1 : 2; };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tests", "a.test.ts"),
    [
      "import { test } from 'node:test';",
      "test('ok', () => { if (Math.random() > 2) { return; } });",
      "",
    ].join("\n"),
  );
  return dir;
}

const BASE_A = [
  "export function choose(flag: boolean) {",
  "  if (flag) {",
  "    return 1;",
  "  }",
  "  return 2;",
  "}",
  "",
].join("\n");

const BASE_B = [
  "export function plain(value: number) {",
  "  return value + 1;",
  "}",
  "",
].join("\n");

const REGRESSED_A = [
  "export function choose(flag: boolean, other: boolean) {",
  "  if (flag && other) {",
  "    return 1;",
  "  }",
  "  if (other) {",
  "    return 3;",
  "  }",
  "  return 2;",
  "}",
  "",
].join("\n");

// Close enough to BASE_A for Git's rename detection, but one branch hotter.
// Used to prove that similarity classification cannot transfer the old ceiling.
const RENAMED_A = [
  "export function choose(flag: boolean) {",
  "  if (flag) {",
  "    return 1;",
  "  }",
  "  if (!flag) {",
  "    return 3;",
  "  }",
  "  return 2;",
  "}",
  "",
].join("\n");

const ADDED_LOW = [
  "export function addedLow(value: number) {",
  "  return value * 2;",
  "}",
  "",
].join("\n");

function git(dir, args) {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", ...args], {
    cwd: dir,
    env: fixtureGitEnv(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

// The fixture's policy files are content-only: the gate under test hashes them
// but never executes them. Keeping them tiny leaves the fixture's own scope
// maxima meaningful.
function seedPolicy(dir, script = "// fixture complexity policy\n") {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, "scripts", "check-complexity.mjs"), script);
  writeFileSync(join(dir, ".github", "workflows", "complexity-gate.yml"), "name: complexity-gate-fixture\n");
  writeFileSync(join(dir, ".github", "workflows", "static-analysis.yml"), "name: fixture\n");
  writeFileSync(join(dir, ".github", "workflows", "verification.yml"), "name: verification-fixture\n");
  writeFileSync(join(dir, ".github", "CODEOWNERS"), "/scripts/check-complexity.mjs @owner\n");
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    scripts: {
      "check:complexity": "node scripts/check-complexity.mjs",
      "check:complexity:base": "node scripts/check-complexity.mjs --target",
    },
    devDependencies: { typescript: "6.0.3" },
  }, null, 2));
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--no-gpg-sign", "-qm", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function gitFixture(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-complexity-git-"));
  writeFileSync(join(dir, "a.ts"), BASE_A);
  writeFileSync(join(dir, "b.ts"), BASE_B);
  for (const [rel, content] of Object.entries(extraFiles)) writeFileSync(join(dir, rel), content);
  seedPolicy(dir);
  git(dir, ["init", "-q"]);
  const baseBranch = git(dir, ["symbolic-ref", "--short", "HEAD"]);
  const base = commit(dir, "base");
  return { dir, base, baseBranch };
}

// The gate reads BIFROST_* from the ambient environment, so a hook or shell
// that sets a policy override must not change what these tests assert.
function gateEnv(overrides = {}) {
  const env = fixtureGitEnv();
  delete env.BIFROST_COMPLEXITY_ALLOW_POLICY_CHANGE;
  delete env.BIFROST_COMPLEXITY_BASE;
  delete env.GITHUB_BASE_SHA;
  return { ...env, ...overrides };
}

function runGate(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, "--repo", dir, "--json", ...args], {
    cwd: ROOT,
    env: gateEnv(env),
    encoding: "utf8",
  });
  return {
    status: result.status,
    report: result.stdout.trim() === "" ? null : JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

function runGateAsync(dir, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--repo", dir, "--json", ...args], {
      cwd: ROOT,
      env: gateEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({
      status,
      report: stdout.trim() === "" ? null : JSON.parse(stdout),
      stderr,
    }));
  });
}

function branchFrom(dir, baseBranch, name, message, mutate) {
  git(dir, ["checkout", "-q", "-B", name, baseBranch]);
  mutate();
  const sha = commit(dir, message);
  git(dir, ["checkout", "-q", baseBranch]);
  return sha;
}

test("scores branch counts and does not inflate outer functions with nested function complexity", () => {
  const branches = parseFirstFunction("function branches(x,y){ if (x && y) { for(;;){} } else if (x||y) { return 1; } return x ? 2 : 3; }");
  // base 1 + if + && + for + else-if + || + conditional = 7
  assert.equal(cyclomatic(branches), 7);

  const outer = parseFirstFunction("function outer(flag){ if(flag){return 1;} const inner=(v)=>{ if(v){return 2;} return 3; }; return inner(flag); }");
  const inner = parseFirstFunction("const inner=(v)=>{ if(v){return 2;} return 3; };".replace("const inner=", ""));
  assert.equal(cyclomatic(outer), 2); // base 1 + outer if only
  assert.equal(cyclomatic(inner), 2); // base 1 + inner if

  const arrowExpr = parseFirstFunction("const f = (a) => (a ? 1 : 2);".replace("const f = ", ""));
  const arrowBlock = parseFirstFunction("const f = (a) => { return a ? 1 : 2; };".replace("const f = ", ""));
  assert.equal(cyclomatic(arrowExpr), 2);
  assert.equal(cyclomatic(arrowBlock), 2);

  const cogOuter = cognitive(parseFirstFunction("function outer(flag){ if(flag){ const inner=()=>{ if(flag){ if(flag){ return 1; } } }; } }"));
  const cogInner = cognitive(parseFirstFunction("const inner=()=>{ if(flag){ if(flag){ return 1; } } };".replace("const inner=", "")));
  assert.equal(cogOuter, 1); // outer if only, nested function excluded
  assert.ok(cogInner >= 3);
});

test("classifies Windows-style relative paths with either separator", () => {
  assert.equal(scopeOf("index.ts"), "source");
  assert.equal(scopeOf("ui\\panel.ts"), "source");
  assert.equal(scopeOf("scripts\\tool.mjs"), "source");
  assert.equal(scopeOf("tests\\a.test.ts"), "tests");
  assert.equal(scopeOf("mutation\\run.mjs"), null);
});

test("measures .mjs and .cjs sources alongside .ts", () => {
  const root = fixtureRoot();
  try {
    writeFileSync(join(root, "tool.mjs"), "export function pick(a) { return a ? 1 : 2; }\n");
    writeFileSync(join(root, "tests", "b.test.cjs"), "module.exports = 1;\n");
    assert.deepEqual(
      inScopeFiles(root).map((f) => [f.rel, f.scope]).sort(),
      [
        ["a.ts", "source"],
        ["tests/a.test.ts", "tests"],
        ["tests/b.test.cjs", "tests"],
        ["tool.mjs", "source"],
      ],
    );
    const report = analyze({ root });
    assert.equal(report.scopes.source.files, 2);
    assert.equal(report.files["tool.mjs"].maxCyc, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analyze scopes files, normalizes relative paths, and produces stable per-file metrics", () => {
  const root = fixtureRoot();
  try {
    const report = analyze({ root });
    assert.equal(report.scopes.source.files, 1);
    assert.equal(report.scopes.tests.files, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(report.files, "a.ts"));
    assert.ok(Object.prototype.hasOwnProperty.call(report.files, "tests/a.test.ts"));
    assert.equal(report.files["a.ts"].scope, "source");
    assert.equal(report.files["tests/a.test.ts"].scope, "tests");
    assert.deepEqual(report.files["a.ts"], {
      scope: "source",
      lines: 18,
      funcs: 5,
      maxCyc: 8,
      maxCog: 10,
      sumCyc: 16,
      sumCog: 14,
    });
    assert.deepEqual(report.scopes.source, {
      files: 1,
      functions: 5,
      maxCyc: 8,
      maxCog: 10,
      cycGt30: 0,
      cycGt50: 0,
      cogGt30: 0,
      cogGt50: 0,
    });
    assert.deepEqual(report.scopes.tests, {
      files: 1,
      functions: 1,
      maxCyc: 2,
      maxCog: 1,
      cycGt30: 0,
      cycGt50: 0,
      cogGt30: 0,
      cogGt50: 0,
    });
    const keys = Object.keys(report.files);
    assert.deepEqual(keys, [...keys].sort());
    assert.match(report.inputDigest, /^[a-f0-9]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the input digest is stable for identical bytes and changes with content", () => {
  const root = fixtureRoot();
  try {
    const first = analyze({ root });
    const second = analyze({ root });
    assert.equal(first.inputDigest, second.inputDigest);
    writeFileSync(join(root, "a.ts"), `${readFileSync(join(root, "a.ts"), "utf8")}\n// drift\n`);
    assert.notEqual(first.inputDigest, analyze({ root }).inputDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compare accepts unchanged files, flags increased and new-file outliers, and ignores removals", () => {
  const root = fixtureRoot();
  try {
    const target = analyze({ root });
    assert.deepEqual(compare(target, analyze({ root })), []);

    const increased = structuredClone(analyze({ root }));
    increased.files["a.ts"].maxCyc = target.files["a.ts"].maxCyc + 1;
    increased.scopes.source.maxCyc = target.scopes.source.maxCyc + 1;
    const incFindings = compare(target, increased);
    assert.ok(incFindings.some((f) => f.rule === "file-maxCyc-regression" && f.file === "a.ts"));

    const added = structuredClone(analyze({ root }));
    added.files["z-new.ts"] = { scope: "source", lines: 10, funcs: 1, maxCyc: target.scopes.source.maxCyc + 1, maxCog: 1, sumCyc: 1, sumCog: 1 };
    added.scopes.source.maxCyc = target.scopes.source.maxCyc + 1;
    assert.ok(compare(target, added).some((f) => f.rule === "new-file-maxCyc-exceeds-scope-max" && f.file === "z-new.ts"));

    const removed = structuredClone(analyze({ root }));
    delete removed.files["tests/a.test.ts"];
    removed.scopes.tests = { files: 0, functions: 0, maxCyc: 0, maxCog: 0, cycGt30: 0, cycGt50: 0, cogGt30: 0, cogGt50: 0 };
    assert.deepEqual(compare(target, removed), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measured symlinks are skipped instead of followed outside the tree", () => {
  const root = fixtureRoot();
  try {
    symlinkSync(join(root, "a.ts"), join(root, "linked.ts"));
    const report = analyze({ root });
    assert.equal(Object.hasOwn(report.files, "linked.ts"), false);
    assert.equal(report.scopes.source.files, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analyze reports an incomplete snapshot instead of silently dropping a file", () => {
  const root = fixtureRoot();
  const skipped = [];
  const original = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...rest) => {
      if (String(file) === join(root, "a.ts")) {
        const error = new Error(`simulated ENOENT for ${file}`);
        error.code = "ENOENT";
        throw error;
      }
      return original.call(fs, file, ...rest);
    };
    const report = analyze({ root, skipped });
    assert.deepEqual(skipped, ["a.ts"]);
    assert.equal(Object.hasOwn(report.files, "a.ts"), false);
  } finally {
    fs.readFileSync = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("analyze still fails on a read error other than a vanished file", () => {
  const root = fixtureRoot();
  const original = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...rest) => {
      if (String(file) === join(root, "a.ts")) {
        const error = new Error(`simulated EACCES for ${file}`);
        error.code = "EACCES";
        throw error;
      }
      return original.call(fs, file, ...rest);
    };
    assert.throws(() => analyze({ root }), /simulated EACCES/u);
  } finally {
    fs.readFileSync = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTarget treats an explicit or environment revision as authoritative", () => {
  const { dir, base } = gitFixture();
  try {
    assert.deepEqual(resolveTarget({ repo: dir, explicit: base, env: {} }), { sha: base, source: "--target" });
    assert.deepEqual(resolveTarget({ repo: dir, explicit: null, env: { BIFROST_COMPLEXITY_BASE: base } }), { sha: base, source: "BIFROST_COMPLEXITY_BASE" });
    assert.deepEqual(resolveTarget({ repo: dir, explicit: null, env: { GITHUB_BASE_SHA: base } }), { sha: base, source: "GITHUB_BASE_SHA" });
    assert.match(resolveTarget({ repo: dir, explicit: "no-such-ref", env: {} }).error, /could not resolve/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTarget requires an explicit last-commit comparison instead of assuming HEAD^", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    if (baseBranch === "main") git(dir, ["branch", "-m", "topic"]);
    writeFileSync(join(dir, "b.ts"), `${BASE_B}\n// second\n`);
    commit(dir, "second");
    const resolved = resolveTarget({ repo: dir, explicit: null, env: {} });
    assert.match(resolved.error, /no target revision/u);
    const explicit = resolveTarget({ repo: dir, explicit: "HEAD^", env: {} });
    assert.equal(explicit.sha, base);
    assert.equal(explicit.source, "--target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a moved base policy does not force an override for a branch that never edited policy", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const candidate = branchFrom(dir, baseBranch, "untouched-policy", "change code", () => {
      writeFileSync(join(dir, "a.ts"), `${BASE_A}\nexport const added = 1;\n`);
    });
    writeFileSync(join(dir, "tsconfig.json"), "{ \"strict\": true }\n");
    const moved = commit(dir, "move base policy");

    const againstMoved = runGate(dir, ["--target", moved, "--candidate", candidate]);
    assert.equal(againstMoved.status, 2);
    assert.equal(againstMoved.report.findings[0].rule, "complexity-policy-changed");

    const mergeBase = git(dir, ["merge-base", moved, candidate]);
    assert.equal(mergeBase, base);
    const againstMergeBase = runGate(dir, ["--target", mergeBase, "--candidate", candidate]);
    assert.equal(againstMergeBase.status, 0, againstMergeBase.stderr);
    assert.equal(againstMergeBase.report.policy.changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate passes an unchanged revision, including when measured twice", () => {
  const { dir, base } = gitFixture();
  try {
    const first = runGate(dir, ["--target", base, "--candidate", base]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.report.status, "passed");
    assert.equal(first.report.target.revision, base);
    assert.equal(first.report.candidate.revision, base);
    assert.equal(first.report.target.inputDigest, first.report.candidate.inputDigest);
    assert.equal(first.report.policy.changed, false);

    const second = runGate(dir, ["--target", base, "--candidate", base]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.report.target.inputDigest, first.report.target.inputDigest);
    assert.equal(second.report.candidate.inputDigest, first.report.candidate.inputDigest);
    assert.deepEqual(second.report.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a measured function that gains a branch fails the file and scope ratchet", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "regressed", "add a branch", () => writeFileSync(join(dir, "a.ts"), REGRESSED_A));
    const result = runGate(dir, ["--target", base, "--candidate", head]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.report.status, "failed");
    assert.equal(result.report.exitCode, 1);
    assert.ok(result.report.findings.some((f) => f.rule === "file-maxCyc-regression" && f.file === "a.ts"));
    assert.ok(result.report.findings.some((f) => f.rule === "scope-source-maxCyc-regression"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new file above the target scope maximum fails even though no baseline is committed", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "outlier", "add an outlier", () => {
      writeFileSync(join(dir, "outlier.ts"), "export function outlier(a: boolean, b: boolean) {\n  if (a && b) { return 1; }\n  return 2;\n}\n");
    });
    const result = runGate(dir, ["--target", base, "--candidate", head]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.report.findings.some((f) => f.rule === "new-file-maxCyc-exceeds-scope-max" && f.file === "outlier.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source-derived target reproduces the legacy baseline ratchet", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const target = measureRevision(dir, base).report;
    // The old committed baseline was exactly this scope/file record. Comparing
    // against it and against the source-derived target must produce the same
    // ratchet findings for an ordinary change.
    const legacyBaseline = { scopes: target.scopes, files: target.files };
    const candidate = branchFrom(dir, baseBranch, "equivalence", "add a branch", () => writeFileSync(join(dir, "a.ts"), REGRESSED_A));
    const measured = measureRevision(dir, candidate).report;
    const fromSource = compare(target, measured);
    const fromBaseline = compare(legacyBaseline, measured);
    assert.deepEqual(fromSource, fromBaseline);
    assert.ok(fromSource.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removals are ignored and a detected rename is judged as a new file", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const removed = branchFrom(dir, baseBranch, "removed", "remove a file", () => rmSync(join(dir, "b.ts")));
    assert.equal(runGate(dir, ["--target", base, "--candidate", removed]).status, 0);

    const renamed = branchFrom(dir, baseBranch, "renamed", "rename a file", () => git(dir, ["mv", "a.ts", "renamed.ts"]));
    assert.equal(runGate(dir, ["--target", base, "--candidate", renamed]).status, 0);

    const renamedHot = branchFrom(dir, baseBranch, "renamed-hot", "rename and grow", () => {
      git(dir, ["mv", "a.ts", "renamed.ts"]);
      writeFileSync(join(dir, "renamed.ts"), RENAMED_A);
    });
    assert.match(
      git(dir, ["diff", "--find-renames=50%", "--name-status", base, renamedHot]),
      /^R\d+\ta\.ts\trenamed\.ts$/mu,
      "the fixture must be a rename Git would detect",
    );
    const hot = runGate(dir, ["--target", base, "--candidate", renamedHot]);
    assert.equal(hot.status, 1, hot.stderr);
    const finding = hot.report.findings.find((f) => f.rule === "new-file-maxCyc-exceeds-scope-max" && f.file === "renamed.ts");
    assert.ok(finding, "Git rename detection must not grant the destination a fresh per-file ceiling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new path that resembles a rename is judged by the scope ceiling", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const newFile = branchFrom(dir, baseBranch, "new-file", "add a new file", () => {
      writeFileSync(join(dir, "renamed.ts"), REGRESSED_A);
    });
    const result = runGate(dir, ["--target", base, "--candidate", newFile]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.report.findings.some((f) => f.rule === "new-file-maxCyc-exceeds-scope-max" && f.file === "renamed.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding a policy file is a visible policy change, not an unreadable-input error", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    git(dir, ["checkout", "-q", "-B", "no-gate", baseBranch]);
    rmSync(join(dir, ".github", "workflows", "complexity-gate.yml"));
    const withoutGate = commit(dir, "remove the protected workflow");
    git(dir, ["checkout", "-q", "-B", "restored-gate", withoutGate]);
    writeFileSync(join(dir, ".github", "workflows", "complexity-gate.yml"), "name: complexity-gate-fixture\n");
    const restored = commit(dir, "restore the protected workflow");

    const changed = runGate(dir, ["--target", withoutGate, "--candidate", restored]);
    assert.equal(changed.status, 2, changed.stderr);
    assert.equal(changed.report.findings[0].rule, "complexity-policy-changed");
    assert.ok(changed.report.policy.differences.includes(".github/workflows/complexity-gate.yml"));

    const bothMissing = runGate(dir, ["--target", withoutGate, "--candidate", withoutGate]);
    assert.equal(bothMissing.status, 2);
    assert.match(bothMissing.report.error, /unavailable at both revisions/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner-routing file is a policy input", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "codeowners", "move owner routing", () => {
      writeFileSync(join(dir, ".github", "CODEOWNERS"), "/scripts/check-complexity.mjs @someone-else\n");
    });
    const denied = runGate(dir, ["--target", base, "--candidate", head]);
    assert.equal(denied.status, 2, denied.stderr);
    assert.equal(denied.report.findings[0].rule, "complexity-policy-changed");
    assert.ok(denied.report.policy.differences.includes(".github/CODEOWNERS"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy or analyzer edit fails closed and is only accepted with the explicit override", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "policy", "edit the analyzer", () => {
      writeFileSync(join(dir, "scripts", "check-complexity.mjs"), "// fixture complexity policy\n// relaxed thresholds\n");
    });
    const denied = runGate(dir, ["--target", base, "--candidate", head]);
    assert.equal(denied.status, 2, denied.stderr);
    assert.equal(denied.report.exitCode, 2);
    assert.deepEqual(denied.report.findings.map((f) => f.rule), ["complexity-policy-changed"]);
    assert.equal(denied.report.policy.changed, true);
    assert.ok(denied.report.policy.differences.includes("scripts/check-complexity.mjs"));

    const allowed = runGate(dir, ["--target", base, "--candidate", head, "--allow-policy-change"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.report.policy.changed, true);

    const viaEnv = runGate(dir, ["--target", base, "--candidate", head], { BIFROST_COMPLEXITY_ALLOW_POLICY_CHANGE: "1" });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or unavailable inputs fail closed with exit 2 and no verdict", () => {
  const { dir, base } = gitFixture();
  try {
    const noTarget = runGate(dir, ["--target", "no-such-ref"]);
    assert.equal(noTarget.status, 2);
    assert.match(noTarget.report.error, /could not resolve target revision/u);

    const noCandidate = runGate(dir, ["--target", base, "--candidate", "no-such-ref"]);
    assert.equal(noCandidate.status, 2);
    assert.match(noCandidate.report.error, /could not resolve candidate revision/u);

    const noMeasure = runGate(dir, ["--measure"]);
    assert.equal(noMeasure.status, 2);
    assert.match(noMeasure.report.error, /--measure requires a value/u);

    const missingRepo = spawnSync(process.execPath, [SCRIPT, "--repo", join(dir, "absent"), "--json"], {
      cwd: ROOT, env: gateEnv(), encoding: "utf8",
    });
    assert.equal(missingRepo.status, 2);
    assert.match(JSON.parse(missingRepo.stdout).error, /repository path not found/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an incomplete candidate or target measurement exits 2 instead of reporting success", () => {
  const { dir, base } = gitFixture();
  const originalLog = console.log;
  const originalError = console.error;
  const originalRead = fs.readFileSync;
  const printed = [];
  try {
    console.log = (...args) => printed.push(args.join(" "));
    console.error = (...args) => printed.push(args.join(" "));

    fs.readFileSync = (file, ...rest) => {
      if (String(file) === join(dir, "a.ts")) {
        const error = new Error(`simulated ENOENT for ${file}`);
        error.code = "ENOENT";
        throw error;
      }
      return originalRead.call(fs, file, ...rest);
    };
    const candidateExit = main(["--repo", dir, "--target", base, "--json"], gateEnv());
    assert.equal(candidateExit, 2);
    assert.match(printed.at(-1), /candidate analysis incomplete/u);

    fs.readFileSync = (file, ...rest) => {
      if (String(file).includes(`${sep}tree${sep}`) && String(file).endsWith("a.ts")) {
        const error = new Error(`simulated ENOENT for ${file}`);
        error.code = "ENOENT";
        throw error;
      }
      return originalRead.call(fs, file, ...rest);
    };
    printed.length = 0;
    const targetExit = main(["--repo", dir, "--target", base, "--candidate", base, "--json"], gateEnv());
    assert.equal(targetExit, 2);
    assert.match(printed.at(-1), /target .* analysis incomplete/u);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.readFileSync = originalRead;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two independent measured-file changes pass against one base without a shared file", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const first = branchFrom(dir, baseBranch, "feature-a", "extend a", () => {
      writeFileSync(join(dir, "a.ts"), `${BASE_A}${ADDED_LOW}`);
    });
    const second = branchFrom(dir, baseBranch, "feature-b", "extend b", () => {
      writeFileSync(join(dir, "b.ts"), `${BASE_B}${ADDED_LOW}`);
    });

    const one = runGate(dir, ["--target", base, "--candidate", first]);
    const two = runGate(dir, ["--target", base, "--candidate", second]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(two.status, 0, two.stderr);
    assert.deepEqual(one.report.findings, []);
    assert.deepEqual(two.report.findings, []);

    // Neither run may write a generated snapshot into the repository.
    assert.equal(existsSync(join(dir, "quality")), false);
    assert.equal(git(dir, ["status", "--porcelain"]), "");
    assert.notEqual(one.report.candidate.inputDigest, two.report.candidate.inputDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent checks against the same base are independent and agree", async () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const first = branchFrom(dir, baseBranch, "concurrent-a", "extend a", () => {
      writeFileSync(join(dir, "a.ts"), `${BASE_A}${ADDED_LOW}`);
    });
    const second = branchFrom(dir, baseBranch, "concurrent-b", "extend b", () => {
      writeFileSync(join(dir, "b.ts"), `${BASE_B}${ADDED_LOW}`);
    });
    const [one, two] = await Promise.all([
      runGateAsync(dir, ["--target", base, "--candidate", first]),
      runGateAsync(dir, ["--target", base, "--candidate", second]),
    ]);
    assert.equal(one.status, 0, one.stderr);
    assert.equal(two.status, 0, two.stderr);
    assert.equal(one.report.target.inputDigest, two.report.target.inputDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a moved target is re-measured and changes the target digest without changing the candidate", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const candidate = branchFrom(dir, baseBranch, "moving-candidate", "extend a", () => {
      writeFileSync(join(dir, "a.ts"), `${BASE_A}${ADDED_LOW}`);
    });

    git(dir, ["checkout", "-q", baseBranch]);
    writeFileSync(join(dir, "b.ts"), `${BASE_B}${ADDED_LOW}`);
    const moved = commit(dir, "move the target");

    const before = runGate(dir, ["--target", base, "--candidate", candidate]);
    const after = runGate(dir, ["--target", moved, "--candidate", candidate]);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(after.status, 0, after.stderr);
    assert.notEqual(before.report.target.inputDigest, after.report.target.inputDigest);
    assert.equal(before.report.candidate.inputDigest, after.report.candidate.inputDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--measure prints a revision-bound measurement without comparing", () => {
  const { dir, base } = gitFixture();
  try {
    const result = runGate(dir, ["--measure", base]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.status, "measured");
    assert.equal(result.report.revision, base);
    assert.equal(result.report.scopes.source.maxCyc, 2);
    assert.equal(result.report.policyDigest, policyAt(dir, null).digest);
    assert.equal(result.report.revisionPolicyDigest, policyAt(dir, base).digest);
    assert.ok(Object.hasOwn(result.report.files, "a.ts"));

    const missing = runGate(dir, ["--measure", "no-such-ref"]);
    assert.equal(missing.status, 2);
    assert.match(missing.report.error, /could not resolve revision/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--measure binds the executing policy separately from the measured revision", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "executing-policy", "edit policy", () => {
      writeFileSync(join(dir, "tsconfig.json"), "{ \"strict\": true }\n");
    });
    git(dir, ["checkout", "-q", head]);
    const result = runGate(dir, ["--measure", base]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.policyDigest, policyAt(dir, null).digest);
    assert.equal(result.report.revisionPolicyDigest, policyAt(dir, base).digest);
    assert.notEqual(result.report.policyDigest, result.report.revisionPolicyDigest,
      "a trend point must identify the analyzer that produced it, not the historical tree's policy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy digests normalize CRLF line endings", () => {
  const { dir, base } = gitFixture();
  try {
    writeFileSync(join(dir, "tsconfig.json"), "{}\r\n");
    assert.equal(policyAt(dir, null).digest, policyAt(dir, base).digest);
    writeFileSync(join(dir, "tsconfig.json"), "{ \"strict\": true }\r\n");
    assert.notEqual(policyAt(dir, null).digest, policyAt(dir, base).digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable policy input returns a structured JSON failure", { skip: process.getuid?.() === 0 }, () => {
  const { dir, base } = gitFixture();
  const policy = join(dir, "tsconfig.json");
  try {
    chmodSync(policy, 0o000);
    const result = runGate(dir, ["--target", base]);
    assert.equal(result.status, 2);
    assert.equal(result.report.status, "failed");
    assert.equal(result.report.exitCode, 2);
    assert.match(result.report.error, /could not read policy file tsconfig\.json/u);
  } finally {
    chmodSync(policy, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy digests read each revision's own policy bytes", () => {
  const { dir, base, baseBranch } = gitFixture();
  try {
    const head = branchFrom(dir, baseBranch, "policy-digest", "edit policy", () => {
      writeFileSync(join(dir, "tsconfig.json"), "{ \"strict\": true }\n");
    });
    const atBase = policyAt(dir, base);
    const atHead = policyAt(dir, head);
    git(dir, ["checkout", "-q", head]);
    const inTree = policyAt(dir, null);
    assert.notEqual(atBase.digest, atHead.digest);
    assert.notEqual(atBase.files["tsconfig.json"], atHead.files["tsconfig.json"]);
    assert.equal(atHead.digest, inTree.digest, "the working tree must report its own policy");
    assert.ok(atBase.typescriptRange);
    assert.equal(atBase.typescriptLocked, null);

    const locked = branchFrom(dir, baseBranch, "locked", "bump the analyzer lock", () => {
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/typescript": { version: "6.1.0" } } }));
    });
    const atLocked = policyAt(dir, locked);
    assert.equal(atLocked.typescriptLocked, "6.1.0");
    assert.notEqual(atLocked.digest, atBase.digest, "a lockfile-only analyzer bump must change the policy digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the worktree candidate fingerprint changes when a measured file changes", () => {
  const { dir } = gitFixture();
  try {
    const before = candidateFingerprint(dir);
    assert.equal(before.dirty, false);
    writeFileSync(join(dir, "a.ts"), `${BASE_A}\nexport const changed = true;\n`);
    const after = candidateFingerprint(dir);
    assert.notEqual(after.digest, before.digest);
    assert.equal(after.dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate fingerprint does not follow an untracked symlink", () => {
  const { dir } = gitFixture();
  const target = join(tmpdir(), `bifrost-fingerprint-target-${process.pid}.ts`);
  try {
    writeFileSync(target, "export const before = true;\n");
    symlinkSync(target, join(dir, "linked.ts"));
    const before = candidateFingerprint(dir);
    writeFileSync(target, "export const after = true;\n");
    const after = candidateFingerprint(dir);
    assert.equal(after.digest, before.digest);
  } finally {
    rmSync(target, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate fingerprint includes ignored measured source", () => {
  const { dir } = gitFixture();
  try {
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "ignored.ts"), "export const ignored = 1;\n");
    const before = candidateFingerprint(dir);
    writeFileSync(join(dir, "ignored.ts"), "export const ignored = 2;\n");
    const after = candidateFingerprint(dir);
    assert.notEqual(after.digest, before.digest, "ignored source must be bound to the worktree snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate fingerprint includes staged and untracked source changes", () => {
  const { dir } = gitFixture();
  try {
    const clean = candidateFingerprint(dir);
    writeFileSync(join(dir, "a.ts"), `${BASE_A}\nexport const staged = true;\n`);
    git(dir, ["add", "a.ts"]);
    const staged = candidateFingerprint(dir);
    assert.equal(staged.dirty, true);
    assert.notEqual(staged.digest, clean.digest);

    writeFileSync(join(dir, "untracked.ts"), "export const untracked = true;\n");
    const withUntracked = candidateFingerprint(dir);
    assert.equal(withUntracked.dirty, true);
    assert.notEqual(withUntracked.digest, staged.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measuring a revision does not leave a worktree behind", () => {
  const { dir, base } = gitFixture();
  try {
    const report = measureRevision(dir, base);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.report.files["a.ts"].maxCyc, 2);
    const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, env: fixtureGitEnv(), encoding: "utf8" });
    assert.equal(worktrees.status, 0);
    assert.equal(worktrees.stdout.trim().split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
