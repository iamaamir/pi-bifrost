import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const toolbox = join(root, "scripts", "toolbox.mjs");
const complexity = join(root, "scripts", "check-complexity.mjs");

// These tests drive the real gate entry points, not helper functions: the
// contract a contributor relies on is the process exit code.
function gitFixture(dir) {
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(run(["init", "-q"]).status, 0);
  assert.equal(run(["add", "-A"]).status, 0);
  assert.equal(run([
    "-c", "user.name=gate-test", "-c", "user.email=gate@example.com",
    "commit", "-qm", "fixture",
  ]).status, 0);
}

function runToolbox(dir, check) {
  const result = spawnSync(process.execPath, [toolbox, check, "--root", dir, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    report: result.stdout.trim() === "" ? null : JSON.parse(result.stdout),
    stderr: result.stderr,
  };
}

function astFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-gate-ast-"));
  cpSync(join(root, "rules"), join(dir, "rules"), { recursive: true });
  cpSync(join(root, "rule-tests"), join(dir, "rule-tests"), { recursive: true });
  cpSync(join(root, "sgconfig.yml"), join(dir, "sgconfig.yml"));
  writeFileSync(join(dir, "probe.ts"), "export const value = 1;\n");
  // Every committed rule must have a tracked file in scope, or the clean case
  // would fail for the reason under test rather than because the tree is clean.
  cpSync(join(root, "tests", "toolbox.test.mjs"), join(dir, "tests", "probe.test.mjs"));
  cpSync(join(root, "tests", "toolbox.test.mjs"), join(dir, "tests", "probe.js"));
  writeFileSync(join(dir, "tests", "probe.test.ts"), "export const ok = 1;\n");
  gitFixture(dir);
  return dir;
}

test("check:ast exits 1 when a rule's scope matches no tracked file and 0 when it does", () => {
  const dir = astFixture();
  try {
    const clean = runToolbox(dir, "ast");
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(clean.report.findings, []);

    const rulePath = join(dir, "rules", "no-debugger-in-extension.yml");
    const original = readFileSync(rulePath, "utf8");
    const inertRule = original.replace('  - "*.ts"', '  - "/*.ts"');
    assert.notEqual(inertRule, original, "the rule scope mutation must apply");
    writeFileSync(rulePath, inertRule);

    const inert = runToolbox(dir, "ast");
    assert.equal(inert.status, 1, inert.stderr);
    assert.deepEqual(inert.report.findings.map((finding) => finding.rule), ["ast-grep-empty-scope"]);
    assert.equal(inert.report.findings[0].file, "rules/no-debugger-in-extension.yml");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function duplicationFixture(threshold) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-gate-duplication-"));
  const config = JSON.parse(readFileSync(join(root, ".jscpd.json"), "utf8"));
  writeFileSync(join(dir, ".jscpd.json"), JSON.stringify({ ...config, threshold }, null, 2));
  const block = [
    "export function computeValue(input: number) {",
    "  const doubled = input * 2;",
    "  const shifted = doubled + 1;",
    "  if (shifted > 10) {",
    "    return doubled;",
    "  }",
    "  return shifted;",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(dir, "a.ts"), block.repeat(3));
  writeFileSync(join(dir, "b.ts"), block.repeat(3));
  gitFixture(dir);
  return dir;
}

test("check:duplication exits 1 above the configured threshold and 0 below it", () => {
  const strict = duplicationFixture(0);
  try {
    const over = runToolbox(strict, "duplication");
    assert.equal(over.status, 1, over.stderr);
    assert.deepEqual(over.report.findings.map((finding) => finding.rule), ["duplication-threshold"]);
    assert.match(over.report.findings[0].message, /over 0% threshold/u);
  } finally {
    rmSync(strict, { recursive: true, force: true });
  }

  const lenient = duplicationFixture(100);
  try {
    const under = runToolbox(lenient, "duplication");
    assert.equal(under.status, 0, under.stderr);
    assert.deepEqual(under.report.findings, []);
  } finally {
    rmSync(lenient, { recursive: true, force: true });
  }
});

test("check:complexity exits 1 on a ratchet regression against a lowered baseline", () => {
  const committed = JSON.parse(readFileSync(join(root, "quality", "complexity-baseline.json"), "utf8"));
  const [file, record] = Object.entries(committed.files).find(([, data]) => data.maxCyc > 1);
  const lowered = structuredClone(committed);
  lowered.files[file].maxCyc = record.maxCyc - 1;
  const loweredPath = join(tmpdir(), `bifrost-ratchet-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(loweredPath, JSON.stringify(lowered));
    const result = spawnSync(process.execPath, [complexity, "--baseline", loweredPath, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(report.findings.some((finding) => finding.rule === "file-maxCyc-regression" && finding.file === file), true,
      `expected a ratchet finding for ${file}, got ${JSON.stringify(report.findings)}`);
  } finally {
    rmSync(loweredPath, { force: true });
  }
});
