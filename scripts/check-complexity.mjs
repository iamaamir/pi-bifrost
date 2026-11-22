#!/usr/bin/env node
/**
 * Deterministic complexity budget/ratchet for Bifrost.
 *
 * Computes cyclomatic and cognitive (Sonar-inspired approximation) complexity
 * per function-like node using the TypeScript compiler API, then compares the
 * candidate tree against the same measurement of a target git revision. Nothing
 * is read from a generated metrics file: both sides are measured from source, so
 * routine changes never update a shared snapshot.
 *
 * Usage:
 *   node scripts/check-complexity.mjs [--target <rev>] [--candidate <rev>] [--json]
 *   node scripts/check-complexity.mjs --measure <rev> [--json]
 *
 * The target defaults to BIFROST_COMPLEXITY_BASE, GITHUB_BASE_SHA, then the
 * merge-base with origin/main or main. There is no implicit HEAD^ fallback:
 * pass --target HEAD^ explicitly for a local last-commit comparison. The
 * candidate defaults to the working tree. `--measure` prints one revision's
 * measurements for historical trends.
 *
 * A change to the analyzer, thresholds, file-selection policy, measurement
 * dependency, or CI wiring changes the policy digest at one revision and fails
 * closed unless `--allow-policy-change` records a reviewed decision.
 *
 * Exit codes: 0 clean, 1 regression, 2 error, incomplete input, unavailable
 * revision, or an unacknowledged policy change.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "reports", ".worktrees", ".commandcode"]);
const POLICY_FILES = [
  "scripts/check-complexity.mjs",
  ".github/workflows/complexity-gate.yml",
  ".github/workflows/static-analysis.yml",
  ".github/workflows/verification.yml",
  "tsconfig.json",
];
const POLICY_SCRIPTS = ["check:complexity", "check:complexity:base"];

function walk(dir, root = dir, skipped = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A directory can vanish mid-walk on a live machine; its files are gone from
    // this snapshot too, so the caller must know the analysis is incomplete.
    if (error?.code !== "ENOENT") throw error;
    skipped.push(`${path.relative(root, dir) || "."}/`);
    return [];
  }
  let results = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    // A PR can add a symlink under a measured path; following it would read
    // outside the revision tree. Symlinks are not source for this metric.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(full, root, skipped));
    else results.push(full);
  }
  return results;
}

function scopeOf(rel) {
  const normalized = rel.replace(/\\/g, "/");
  if (/^[^/]+\.(ts|mjs|cjs)$/.test(normalized)) return "source";
  if (normalized.startsWith("ui/") || normalized.startsWith("scripts/")) return "source";
  if (normalized.startsWith("tests/")) return "tests";
  return null;
}

function inScopeFiles(root = ROOT, skipped = []) {
  return walk(root, root, skipped)
    .filter((f) => /\.(ts|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => {
      const rel = path.relative(root, f).replace(/\\/g, "/");
      return { file: f, rel, scope: scopeOf(rel) };
    })
    .filter((x) => x.scope);
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function getName(node, sourceFile) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name ? node.name.getText(sourceFile) : "(anonymous)";
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && p.name) return p.name.getText(sourceFile);
  if (p && ts.isPropertyAssignment(p) && p.name) return p.name.getText(sourceFile);
  if (p && ts.isPropertyDeclaration(p) && p.name) return p.name.getText(sourceFile);
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return p.left.getText(sourceFile);
  }
  if (p && ts.isCallExpression(p)) return "(callback)";
  return "(anonymous)";
}

function cyclomatic(node) {
  let c = 1;
  function visit(n) {
    if (n !== node && isFunctionLike(n)) return;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        c++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = n.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          c++;
        break;
      }
    }
    ts.forEachChild(n, visit);
  }
  if (node.body) visit(node.body);
  else ts.forEachChild(node, visit);
  return c;
}

// Cognitive complexity approximation (Sonar-inspired, simplified):
// +1 (+nesting) for breaks in linear flow, +1 for else, structural increments
// for logical operator sequences. Useful for relative hotspots/ratcheting, not
// exact Sonar parity.
function cognitive(node) {
  let score = 0;
  const LOGICAL = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
  ]);
  function isLogicalExpr(e) {
    return ts.isBinaryExpression(e) && LOGICAL.has(e.operatorToken.kind);
  }
  function countLogicalHeads(expr) {
    if (!isLogicalExpr(expr)) return 0;
    const op = expr.operatorToken.kind;
    const leftSame = isLogicalExpr(expr.left) && expr.left.operatorToken.kind === op;
    let count = leftSame ? 0 : 1;
    count += countLogicalHeads(expr.left);
    count += countLogicalHeads(expr.right);
    return count;
  }
  function addLogical(expr, nesting, isCondition) {
    const heads = countLogicalHeads(expr);
    if (heads > 0) {
      score += heads;
      if (isCondition) score += nesting * heads;
    }
  }
  function visit(n, nesting, inConditionCtx = false) {
    if (!n) return;
    if (n !== node && isFunctionLike(n)) return;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: {
        const isElseIf = ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
        score += isElseIf ? 1 : 1 + nesting;
        addLogical(n.expression, nesting, true);
        visit(n.expression, nesting, true);
        visit(n.thenStatement, nesting + 1, false);
        if (n.elseStatement) {
          if (ts.isIfStatement(n.elseStatement)) visit(n.elseStatement, nesting, false);
          else {
            score += 1;
            visit(n.elseStatement, nesting + 1, false);
          }
        }
        return;
      }
      case ts.SyntaxKind.ConditionalExpression:
        score += 1 + nesting;
        addLogical(n.condition, nesting, true);
        visit(n.condition, nesting, true);
        visit(n.whenTrue, nesting + 1, false);
        visit(n.whenFalse, nesting + 1, false);
        return;
      case ts.SyntaxKind.SwitchStatement:
        score += 1 + nesting;
        visit(n.expression, nesting, true);
        n.caseBlock.clauses.forEach((c) => visit(c, nesting + 1, false));
        return;
      case ts.SyntaxKind.ForStatement:
        score += 1 + nesting;
        if (n.initializer) visit(n.initializer, nesting, false);
        if (n.condition) {
          addLogical(n.condition, nesting, true);
          visit(n.condition, nesting, true);
        }
        if (n.incrementor) visit(n.incrementor, nesting, false);
        visit(n.statement, nesting + 1, false);
        return;
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
        score += 1 + nesting;
        visit(n.expression, nesting, false);
        visit(n.statement, nesting + 1, false);
        return;
      case ts.SyntaxKind.WhileStatement:
        score += 1 + nesting;
        addLogical(n.expression, nesting, true);
        visit(n.expression, nesting, true);
        visit(n.statement, nesting + 1, false);
        return;
      case ts.SyntaxKind.DoStatement:
        score += 1 + nesting;
        visit(n.statement, nesting + 1, false);
        addLogical(n.expression, nesting, true);
        visit(n.expression, nesting, true);
        return;
      case ts.SyntaxKind.CatchClause:
        score += 1 + nesting;
        visit(n.block, nesting + 1, false);
        return;
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
        if (n.label) score += 1;
        ts.forEachChild(n, (child) => visit(child, nesting, false));
        return;
      case ts.SyntaxKind.BinaryExpression:
        if (isLogicalExpr(n) && !inConditionCtx) {
          const op = n.operatorToken.kind;
          const parentSame = ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === op;
          if (!parentSame) score += 1;
        }
        ts.forEachChild(n, (child) => visit(child, nesting, inConditionCtx));
        return;
      default:
        ts.forEachChild(n, (child) => visit(child, nesting, false));
    }
  }
  if (node.body) visit(node.body, 0, false);
  else ts.forEachChild(node, (child) => visit(child, 0, false));
  return score;
}

// A file can disappear between the walk and the read on a live machine: a test
// fixture, an editor save, a rebase. The caller must refuse the incomplete
// snapshot; a partial measurement cannot support a verdict.
function readIfPresent(file, rel, skipped) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    skipped.push(rel);
    return null;
  }
}

// Compare paths by code-unit order, not locale order, so the digest is stable
// across environments. Line endings are normalized because a Windows checkout
// can materialize CRLF for the same committed content.
function byPath(a, b) {
  if (a.rel === b.rel) return 0;
  return a.rel < b.rel ? -1 : 1;
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

function analyze({ root = ROOT, skipped = [] } = {}) {
  const files = inScopeFiles(root, skipped).sort(byPath);
  const fileData = {};
  const scopeFuncs = { source: [], tests: [] };
  // The digest binds a report to the exact bytes that produced it, so a verdict
  // can be reproduced from a revision rather than trusted from a saved number.
  const digest = createHash("sha256");
  for (const { file, rel, scope } of files) {
    const text = readIfPresent(file, rel, skipped);
    if (text === null) continue;
    digest.update(`${rel}\0${normalizeText(text)}\0`);
    const scriptKind = /\.(mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
    const funcs = [];
    function walkNode(n) {
      if (isFunctionLike(n) && n.body) {
        const start = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
        const cyc = cyclomatic(n);
        const cog = cognitive(n);
        const fn = { name: getName(n, sourceFile), line: start, len: end - start + 1, cyc, cog };
        funcs.push(fn);
        scopeFuncs[scope].push({ file: rel, ...fn });
      }
      ts.forEachChild(n, walkNode);
    }
    walkNode(sourceFile);
    const maxCyc = funcs.reduce((m, f) => Math.max(m, f.cyc), 0);
    const maxCog = funcs.reduce((m, f) => Math.max(m, f.cog), 0);
    const sumCyc = funcs.reduce((s, f) => s + f.cyc, 0);
    const sumCog = funcs.reduce((s, f) => s + f.cog, 0);
    fileData[rel] = {
      scope,
      lines: text.split(/\r?\n/).length,
      funcs: funcs.length,
      maxCyc,
      maxCog,
      sumCyc,
      sumCog,
    };
  }

  function scopeSummary(scope) {
    const fns = scopeFuncs[scope];
    const filesIn = Object.values(fileData).filter((f) => f.scope === scope);
    const cycGt30 = fns.filter((f) => f.cyc > 30).length;
    const cycGt50 = fns.filter((f) => f.cyc > 50).length;
    const cogGt30 = fns.filter((f) => f.cog > 30).length;
    const cogGt50 = fns.filter((f) => f.cog > 50).length;
    return {
      files: filesIn.length,
      functions: fns.length,
      maxCyc: fns.reduce((m, f) => Math.max(m, f.cyc), 0),
      maxCog: fns.reduce((m, f) => Math.max(m, f.cog), 0),
      cycGt30,
      cycGt50,
      cogGt30,
      cogGt50,
    };
  }

  const sortedFiles = {};
  for (const rel of Object.keys(fileData).sort()) sortedFiles[rel] = fileData[rel];
  return {
    version: 1,
    note:
      "Cyclomatic: McCabe-style (base 1 + branches/logical ops). Cognitive: Sonar-inspired approximation (structural/nesting increments, simplified logical chains) for relative hotspots, not exact Sonar parity. Ratchet: source/test scope counts (>30,>50) and maxima must not increase against the target revision; per-file maxima must not increase; new files must not exceed the target scope maxima.",
    inputDigest: digest.digest("hex"),
    scopes: { source: scopeSummary("source"), tests: scopeSummary("tests") },
    files: sortedFiles,
  };
}

// Git plumbing. Both sides of every comparison are measured from source; there
// is deliberately no path for a saved metrics file to influence a verdict.

function gitRun(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function resolveRevision(repo, ref) {
  if (!ref) return null;
  const result = gitRun(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function mergeBase(repo, ref, candidate = "HEAD") {
  if (resolveRevision(repo, ref) === null || resolveRevision(repo, candidate) === null) return null;
  const result = gitRun(repo, ["merge-base", candidate, ref]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// The target is a revision, never a committed measurement. An explicit or
// environment-named revision is authoritative: if it does not resolve the gate
// fails instead of quietly comparing against a different tree.
function resolveTarget({ repo = ROOT, explicit = null, env = process.env, candidate = "HEAD" } = {}) {
  const fromEnv = env.BIFROST_COMPLEXITY_BASE?.trim() || env.GITHUB_BASE_SHA?.trim() || null;
  const requested = explicit ?? fromEnv;
  if (requested !== null) {
    const sha = resolveRevision(repo, requested);
    if (!sha) return { error: `could not resolve target revision ${requested}` };
    const source = explicit !== null ? "--target" : (env.BIFROST_COMPLEXITY_BASE?.trim() ? "BIFROST_COMPLEXITY_BASE" : "GITHUB_BASE_SHA");
    return { sha, source };
  }
  for (const ref of ["origin/main", "main"]) {
    const sha = mergeBase(repo, ref, candidate);
    if (sha) return { sha, source: `merge-base ${candidate} ${ref}` };
  }
  return {
    error: "no target revision: pass --target <rev>, set BIFROST_COMPLEXITY_BASE, or provide origin/main or main; use --target HEAD^ explicitly for a last-commit comparison",
  };
}

function revisionText(repo, revision, rel) {
  if (revision === null) {
    try {
      return fs.readFileSync(path.join(repo, rel), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  const result = gitRun(repo, ["show", `${revision}:${rel}`]);
  return result.status === 0 ? result.stdout : null;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// The policy digest covers every committed input that can change what the metric
// means or which tree is judged. It is read from each revision's own bytes, so a
// candidate cannot borrow the target's policy claim. Policy text is normalized
// the same way as measured source so a CRLF checkout is not a policy change.
function policyText(repo, revision, rel) {
  try {
    return { text: revisionText(repo, revision, rel) };
  } catch (error) {
    return { error: `could not read policy file ${rel} at ${revision ?? "the working tree"}: ${error.message}` };
  }
}

function policyAt(repo, revision) {
  const files = {};
  const missing = [];
  for (const rel of POLICY_FILES) {
    const read = policyText(repo, revision, rel);
    if (read.error) return read;
    const text = read.text;
    // A missing file is a policy change when the other revision has it. The
    // caller rejects the case where both revisions are missing it, so a typo in
    // POLICY_FILES cannot silently shrink the trust boundary.
    if (text === null) {
      files[rel] = null;
      missing.push(rel);
    } else {
      files[rel] = sha256(normalizeText(text));
    }
  }
  const manifestRead = policyText(repo, revision, "package.json");
  if (manifestRead.error) return manifestRead;
  const manifestText = manifestRead.text;
  if (manifestText === null) return { error: `package.json is unavailable at ${revision ?? "the working tree"}` };
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { error: `could not parse package.json at ${revision ?? "the working tree"}: ${error.message}` };
  }
  const scripts = Object.fromEntries(POLICY_SCRIPTS.map((name) => [name, manifest.scripts?.[name] ?? null]));
  const typescriptRange = manifest.devDependencies?.typescript ?? null;
  // The installed analyzer version can change through a lockfile-only update, so
  // record the resolved version rather than hashing the whole lockfile.
  const lockRead = policyText(repo, revision, "package-lock.json");
  if (lockRead.error) return lockRead;
  const lockText = lockRead.text;
  let typescriptLocked = null;
  if (lockText !== null) {
    try {
      const lock = JSON.parse(lockText);
      typescriptLocked = lock.packages?.["node_modules/typescript"]?.version ?? lock.dependencies?.typescript?.version ?? null;
    } catch (error) {
      return { error: `could not parse package-lock.json at ${revision ?? "the working tree"}: ${error.message}` };
    }
  }
  const digest = sha256(JSON.stringify({ files, scripts, typescriptRange, typescriptLocked, typescriptVersion: ts.version }));
  return { digest, files, missing, scripts, typescriptRange, typescriptLocked, typescriptVersion: ts.version };
}

function policyDifferences(target, candidate) {
  const changed = [];
  for (const [file, hash] of Object.entries(target.files ?? {})) {
    if (candidate.files?.[file] !== hash) changed.push(file);
  }
  for (const name of POLICY_SCRIPTS) {
    if (target.scripts?.[name] !== candidate.scripts?.[name]) changed.push(`package.json scripts.${name}`);
  }
  if (target.typescriptRange !== candidate.typescriptRange) changed.push("package.json devDependencies.typescript");
  if (target.typescriptLocked !== candidate.typescriptLocked) changed.push("package-lock.json typescript");
  return changed;
}

// A detached worktree makes the target's source tree measurable without writing
// into the repository under test. A unique temporary path keeps concurrent runs
// independent.
function withRevisionTree(repo, sha, fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bifrost-complexity-"));
  const tree = path.join(base, "tree");
  const added = gitRun(repo, ["worktree", "add", "--detach", "--force", tree, sha]);
  if (added.status !== 0) {
    fs.rmSync(base, { recursive: true, force: true });
    throw new Error(`could not check out ${sha}: ${String(added.stderr ?? "").trim() || "git worktree add failed"}`);
  }
  try {
    return fn(tree);
  } finally {
    gitRun(repo, ["worktree", "remove", "--force", tree]);
    fs.rmSync(base, { recursive: true, force: true });
    // Best effort: a killed earlier run can leave stale administrative entries.
    gitRun(repo, ["worktree", "prune"]);
  }
}

function measureRoot(root) {
  const skipped = [];
  const report = analyze({ root, skipped });
  return { report, skipped };
}

function measureRevision(repo, sha) {
  return withRevisionTree(repo, sha, (tree) => measureRoot(tree));
}

// Git rename detection is the only identity signal available without a
// committed snapshot. Carry the old path's per-file ceiling forward when Git
// recognizes a rename; otherwise the new path is judged by the scope ceiling.
function renameMap(repo, targetSha, candidateSha) {
  const args = ["diff", "--find-renames=50%", "--name-status", "-z", targetSha];
  if (candidateSha) args.push(candidateSha);
  args.push("--");
  const result = gitRun(repo, args);
  if (result.status !== 0) return { error: `could not inspect tree changes for renames: ${String(result.stderr ?? "").trim() || "git diff failed"}` };
  const tokens = result.stdout.split("\0");
  const map = {};
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R")) {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from && to) map[to.replace(/\\/g, "/")] = from.replace(/\\/g, "/");
    } else if (status.startsWith("C")) {
      index += 2;
    } else {
      index += 1;
    }
  }
  return { map };
}

// A working-tree candidate is not an immutable tree. Hash HEAD, the porcelain
// status, and the bytes of every modified or untracked file before and after the
// measurement; a change means the report would describe a moving target. CI
// passes an explicit --candidate commit and does not rely on this guard.
function candidateFingerprint(repo) {
  const head = gitRun(repo, ["rev-parse", "HEAD"]);
  const status = gitRun(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (head.status !== 0 || status.status !== 0) return { error: "could not inspect the candidate worktree" };
  const changed = gitRun(repo, ["ls-files", "-m", "-o", "--exclude-standard", "-z"]);
  if (changed.status !== 0) return { error: "could not enumerate candidate changes" };
  const digest = createHash("sha256");
  digest.update(head.stdout.trim()).update("\0").update(status.stdout);
  for (const rel of changed.stdout.split("\0").filter(Boolean).sort()) {
    digest.update(rel).update("\0");
    try {
      digest.update(fs.readFileSync(path.join(repo, rel)));
    } catch (error) {
      // A deleted tracked path is represented in porcelain status; its missing
      // content is intentional, not a read failure.
      if (error?.code !== "ENOENT") return { error: `could not read candidate file ${rel}: ${error.message}` };
    }
  }
  return { digest: digest.digest("hex"), dirty: status.stdout.trim() !== "" };
}

const SCOPE_RATCHET_FIELDS = ["maxCyc", "maxCog", "cycGt30", "cycGt50", "cogGt30", "cogGt50"];
const FILE_RATCHET_FIELDS = ["maxCyc", "maxCog"];

function increasedFields(actual, ceiling, fields) {
  return fields.filter((key) => (actual[key] ?? 0) > (ceiling[key] ?? 0));
}

function scopeFindings(baseline, current) {
  return ["source", "tests"].flatMap((scope) => {
    const before = baseline.scopes?.[scope] || {};
    const after = current.scopes?.[scope] || {};
    return increasedFields(after, before, SCOPE_RATCHET_FIELDS).map((key) => ({
      rule: `scope-${scope}-${key}-regression`,
      file: "(scope)",
      line: null,
      message: `${scope}.${key} increased: ${before[key] ?? 0} -> ${after[key] ?? 0}`,
    }));
  });
}

// A baselined file is judged against its own record; a new file is judged against
// its scope ceiling until the first baseline that records it.
function fileFindings(rel, data, baseline, renamedFrom = null) {
  const base = baseline.files?.[renamedFrom ?? rel];
  const ceiling = base ?? (baseline.scopes?.[data.scope] || {});
  return increasedFields(data, ceiling, FILE_RATCHET_FIELDS).map((key) => ({
    rule: base ? `file-${key}-regression` : `new-file-${key}-exceeds-scope-max`,
    file: rel,
    line: null,
    message: base
      ? `${key} increased${renamedFrom ? ` after rename from ${renamedFrom}` : ""}: ${base[key] ?? 0} -> ${data[key] ?? 0}`
      : `new file ${key} ${data[key] ?? 0} exceeds ${data.scope} baseline max ${ceiling[key] ?? 0}`,
  }));
}

function compare(baseline, current, renames = {}) {
  const findings = scopeFindings(baseline, current);
  for (const [rel, data] of Object.entries(current.files || {})) {
    findings.push(...fileFindings(rel, data, baseline, renames[rel] ?? null));
  }
  // Removed files are improvements; not reported as findings. A detected rename
  // keeps the old path's ceiling instead of granting the new path a fresh one.
  return findings;
}

function summary(report) {
  const source = report.scopes?.source ?? {};
  return `source maxCyc=${source.maxCyc ?? 0}, maxCog=${source.maxCog ?? 0}, cycGt50=${source.cycGt50 ?? 0}, cogGt50=${source.cogGt50 ?? 0}`;
}

function targetEnvelope({ sha, source, report, policy }) {
  return {
    revision: sha,
    source,
    inputDigest: report?.inputDigest ?? null,
    policyDigest: policy?.digest ?? null,
    scopes: report?.scopes ?? null,
  };
}

function candidateEnvelope({ mode, revision, dirty }, report, policy) {
  return {
    mode,
    revision: revision ?? null,
    dirty: dirty ?? null,
    inputDigest: report?.inputDigest ?? null,
    policyDigest: policy?.digest ?? null,
    scopes: report?.scopes ?? null,
  };
}

function printEnvelope(envelope, json) {
  if (json) console.log(JSON.stringify(envelope, null, 2));
  return envelope.exitCode;
}

function failure({ json, message, target, candidate, policy }) {
  const envelope = {
    check: "complexity",
    status: "failed",
    exitCode: 2,
    ...(target ? { target } : {}),
    ...(candidate ? { candidate } : {}),
    ...(policy ? { policy } : {}),
    findings: [],
    error: message,
  };
  if (!json) console.error(message);
  return printEnvelope(envelope, json);
}

function policyFailure({ json, target, candidate, policy }) {
  const message = "complexity policy differs between the target and the candidate; review the analyzer/scope/threshold/CI change, then re-run with --allow-policy-change (CI: quality-policy-change label)";
  const envelope = {
    check: "complexity",
    status: "failed",
    exitCode: 2,
    target,
    candidate,
    policy,
    findings: [{ rule: "complexity-policy-changed", file: "(policy)", line: null, message }],
    error: message,
  };
  if (!json) {
    console.error(`FAIL complexity policy: ${policy.differences.join(", ") || "policy digest differs"}`);
    console.error(`  target ${target.revision} policy ${policy.targetDigest.slice(0, 16)}`);
    console.error(`  candidate ${candidate.revision ?? "working tree"} policy ${policy.candidateDigest.slice(0, 16)}`);
    console.error("  review the analyzer/scope/threshold/CI change, then re-run with --allow-policy-change");
  }
  return printEnvelope(envelope, json);
}

function incompleteError(label, result) {
  const shown = result.skipped.slice(0, 5).join(", ");
  return `${label} analysis incomplete: ${result.skipped.length} path(s) vanished or could not be read (${shown}${result.skipped.length > 5 ? ", ..." : ""})`;
}

function report({ json, findings, target, candidate, policy }) {
  if (findings.length === 0) {
    const message = `Complexity budgets OK against ${target.revision.slice(0, 12)} (${summary(candidate)})`;
    const envelope = { check: "complexity", status: "passed", exitCode: 0, target, candidate, policy, findings: [], message };
    if (!json) console.log(message);
    return printEnvelope(envelope, json);
  }
  const envelope = { check: "complexity", status: "failed", exitCode: 1, target, candidate, policy, findings };
  if (!json) {
    console.error(`FAIL complexity against ${target.revision.slice(0, 12)}: ${findings.length} regression(s)`);
    for (const finding of findings.slice(0, 40)) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      console.error(`  ${finding.rule}  ${location}  ${finding.message}`);
    }
    if (findings.length > 40) console.error(`  ... ${findings.length - 40} more`);
  }
  return printEnvelope(envelope, json);
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return { present: false, value: null };
  const value = argv[index + 1];
  return { present: true, value: value && !value.startsWith("--") ? value : null };
}

function isEnabled(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function parseInvocation(argv, env) {
  const options = {};
  for (const name of ["repo", "target", "candidate", "measure"]) {
    const parsed = option(argv, `--${name}`);
    if (parsed.present && parsed.value === null) return { error: `--${name} requires a value` };
    options[name] = parsed;
  }
  if (options.measure.present && (options.target.present || options.candidate.present)) {
    return { error: "--measure cannot be combined with --target or --candidate" };
  }
  return {
    json: argv.includes("--json"),
    allowPolicy: argv.includes("--allow-policy-change") || isEnabled(env.BIFROST_COMPLEXITY_ALLOW_POLICY_CHANGE),
    env,
    ...options,
  };
}

function measureCommand({ json, repo, revision }) {
  const sha = resolveRevision(repo, revision);
  if (!sha) return failure({ json, message: `could not resolve revision ${revision}` });
  let result;
  try {
    result = measureRevision(repo, sha);
  } catch (error) {
    return failure({ json, message: `complexity analysis failed for ${sha}: ${error.message}` });
  }
  if (result.skipped.length > 0) return failure({ json, message: incompleteError(`revision ${sha}`, result) });
  // A trend point is comparable only when the policy that produced it matches.
  // The executing policy is the current tree (the analyzer that ran); the
  // measured revision's own policy is recorded separately for provenance.
  const executingPolicy = policyAt(repo, null);
  if (executingPolicy.error) return failure({ json, message: executingPolicy.error });
  const revisionPolicy = policyAt(repo, sha);
  if (revisionPolicy.error) return failure({ json, message: revisionPolicy.error });
  const envelope = {
    check: "complexity",
    status: "measured",
    exitCode: 0,
    revision: sha,
    inputDigest: result.report.inputDigest,
    policyDigest: executingPolicy.digest,
    revisionPolicyDigest: revisionPolicy.digest,
    tool: { typescriptVersion: ts.version },
    scopes: result.report.scopes,
    files: result.report.files,
  };
  if (!json) console.log(`Measured ${sha} (${summary(result.report)})`);
  return printEnvelope(envelope, json);
}

function resolveCandidate({ repo, option: parsed }) {
  if (!parsed.present) {
    const revision = resolveRevision(repo, "HEAD");
    return revision ? { mode: "worktree", revision } : { error: "could not resolve candidate HEAD" };
  }
  const sha = resolveRevision(repo, parsed.value);
  return sha
    ? { mode: "revision", revision: sha, dirty: false }
    : { error: `could not resolve candidate revision ${parsed.value}` };
}

function measureAndReport({ json, repo, resolved, candidate, targetPolicy, candidatePolicy, policy }) {
  let targetResult;
  let candidateResult;
  let candidateBefore = null;
  try {
    targetResult = measureRevision(repo, resolved.sha);
    if (targetResult.skipped.length > 0) return failure({ json, message: incompleteError(`target ${resolved.sha}`, targetResult) });
    if (candidate.mode === "worktree") {
      candidateBefore = candidateFingerprint(repo);
      if (candidateBefore.error) return failure({ json, message: candidateBefore.error });
      candidate.dirty = candidateBefore.dirty;
      candidateResult = measureRoot(repo);
      const candidateAfter = candidateFingerprint(repo);
      if (candidateAfter.error) return failure({ json, message: candidateAfter.error });
      if (candidateAfter.digest !== candidateBefore.digest) {
        return failure({ json, message: "candidate changed during analysis; rerun with --candidate <commit> against an immutable tree" });
      }
    } else {
      candidateResult = measureRevision(repo, candidate.revision);
    }
    if (candidateResult.skipped.length > 0) return failure({ json, message: incompleteError("candidate", candidateResult) });
    const renames = renameMap(repo, resolved.sha, candidate.mode === "revision" ? candidate.revision : null);
    if (renames.error) return failure({ json, message: renames.error });
    return report({
      json,
      findings: compare(targetResult.report, candidateResult.report, renames.map),
      target: targetEnvelope({ sha: resolved.sha, source: resolved.source, report: targetResult.report, policy: targetPolicy }),
      candidate: candidateEnvelope(candidate, candidateResult.report, candidatePolicy),
      policy,
    });
  } catch (error) {
    return failure({ json, message: `complexity analysis failed: ${error.message}` });
  }
}

function compareCommand({ invocation, repo }) {
  const { json, allowPolicy, env } = invocation;
  const candidate = resolveCandidate({ repo, option: invocation.candidate });
  if (candidate.error) return failure({ json, message: candidate.error });
  const resolved = resolveTarget({
    repo,
    explicit: invocation.target.present ? invocation.target.value : null,
    env,
    candidate: candidate.mode === "revision" ? candidate.revision : "HEAD",
  });
  if (resolved.error) return failure({ json, message: resolved.error });

  const targetPolicy = policyAt(repo, resolved.sha);
  if (targetPolicy.error) return failure({ json, message: targetPolicy.error });
  const candidatePolicy = policyAt(repo, candidate.mode === "revision" ? candidate.revision : null);
  if (candidatePolicy.error) return failure({ json, message: candidatePolicy.error });

  const missingAtBoth = targetPolicy.missing.filter((file) => candidatePolicy.missing.includes(file));
  if (missingAtBoth.length > 0) {
    return failure({ json, message: `policy file(s) unavailable at both revisions: ${missingAtBoth.join(", ")}` });
  }

  const changed = targetPolicy.digest !== candidatePolicy.digest;
  const policy = {
    changed,
    differences: changed ? policyDifferences(targetPolicy, candidatePolicy) : [],
    targetDigest: targetPolicy.digest,
    candidateDigest: candidatePolicy.digest,
  };
  if (changed && !allowPolicy) {
    return policyFailure({
      json,
      target: targetEnvelope({ sha: resolved.sha, source: resolved.source, policy: targetPolicy }),
      candidate: candidateEnvelope(candidate, null, candidatePolicy),
      policy,
    });
  }
  return measureAndReport({ json, repo, resolved, candidate, targetPolicy, candidatePolicy, policy });
}

function main(argv = process.argv.slice(2), env = process.env) {
  const invocation = parseInvocation(argv, env);
  const json = argv.includes("--json");
  if (invocation.error) return failure({ json, message: invocation.error });

  const repo = invocation.repo.present ? path.resolve(invocation.repo.value) : ROOT;
  if (!fs.existsSync(repo)) return failure({ json, message: `repository path not found: ${repo}` });
  if (invocation.measure.present) return measureCommand({ json, repo, revision: invocation.measure.value });
  return compareCommand({ invocation, repo });
}

export {
  analyze,
  candidateFingerprint,
  cognitive,
  compare,
  cyclomatic,
  getName,
  inScopeFiles,
  isFunctionLike,
  main,
  measureRevision,
  policyAt,
  renameMap,
  resolveRevision,
  resolveTarget,
  scopeOf,
  withRevisionTree,
  walk,
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exitCode = main();
