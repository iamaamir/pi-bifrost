import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLintSummary, parseLintOutput } from "../scripts/lint-summary.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function counts(entries) {
  return Object.fromEntries(entries.map(({ rule, count }) => [rule, count]));
}

test("empty lint output has no warnings or errors", () => {
  const parsed = parseLintOutput("");
  assert.equal(parsed.warnings.total, 0);
  assert.equal(parsed.errors.total, 0);
  assert.deepEqual(parsed.warnings.byRule, []);
  assert.match(formatLintSummary(parsed), /Warnings: 0\nErrors: 0/u);
});

test("one console-format warning is counted once", () => {
  const parsed = parseLintOutput("a.ts:1:1: warning eslint(no-unused-vars): unused\n");
  assert.equal(parsed.warnings.total, 1);
  assert.deepEqual(counts(parsed.warnings.byRule), { "eslint(no-unused-vars)": 1 });
  assert.equal(parsed.errors.total, 0);
});

test("repeated warnings from one rule are counted together", () => {
  const line = "a.ts:1:1: warning eslint(no-unused-vars): unused\n";
  const parsed = parseLintOutput(line + line);
  assert.equal(parsed.warnings.total, 2);
  assert.deepEqual(counts(parsed.warnings.byRule), { "eslint(no-unused-vars)": 2 });
});

test("warnings from different rules are listed separately", () => {
  const parsed = parseLintOutput([
    "a.ts:1:1: warning eslint(no-unused-vars): unused",
    "b.ts:2:2: warning unicorn(no-useless-spread): spread",
  ].join("\n"));
  assert.equal(parsed.warnings.total, 2);
  assert.deepEqual(counts(parsed.warnings.byRule), {
    "eslint(no-unused-vars)": 1,
    "unicorn(no-useless-spread)": 1,
  });
});

test("an annotation error is not included in the warning breakdown", () => {
  const parsed = parseLintOutput([
    "::warning file=x.ts,line=1,title=eslint(no-unused-vars)::unused",
    "::error file=x.ts,line=2,title=eslint(no-debugger)::debugger",
  ].join("\n"));
  assert.equal(parsed.warnings.total, 1);
  assert.deepEqual(counts(parsed.warnings.byRule), { "eslint(no-unused-vars)": 1 });
  assert.equal(parsed.errors.total, 1);
  assert.deepEqual(counts(parsed.errors.byRule), { "eslint(no-debugger)": 1 });
  const summary = formatLintSummary(parsed);
  assert.match(summary, /Warnings: 1\nErrors: 1/u);
  assert.doesNotMatch(summary, /Warnings by rule:\n- eslint\(no-debugger\)/u);
});

test("a parse error without a rule is counted as an error", () => {
  const parsed = parseLintOutput("a.ts:1:7: error: Unexpected token\n");
  assert.equal(parsed.warnings.total, 0);
  assert.equal(parsed.errors.total, 1);
  assert.deepEqual(counts(parsed.errors.byRule), { "(unclassified)": 1 });
});

test("unexpected output is ignored", () => {
  const parsed = parseLintOutput("not a diagnostic\n::unknown file=x.ts::oops\n");
  assert.equal(parsed.warnings.total, 0);
  assert.equal(parsed.errors.total, 0);
  assert.deepEqual(parsed.warnings.byRule, []);
});

test("rule breakdown sums to the total", () => {
  for (const file of ["default.txt", "github.txt"]) {
    const source = readFileSync(join(root, "tests", "fixtures", "oxlint", file), "utf8");
    const parsed = parseLintOutput(source);
    assert.ok(parsed.warnings.total > 0, `${file} must contain real warnings`);
    assert.equal(
      parsed.warnings.byRule.reduce((sum, entry) => sum + entry.count, 0),
      parsed.warnings.total,
      file,
    );
    assert.equal(parsed.errors.total, 0, file);
  }
});

test("the summary script prints the same result as the parser", () => {
  const fixture = join(root, "tests", "fixtures", "oxlint", "github.txt");
  const result = spawnSync(process.execPath, [join(root, "scripts", "lint-summary.mjs"), fixture], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, formatLintSummary(parseLintOutput(readFileSync(fixture, "utf8"))));
});

test("the workflow step keeps the lint exit status and the diagnostics", () => {
  const source = readFileSync(join(root, ".github", "workflows", "static-analysis.yml"), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes("Lint (errors fail, warnings advisory)"));
  const runAt = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  assert.ok(start >= 0 && runAt >= 0, "the lint step must exist");
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const script = body.join("\n");
  assert.match(script, /status=0/u);
  assert.match(script, /npm run lint .*\|\| status=\$\?/u);
  assert.match(script, /scripts\/lint-summary\.mjs/u);
  assert.match(script, /exit "\$status"/u);

  const dir = mkdtempSync(join(tmpdir(), "lint-summary-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const stub = join(bin, "npm");
    writeFileSync(stub, "#!/bin/sh\necho 'a.ts:1:7: error: Unexpected token'\nexit 1\n");
    chmodSync(stub, 0o755);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Unexpected token/u, "the failing diagnostic must stay visible");
    assert.match(readFileSync(summary, "utf8"), /Errors: 1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
