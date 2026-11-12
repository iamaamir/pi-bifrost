import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendRecord,
  collectFunctions,
  computeCrap,
  coverageFor,
  displayPath,
  makeRecord,
  readHistory,
  renderTrend,
  resolveOptions,
  summarize,
} from "../scripts/crap-report.mjs";

function sampleRows() {
  return [
    { location: "a.ts:1", name: "bad", complexity: 12, coverage: 0, crap: 156 },
    { location: "b.ts:2", name: "ok", complexity: 3, coverage: 90, crap: 3 },
    { location: "c.ts:3", name: "borderline", complexity: 6, coverage: 90, crap: 6.1 },
  ];
}

test("CRAP formula matches the published metric", () => {
  // Minimum score: complexity 1, fully covered.
  assert.equal(computeCrap(1, 100), 1);
  // Complexity 5 with zero coverage lands exactly on the threshold of 30.
  assert.equal(computeCrap(5, 0), 30);
  // The metric's documented example: complexity 10 needs about 42%
  // coverage to drop below 30, but 41% leaves it above.
  assert.ok(computeCrap(10, 42) < 30);
  assert.ok(computeCrap(10, 41) > 30);
  // More coverage can never raise the score.
  assert.ok(computeCrap(8, 90) < computeCrap(8, 50));
});

const SNIPPET = `
function greet(name: string) {
  if (name && name.length > 0) {
    return "hi " + name;
  } else {
    return "hi";
  }
}
const outer = (x: number) => {
  if (x > 0) return 1;
  const inner = (y: number) => {
    if (y) return 1;
    if (y > 2) return 2;
    if (y > 3) return 3;
    return 0;
  };
  return inner(x);
};
`;

test("options fall back to built-in defaults", () => {
  const options = resolveOptions([], {});
  assert.equal(options.threshold, 30);
  assert.equal(options.coverage, "coverage/coverage-final.json");
  assert.equal(options.failAbove, null);
  assert.equal(options.showAll, false);
  assert.deepEqual(options.files, []);
  assert.deepEqual(options.sources, {
    threshold: "default",
    failAbove: "default",
    coverage: "default",
    history: "default",
  });
});

test("package.json crap block overrides defaults", () => {
  const options = resolveOptions([], {
    threshold: 55,
    coverage: "build/cov.json",
    failAbove: 60,
  });
  assert.equal(options.threshold, 55);
  assert.equal(options.coverage, "build/cov.json");
  assert.equal(options.failAbove, 60);
  assert.deepEqual(options.sources, {
    threshold: "package.json",
    failAbove: "package.json",
    coverage: "package.json",
    history: "default",
  });
});

test("CLI flags override the package.json crap block", () => {
  const options = resolveOptions(["--threshold", "10", "--fail-above", "5", "a.ts"], {
    threshold: 55,
    coverage: "build/cov.json",
    failAbove: 60,
  });
  assert.equal(options.threshold, 10);
  assert.equal(options.failAbove, 5);
  assert.equal(options.coverage, "build/cov.json"); // config still applies where no flag exists
  assert.deepEqual(options.files, ["a.ts"]);
  assert.equal(options.sources.threshold, "cli");
});

test("a null failAbove config value means no gate", () => {
  const options = resolveOptions([], { failAbove: null });
  assert.equal(options.failAbove, null);
  assert.equal(options.sources.failAbove, "default");
});

test("invalid configuration fails with a clear error", () => {
  assert.throws(() => resolveOptions([], { threshold: "abc" }), /finite number/);
  assert.throws(() => resolveOptions([], { threshold: 0 }), /greater than 0/);
  assert.throws(() => resolveOptions([], { coverage: "" }), /non-empty string/);
  assert.throws(() => resolveOptions(["--nope"], {}), /Unknown flag/);
  assert.throws(() => resolveOptions(["--threshold"], {}), /expects a number/);
});

