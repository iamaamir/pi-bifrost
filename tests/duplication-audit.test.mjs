import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { directoryOf, renderMarkdown, summarizeDuplicates } from "../scripts/duplication-audit.mjs";

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
  // docs/quality/duplication-audit.md. Change all three together.
  assert.equal(config.threshold, 2.5);
  assert.equal(config.minLines, 10);
  assert.equal(config.minTokens, 50);
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
