import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, "node_modules", ".bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");

// `ast-grep test` does not apply a rule's `files` filter, so the rule
// self-tests cannot catch an inert scope. Only a real scan can.
test("committed ast-grep rules match their intended scope through the real scanner", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-ast-scope-"));
  try {
    cpSync(join(root, "rules"), join(dir, "rules"), { recursive: true });
    cpSync(join(root, "sgconfig.yml"), join(dir, "sgconfig.yml"));
    writeFileSync(
      join(dir, "probe.ts"),
      'export const bad = value as any;\ndebugger;\nconsole.log("x");\nprocess.exit(1);\n',
    );
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "probe.test.mjs"), 'test.skip("x", () => {});\n');
    mkdirSync(join(dir, "ui"));
    writeFileSync(join(dir, "ui", "probe.ts"), "export const bad = value as any;\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "probe.mjs"), 'console.log("x");\n');

    const result = spawnSync(binary, ["scan", "--config", "sgconfig.yml", "--json"], {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const matches = JSON.parse(result.stdout);
    const filesFor = (ruleId) =>
      matches.filter((match) => match.ruleId === ruleId).map((match) => match.file).sort();

    for (const ruleId of [
      "no-as-any-in-extension",
      "no-debugger-in-extension",
      "no-console-log-in-extension",
      "no-process-exit-in-extension",
    ]) {
      assert.deepEqual(filesFor(ruleId), ["probe.ts"], `${ruleId} must scan only extension sources`);
    }
    assert.deepEqual(filesFor("no-focused-or-skipped-test-javascript"), ["tests/probe.test.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
