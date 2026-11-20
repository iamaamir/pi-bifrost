#!/usr/bin/env node
/**
 * Deterministic complexity budget/ratchet for Bifrost.
 *
 * Computes cyclomatic and cognitive (Sonar-inspired approximation) complexity
 * per function-like node using the TypeScript compiler API, then compares
 * against a committed baseline. Fails on regressions so hotspots do not grow
 * while #286 debt is paid down.
 *
 * Usage:
 *   node scripts/check-complexity.mjs [--json] [--baseline <path>]
 *   node scripts/check-complexity.mjs --update-baseline [--baseline <path>]
 *   node scripts/check-complexity.mjs --check-baseline [--baseline <path>]
 *
 * Exit codes: 0 clean/updated, 1 regression or stale baseline, 2 error or
 * missing baseline.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");

const DEFAULT_BASELINE = path.join(ROOT, "quality", "complexity-baseline.json");
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "reports", ".worktrees", ".commandcode"]);
const RECORD_FIELDS = ["lines", "funcs", "maxCyc", "maxCog", "sumCyc", "sumCog"];
const SCOPE_FIELDS = ["files", "functions", "maxCyc", "maxCog", "cycGt30", "cycGt50", "cogGt30", "cogGt50"];

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
// fixture, an editor save, a rebase. Skipping it keeps the gate from crashing on
// a tree that moved. Callers that write a baseline refuse an incomplete snapshot
// instead of recording one that omits a real file.
function readIfPresent(file, rel, skipped) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    skipped.push(rel);
    return null;
  }
}

function analyze({ root = ROOT, skipped = [] } = {}) {
  const files = inScopeFiles(root, skipped).sort((a, b) => a.rel.localeCompare(b.rel));
  const fileData = {};
  const scopeFuncs = { source: [], tests: [] };
  for (const { file, rel, scope } of files) {
    const text = readIfPresent(file, rel, skipped);
    if (text === null) continue;
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
      "Cyclomatic: McCabe-style (base 1 + branches/logical ops). Cognitive: Sonar-inspired approximation (structural/nesting increments, simplified logical chains) for relative hotspots, not exact Sonar parity. Ratchet: source/test scope counts (>30,>50) and maxima must not increase; per-file maxima must not increase for baselined files; new files must not exceed scope baseline maxima.",
    scopes: { source: scopeSummary("source"), tests: scopeSummary("tests") },
    files: sortedFiles,
  };
}

// Provenance only, never compared. A baseline cannot name the commit that will
// contain it, so this records the HEAD its numbers were measured from.
function resolveSourceCommit(env = process.env, cwd = ROOT) {
  const fromCi = env.GITHUB_SHA?.trim();
  if (fromCi) return fromCi;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function staleFinding(file, reason) {
  return { rule: "complexity-baseline-stale", file, line: null, message: `${reason}; run with --update-baseline` };
}

function recordDifferences(rel, base, now) {
  const changed = RECORD_FIELDS
    .filter((key) => (base[key] ?? 0) !== (now[key] ?? 0))
    .map((key) => `${key} ${base[key] ?? 0} -> ${now[key] ?? 0}`);
  return changed.length === 0 ? [] : [{
    rule: "complexity-baseline-stale",
    file: rel,
    line: null,
    message: changed.join(", "),
  }];
}

function scopeDifferences(baseline, current) {
  return ["source", "tests"].flatMap((scope) => SCOPE_FIELDS
    .filter((key) => (baseline.scopes?.[scope]?.[key] ?? 0) !== (current.scopes?.[scope]?.[key] ?? 0))
    .map((key) => `${scope}.${key} ${baseline.scopes?.[scope]?.[key] ?? 0} -> ${current.scopes?.[scope]?.[key] ?? 0}`));
}

// Staleness is not a ratchet regression: the gate can pass while the committed
// ceilings describe a different tree. Compare the whole record, so line and
// function drift fails too, not only maxima.
function stalenessFindings(baseline, current) {
  const baselineFiles = baseline.files ?? {};
  const currentFiles = current.files ?? {};
  const findings = [];
  for (const rel of [...new Set([...Object.keys(baselineFiles), ...Object.keys(currentFiles)])].sort()) {
    if (!baselineFiles[rel]) findings.push(staleFinding(rel, "not recorded in the baseline"));
    else if (!currentFiles[rel]) findings.push(staleFinding(rel, "recorded in the baseline but no longer exists"));
    else findings.push(...recordDifferences(rel, baselineFiles[rel], currentFiles[rel]));
  }
  if (findings.length === 0) {
    const changed = scopeDifferences(baseline, current);
    if (changed.length > 0) findings.push({ rule: "complexity-baseline-stale", file: "(scope)", line: null, message: changed.join(", ") });
  }
  return findings;
}

function runStalenessCheck({ baseline, current, json }) {
  const findings = stalenessFindings(baseline, current);
  if (findings.length > 0) {
    if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 1, findings }, null, 2));
    else {
      console.error(`FAIL complexity baseline: ${findings.length} stale record(s); run --update-baseline`);
      for (const f of findings.slice(0, 40)) console.error(`  ${f.rule}  ${f.file}  ${f.message}`);
      if (findings.length > 40) console.error(`  ... ${findings.length - 40} more`);
    }
    return 1;
  }
  const provenance = baseline.sourceCommit ? `, generated from ${baseline.sourceCommit.slice(0, 12)}` : "";
  const msg = `Complexity baseline matches the tree (${Object.keys(current.files).length} files${provenance})`;
  if (json) console.log(JSON.stringify({ check: "complexity", status: "passed", exitCode: 0, findings: [], message: msg }, null, 2));
  else console.log(msg);
  return 0;
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
function fileFindings(rel, data, baseline) {
  const base = baseline.files?.[rel];
  const ceiling = base ?? (baseline.scopes?.[data.scope] || {});
  return increasedFields(data, ceiling, FILE_RATCHET_FIELDS).map((key) => ({
    rule: base ? `file-${key}-regression` : `new-file-${key}-exceeds-scope-max`,
    file: rel,
    line: null,
    message: base
      ? `${key} increased: ${base[key] ?? 0} -> ${data[key] ?? 0}`
      : `new file ${key} ${data[key] ?? 0} exceeds ${data.scope} baseline max ${ceiling[key] ?? 0}`,
  }));
}

function compare(baseline, current) {
  const findings = scopeFindings(baseline, current);
  for (const [rel, data] of Object.entries(current.files || {})) {
    findings.push(...fileFindings(rel, data, baseline));
  }
  // Removed files are improvements; not reported as findings.
  return findings;
}

function warnVanished(skipped) {
  if (skipped.length === 0) return;
  const shown = skipped.slice(0, 5).join(", ");
  // Entries can be files or a `dir/` marker, so they are paths, not files.
  console.error(`warning: skipped ${skipped.length} path(s) that vanished during analysis: ${shown}${skipped.length > 5 ? ", ..." : ""}`);
}

// The JSON envelope is a contract tests and CI parse, so it is written once.
function emitFailure(json, message) {
  if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 2, findings: [], error: message }, null, 2));
  else console.error(message);
  return 2;
}

function emitPass(json, message) {
  if (json) console.log(JSON.stringify({ check: "complexity", status: "passed", exitCode: 0, findings: [], message }, null, 2));
  else console.log(message);
  return 0;
}

function summary(current) {
  const { maxCyc, maxCog, cycGt50, cogGt50 } = current.scopes.source;
  return `source maxCyc=${maxCyc}, maxCog=${maxCog}, cycGt50=${cycGt50}, cogGt50=${cogGt50}`;
}

function updateBaseline({ current, baselinePath, json, skipped }) {
  if (skipped.length > 0) {
    return emitFailure(json, `refusing to write a baseline from an incomplete analysis: ${skipped.length} file(s) vanished; re-run when the tree is stable`);
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  current.generatedAt = new Date().toISOString();
  current.sourceCommit = resolveSourceCommit();
  fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  return emitPass(json, `Updated complexity baseline: ${path.relative(ROOT, baselinePath)} (${summary(current)})`);
}

function readBaseline(baselinePath, json) {
  if (!fs.existsSync(baselinePath)) {
    return { exitCode: emitFailure(json, `complexity baseline not found: ${path.relative(ROOT, baselinePath)} (run with --update-baseline)`) };
  }
  try {
    return { baseline: JSON.parse(fs.readFileSync(baselinePath, "utf8")) };
  } catch (error) {
    return { exitCode: emitFailure(json, `could not read complexity baseline: ${error.message}`) };
  }
}

function reportBudgets({ findings, current, json }) {
  if (findings.length === 0) return emitPass(json, `Complexity budgets OK (${summary(current)})`);
  if (json) {
    console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 1, findings }, null, 2));
    return 1;
  }
  console.error(`FAIL complexity: ${findings.length} regression(s)`);
  for (const finding of findings.slice(0, 40)) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${finding.rule}  ${location}  ${finding.message}`);
  }
  if (findings.length > 40) console.error(`  ... ${findings.length - 40} more`);
  return 1;
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const update = argv.includes("--update-baseline");
  const stale = argv.includes("--check-baseline");
  const bIdx = argv.indexOf("--baseline");
  const baselinePath = bIdx !== -1 && argv[bIdx + 1] ? path.resolve(argv[bIdx + 1]) : DEFAULT_BASELINE;

  const skipped = [];
  let current;
  try {
    current = analyze({ skipped });
  } catch (error) {
    return emitFailure(json, `complexity analysis failed: ${error.message}`);
  }
  warnVanished(skipped);

  if (update) return updateBaseline({ current, baselinePath, json, skipped });

  const loaded = readBaseline(baselinePath, json);
  if (loaded.exitCode !== undefined) return loaded.exitCode;
  if (stale) return runStalenessCheck({ baseline: loaded.baseline, current, json });
  return reportBudgets({ findings: compare(loaded.baseline, current), current, json });
}

export {
  analyze,
  cognitive,
  compare,
  cyclomatic,
  getName,
  inScopeFiles,
  isFunctionLike,
  main,
  resolveSourceCommit,
  scopeOf,
  stalenessFindings,
  walk,
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exitCode = main();
