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
 *
 * Exit codes: 0 clean/updated, 1 regression, 2 error or missing baseline.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, "package.json"));
const ts = require("typescript");

const DEFAULT_BASELINE = path.join(ROOT, "quality", "complexity-baseline.json");
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "reports", ".worktrees", ".commandcode"]);

function walk(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(full));
    else results.push(full);
  }
  return results;
}

function scopeOf(rel) {
  if (/^[^/]+\.(ts|mjs|cjs)$/.test(rel)) return "source";
  if (rel.startsWith("ui/") || rel.startsWith("scripts/")) return "source";
  if (rel.startsWith("tests/")) return "tests";
  return null;
}

function inScopeFiles(root = ROOT) {
  return walk(root)
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

function analyze({ root = ROOT } = {}) {
  const files = inScopeFiles(root).sort((a, b) => a.rel.localeCompare(b.rel));
  const fileData = {};
  const scopeFuncs = { source: [], tests: [] };
  for (const { file, rel, scope } of files) {
    const text = fs.readFileSync(file, "utf8");
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

function compare(baseline, current) {
  const findings = [];
  for (const scope of ["source", "tests"]) {
    const b = baseline.scopes?.[scope] || {};
    const c = current.scopes?.[scope] || {};
    for (const key of ["maxCyc", "maxCog", "cycGt30", "cycGt50", "cogGt30", "cogGt50"]) {
      if ((c[key] ?? 0) > (b[key] ?? 0)) {
        findings.push({
          rule: `scope-${scope}-${key}-regression`,
          file: "(scope)",
          line: null,
          message: `${scope}.${key} increased: ${b[key] ?? 0} -> ${c[key] ?? 0}`,
        });
      }
    }
  }
  const baselineFiles = baseline.files || {};
  for (const [rel, data] of Object.entries(current.files || {})) {
    const base = baselineFiles[rel];
    if (base) {
      for (const key of ["maxCyc", "maxCog"]) {
        if ((data[key] ?? 0) > (base[key] ?? 0)) {
          findings.push({
            rule: `file-${key}-regression`,
            file: rel,
            line: null,
            message: `${key} increased: ${base[key] ?? 0} -> ${data[key] ?? 0}`,
          });
        }
      }
    } else {
      const scopeBase = (baseline.scopes && baseline.scopes[data.scope]) || {};
      for (const key of ["maxCyc", "maxCog"]) {
        if ((data[key] ?? 0) > (scopeBase[key] ?? 0)) {
          findings.push({
            rule: `new-file-${key}-exceeds-scope-max`,
            file: rel,
            line: null,
            message: `new file ${key} ${data[key] ?? 0} exceeds ${data.scope} baseline max ${scopeBase[key] ?? 0}`,
          });
        }
      }
    }
  }
  // Removed files are improvements; not reported as findings.
  return findings;
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const update = argv.includes("--update-baseline");
  const bIdx = argv.indexOf("--baseline");
  const baselinePath = bIdx !== -1 && argv[bIdx + 1] ? path.resolve(argv[bIdx + 1]) : DEFAULT_BASELINE;

  let current;
  try {
    current = analyze();
  } catch (error) {
    const msg = `complexity analysis failed: ${error.message}`;
    if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 2, findings: [], error: msg }, null, 2));
    else console.error(msg);
    return 2;
  }

  if (update) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    current.generatedAt = new Date().toISOString();
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
    const msg = `Updated complexity baseline: ${path.relative(ROOT, baselinePath)} (source maxCyc=${current.scopes.source.maxCyc}, maxCog=${current.scopes.source.maxCog}, cycGt50=${current.scopes.source.cycGt50}, cogGt50=${current.scopes.source.cogGt50})`;
    if (json) console.log(JSON.stringify({ check: "complexity", status: "passed", exitCode: 0, findings: [], message: msg }, null, 2));
    else console.log(msg);
    return 0;
  }

  if (!fs.existsSync(baselinePath)) {
    const msg = `complexity baseline not found: ${path.relative(ROOT, baselinePath)} (run with --update-baseline)`;
    if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 2, findings: [], error: msg }, null, 2));
    else console.error(msg);
    return 2;
  }

  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    const msg = `could not read complexity baseline: ${error.message}`;
    if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 2, findings: [], error: msg }, null, 2));
    else console.error(msg);
    return 2;
  }

  const findings = compare(baseline, current);
  if (findings.length === 0) {
    const msg = `Complexity budgets OK (source maxCyc=${current.scopes.source.maxCyc}, maxCog=${current.scopes.source.maxCog}, cycGt50=${current.scopes.source.cycGt50}, cogGt50=${current.scopes.source.cogGt50})`;
    if (json) console.log(JSON.stringify({ check: "complexity", status: "passed", exitCode: 0, findings: [], message: msg }, null, 2));
    else console.log(msg);
    return 0;
  }

  if (json) console.log(JSON.stringify({ check: "complexity", status: "failed", exitCode: 1, findings }, null, 2));
  else {
    console.error(`FAIL complexity: ${findings.length} regression(s)`);
    for (const f of findings.slice(0, 40)) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.error(`  ${f.rule}  ${loc}  ${f.message}`);
    }
    if (findings.length > 40) console.error(`  ... ${findings.length - 40} more`);
  }
  return 1;
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
  scopeOf,
  walk,
};

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exitCode = main();
