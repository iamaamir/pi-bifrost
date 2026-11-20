import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { analyze, compare, cyclomatic, cognitive, inScopeFiles, main, scopeOf } from "../scripts/check-complexity.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compare accepts unchanged, flags increased and new files over scope max, and ignores removed files", () => {
  const root = fixtureRoot();
  try {
    const baseline = analyze({ root });
    const unchanged = analyze({ root });
    assert.deepEqual(compare(baseline, unchanged), []);

    const increased = structuredClone(unchanged);
    increased.files["a.ts"].maxCyc = baseline.files["a.ts"].maxCyc + 1;
    increased.scopes.source.maxCyc = baseline.scopes.source.maxCyc + 1;
    const incFindings = compare(baseline, increased);
    assert.ok(incFindings.some((f) => f.rule === "file-maxCyc-regression" && f.file === "a.ts"));
    assert.ok(incFindings.some((f) => f.rule === "scope-source-maxCyc-regression"));

    const added = structuredClone(unchanged);
    added.files["z-new.ts"] = { scope: "source", lines: 10, funcs: 1, maxCyc: baseline.scopes.source.maxCyc + 1, maxCog: 1, sumCyc: 1, sumCog: 1 };
    added.scopes.source.files += 1;
    added.scopes.source.functions += 1;
    added.scopes.source.maxCyc = baseline.scopes.source.maxCyc + 1;
    const addFindings = compare(baseline, added);
    assert.ok(addFindings.some((f) => f.rule === "new-file-maxCyc-exceeds-scope-max" && f.file === "z-new.ts"));

    const removed = structuredClone(unchanged);
    delete removed.files["tests/a.test.ts"];
    removed.scopes.tests = { files: 0, functions: 0, maxCyc: 0, maxCog: 0, cycGt30: 0, cycGt50: 0, cogGt30: 0, cogGt50: 0 };
    assert.deepEqual(compare(baseline, removed), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main reports a missing baseline as a deterministic error", () => {
  const missing = join(tmpdir(), `missing-complexity-baseline-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/check-complexity.mjs"), "--baseline", missing, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.exitCode, 2);
  assert.match(parsed.error, /complexity baseline not found/);

  const result2 = spawnSync(process.execPath, [join(ROOT, "scripts/check-complexity.mjs"), "--baseline", missing], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result2.status, 2);
  assert.match(result2.stderr, /complexity baseline not found/);
});
