import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { directoryOf, renderMarkdown, summarizeDuplicates } from "../scripts/duplication-audit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function clone(first, second, lines) {
  return { lines, firstFile: { name: first }, secondFile: { name: second } };
}

test("directoryOf names the top-level directory and groups root files separately", () => {
  assert.equal(directoryOf("router.ts"), "(root)");
  assert.equal(directoryOf("tests/check-complexity.test.mjs"), "tests");
  assert.equal(directoryOf("ui\\panel.ts"), "ui");
  assert.equal(directoryOf(""), "(root)");
});

test("summarizes clones into pairs and credits intra-directory clones in full", () => {
  const summary = summarizeDuplicates({
    statistics: { total: { clones: 3, duplicatedLines: 30, lines: 300, sources: 4, percentage: 10 } },
    duplicates: [clone("tests/a.test.mjs", "tests/b.test.mjs", 10), clone("tests/c.test.mjs", "tests/d.test.mjs", 10), clone("router.ts", "router.ts", 10)],
  });

  assert.deepEqual(summary.totals, { clones: 3, duplicatedLines: 30, lines: 300, sources: 4, percentage: 10 });
  assert.deepEqual(summary.pairs.map((pair) => [pair.pair, pair.clones, pair.lines, pair.intra]), [
    ["tests", 2, 20, true],
    ["(root)", 1, 10, true],
  ]);
  assert.deepEqual(summary.directories.map((dir) => [dir.dir, dir.clones, dir.lines]), [
    ["tests", 2, 20],
    ["(root)", 1, 10],
  ]);
});

test("credits a cross-directory clone half to each side and sorts the pair key", () => {
  const summary = summarizeDuplicates({
    duplicates: [clone("ui/panel.ts", "tests/panel.test.ts", 8), clone("tests/x.test.ts", "scripts/y.mjs", 4)],
  });

  assert.deepEqual(summary.pairs.map((pair) => [pair.pair, pair.lines, pair.intra]), [
    ["tests -> ui", 8, false],
    ["scripts -> tests", 4, false],
  ]);
  assert.deepEqual(summary.directories.map((dir) => [dir.dir, dir.clones, dir.lines]), [
    ["tests", 2, 6],
    ["ui", 1, 4],
    ["scripts", 1, 2],
  ]);
});

test("the committed budget matches the audited decision", () => {
  const config = JSON.parse(readFileSync(new URL("../.jscpd.json", import.meta.url), "utf8"));
  // Pinned so a silent loosening of the budget fails here as well as in
  // docs/quality/duplication-audit.md. Change these together.
  assert.equal(config.threshold, 3.3);
  assert.equal(config.minLines, 10);
  assert.equal(config.minTokens, 50);
  assert.deepEqual(config.format, ["typescript", "javascript"]);
});

// jscpd maps `.mjs` to the `javascript` format. Without it in `format`, every
// script and tooling test was outside the gate, so this case runs the real
// binary against a duplicated `.mjs` pair.
test("the committed config measures JavaScript sources, not only TypeScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-jscpd-js-"));
  const block = `${Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index} * 2;`).join("\n")}\n`;
  try {
    writeFileSync(join(dir, "a.mjs"), block);
    writeFileSync(join(dir, "b.mjs"), block);
    const output = join(dir, "report");
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules", "jscpd", "run-jscpd.js"), ".", "--config", join(root, ".jscpd.json"),
        "--reporters", "json", "--output", output, "--threshold", "100", "--silent"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8"));
    assert.equal(report.statistics.formats.javascript?.sources, 2, "both .mjs files must be measured");
    assert.ok(report.statistics.total.clones >= 1, "a duplicated .mjs block must be detected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderMarkdown prints one totals row per grid point and escapes nothing else", () => {
  const markdown = renderMarkdown([
    {
      tokens: 50,
      lines: 6,
      totals: { clones: 2, duplicatedLines: 5, lines: 100, sources: 2, percentage: 5 },
      pairs: [{ pair: "tests", clones: 2, lines: 5, intra: true }],
      directories: [{ dir: "tests", clones: 2, lines: 5 }],
    },
  ]);

  assert.match(markdown, /\| 50 \| 6 \| 2 \| 5 \| 5\.00% \|/u);
  assert.match(markdown, /\| `tests` \| 2 \| 5 \|/u);
  assert.match(markdown, /### minTokens 50, minLines 6/u);
});