test("displayPath shortens in-tree paths and keeps outside paths absolute", () => {
  assert.equal(displayPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(displayPath("/repo/a.ts", "/repo"), "a.ts");
  // A path outside the working directory stays absolute instead of
  // rendering as "../../..", which would hide where the code lives.
  assert.equal(displayPath("/elsewhere/a.ts", "/repo"), "/elsewhere/a.ts");
});

test("summarize counts flagged functions and finds the worst one", () => {
  const summary = summarize(sampleRows(), 30);
  assert.equal(summary.functions, 3);
  assert.equal(summary.flagged, 1);
  assert.equal(summary.percentFlagged, 33.3);
  assert.equal(summary.max, 156);
  assert.equal(summary.worst, "a.ts:1 bad");
  assert.deepEqual(summarize([], 30), {
    functions: 0,
    flagged: 0,
    percentFlagged: 0,
    max: 0,
    worst: null,
  });
});

test("makeRecord captures the revision, threshold and counts", () => {
  const record = makeRecord(sampleRows(), 30, {
    at: "2026-01-02T03:04:05.000Z",
    revision: "abc1234",
    dirty: false,
  });
  assert.deepEqual(record, {
    at: "2026-01-02T03:04:05.000Z",
    revision: "abc1234",
    dirty: false,
    threshold: 30,
    coverageKind: "statement",
    functions: 3,
    flagged: 1,
    percentFlagged: 33.3,
    max: 156,
    worst: "a.ts:1 bad",
  });
});

test("a snapshot from a dirty tree is marked in the trend", () => {
  const clean = { at: "2026-01-01T00:00:00.000Z", revision: "aaaaaaa", dirty: false, threshold: 30, functions: 10, flagged: 2, percentFlagged: 20, max: 40 };
  const dirty = { at: "2026-01-02T00:00:00.000Z", revision: "bbbbbbb", dirty: true, threshold: 30, functions: 10, flagged: 1, percentFlagged: 10, max: 40 };
  const trend = renderTrend([clean, dirty], 30);
  assert.match(trend, /aaaaaaa\s/);
  assert.match(trend, /bbbbbbb\*/);
  assert.match(trend, /recorded with uncommitted changes/);
  // A clean history carries no warning.
  assert.doesNotMatch(renderTrend([clean], 30), /uncommitted/);
});

test("an empty history renders guidance instead of a table", () => {
  assert.match(renderTrend([], 30), /No CRAP history yet/);
});

test("renderTrend shows per-snapshot rows and the overall direction", () => {
  const records = [
    { at: "2026-01-01T00:00:00.000Z", revision: "aaaaaaa", threshold: 30, functions: 100, flagged: 20, percentFlagged: 20, max: 500 },
    { at: "2026-02-01T00:00:00.000Z", revision: "bbbbbbb", threshold: 30, functions: 110, flagged: 14, percentFlagged: 12.7, max: 480 },
    { at: "2026-03-01T00:00:00.000Z", revision: "ccccccc", threshold: 30, functions: 120, flagged: 16, percentFlagged: 13.3, max: 470 },
  ];
  const trend = renderTrend(records, 30);
  const lines = trend.split("\n");
  assert.match(lines[0], /CRAP trend \(threshold 30\)/);
  assert.match(lines[4], /2026-01-01 00:00\s+aaaaaaa\s+30\s+100\s+20\s+20%/);
  assert.match(lines[5], /-6/); // 20 -> 14 is an improvement
  assert.match(lines[6], /\+2/); // 14 -> 16 is a drift
  assert.match(trend, /20 → 16 \(-4\), improving\./);
});

test("renderTrend warns when thresholds differ across snapshots", () => {
  const base = {
    at: "2026-01-01T00:00:00.000Z",
    revision: "aaaaaaa",
    dirty: false,
    functions: 10,
    flagged: 2,
    percentFlagged: 20,
    max: 40,
  };
  const mixed = renderTrend(
    [
      { ...base, threshold: 30 },
      { ...base, at: "2026-01-02T00:00:00.000Z", threshold: 55 },
    ],
    30,
  );
  assert.match(mixed, /different thresholds \(30, 55\)/);
  // A consistent threshold carries no warning.
  assert.doesNotMatch(
    renderTrend([{ ...base, threshold: 30 }], 30),
    /different thresholds/,
  );
});

test("renderTrend reports a drift as drifting up", () => {
  const records = [
    { at: "2026-01-01T00:00:00.000Z", revision: "a", threshold: 30, functions: 10, flagged: 1, percentFlagged: 10, max: 40 },
    { at: "2026-01-02T00:00:00.000Z", revision: "b", threshold: 30, functions: 10, flagged: 3, percentFlagged: 30, max: 90 },
  ];
  assert.match(renderTrend(records, 30), /1 → 3 \(\+2\), drifting up\./);
});

test("records append to and read back from a history file", () => {
  const dir = mkdtempSync(join(tmpdir(), "crap-history-"));
  const file = join(dir, "nested", "crap-history.jsonl");
  assert.deepEqual(readHistory(file), []); // missing file reads as empty

  const first = makeRecord(sampleRows(), 30, { at: "2026-01-01T00:00:00.000Z", revision: "a" });
  const second = makeRecord(sampleRows(), 25, { at: "2026-01-02T00:00:00.000Z", revision: "b" });
  appendRecord(file, first);
  appendRecord(file, second);

  const records = readHistory(file);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], first);
  assert.equal(records[1].threshold, 25);
  // One snapshot per line, so the file stays diff-friendly and append-only.
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
});

test("an unreadable history line fails with a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "crap-history-bad-"));
  const file = join(dir, "crap-history.jsonl");
  writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","flagged":1}\nnot json\n');
  assert.throws(() => readHistory(file), /unreadable history line/);
});

test("history defaults to the docs path and can be reconfigured", () => {
  assert.equal(resolveOptions([], {}).history, "docs/quality/crap-history.jsonl");
  assert.equal(
    resolveOptions([], { history: "custom/history.jsonl" }).history,
    "custom/history.jsonl",
  );
  assert.throws(() => resolveOptions([], { history: "" }), /non-empty string/);
});

const HISTORY_FLAGS = ["--record", "--trend"];

for (const flag of HISTORY_FLAGS) {
  test(`${flag} is accepted and is off by default`, () => {
    const options = resolveOptions([flag], {});
    assert.equal(options[flag.slice(2)], true);
    const defaults = resolveOptions([], {});
    assert.equal(defaults[flag.slice(2)], false);
  });
}

test("complexity counts decision points but not nested functions", () => {
  const functions = collectFunctions(SNIPPET, "snippet.ts");
  const byName = new Map(functions.map((f) => [f.name, f]));
  // greet: one if + one && => 3.
  assert.equal(byName.get("greet").complexity, 3);
  // outer: one if; the inner arrow's three ifs belong to inner, not outer.
  assert.equal(byName.get("outer").complexity, 2);
  assert.equal(byName.get("inner").complexity, 4);
});

test("coverage is attributed only to a function's own statements", () => {
  const functions = collectFunctions(SNIPPET, "snippet.ts");
  const outer = functions.find((f) => f.name === "outer");
  const inner = functions.find((f) => f.name === "inner");

  // Fake istanbul entry: outer's own if (missed) plus two statements
  // inside inner (one hit, one missed).
  const statementMap = {
    a: { start: { line: outer.startLine + 1, column: 0 }, end: { line: outer.startLine + 1, column: 10 } },
    b: { start: { line: inner.startLine + 1, column: 0 }, end: { line: inner.startLine + 1, column: 10 } },
    c: { start: { line: inner.startLine + 2, column: 0 }, end: { line: inner.startLine + 2, column: 10 } },
  };
  const entry = { statementMap, s: { a: 0, b: 5, c: 0 } };

  // Inner statements must not count toward outer: outer has only its
  // own missed statement => 0% coverage.
  assert.equal(coverageFor(entry, outer), 0);
  // Inner sees both of its statements, one covered => 50%.
  assert.equal(coverageFor(entry, inner), 50);
  // A file with no coverage data reports null (caller treats it as 0%).
  assert.equal(coverageFor(null, outer), null);
});

test("complexityOf scores loops, switches, catch, and ternaries", () => {
  const source = `
function demo(items: string[], flag: boolean) {
  try {
    for (const item of items) {
      if (item === "a") continue;
    }
    while (flag) break;
    switch (items[0]) {
      case "x":
        break;
      case "y":
        break;
      default:
        break;
    }
    return flag ? 1 : 0;
  } catch {
    return -1;
  }
}
`;
  const fn = collectFunctions(source, "demo.ts").find(
    (f) => f.name === "demo",
  );
  // 1 + for + if + while + 2 cases + ternary + catch = 8.
  assert.equal(fn.complexity, 8);
});
