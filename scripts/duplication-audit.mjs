#!/usr/bin/env node
/**
 * Duplication denominator audit.
 *
 * `check:duplication` answers one question: is the duplicated-line percentage
 * under the threshold? It does not say where the duplicated lines live, or how
 * much of the number is a threshold choice rather than shared code. This audit
 * answers both, read-only, so the budget in `.jscpd.json` can be set from measured
 * numbers instead of a guess.
 *
 * It runs jscpd over a `minTokens` x `minLines` grid and reports, for each point,
 * the duplicated lines by directory pair and by directory. A clone whose two
 * sides sit in the same directory credits that directory in full; a clone that
 * crosses directories credits half to each side.
 *
 * Usage:
 *   node scripts/duplication-audit.mjs            # markdown report
 *   node scripts/duplication-audit.mjs --json     # same data, machine-readable
 *
 * Exit codes: 0 report produced, 2 jscpd missing or crashed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JSCPD_ENTRY = join(ROOT, "node_modules", "jscpd", "run-jscpd.js");
const GRID = {
  tokens: [30, 50, 80, 120, 200],
  lines: [6, 10, 20, 40],
};

export function directoryOf(name) {
  const normalized = String(name ?? "").replaceAll("\\", "/");
  const [head, ...rest] = normalized.split("/");
  return rest.length === 0 ? "(root)" : head;
}

export function summarizeDuplicates(report) {
  const duplicates = report.duplicates ?? [];
  const totals = report.statistics?.total ?? {};
  const pairs = new Map();
  const directories = new Map();

  const credit = (dir, clones, lines) => {
    const entry = directories.get(dir) ?? { dir, clones: 0, lines: 0 };
    entry.clones += clones;
    entry.lines += lines;
    directories.set(dir, entry);
  };

  for (const clone of duplicates) {
    const lines = Number(clone.lines ?? 0);
    const first = directoryOf(clone.firstFile?.name);
    const second = directoryOf(clone.secondFile?.name);
    const intra = first === second;
    const key = intra ? first : [first, second].sort().join(" -> ");
    const pair = pairs.get(key) ?? { pair: key, clones: 0, lines: 0, intra };
    pair.clones += 1;
    pair.lines += lines;
    pairs.set(key, pair);
    if (intra) {
      credit(first, 1, lines);
    } else {
      credit(first, 1, lines / 2);
      credit(second, 1, lines / 2);
    }
  }

  const byLines = (a, b) => b.lines - a.lines || a.pair?.localeCompare(b.pair) || a.dir.localeCompare(b.dir);
  return {
    totals: {
      clones: Number(totals.clones ?? duplicates.length),
      duplicatedLines: Number(totals.duplicatedLines ?? 0),
      lines: Number(totals.lines ?? 0),
      sources: Number(totals.sources ?? 0),
      percentage: Number(totals.percentage ?? 0),
    },
    pairs: [...pairs.values()].sort(byLines),
    directories: [...directories.values()].sort(byLines),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function renderMarkdown(points) {
  const lines = ["### Totals", "", "| minTokens | minLines | Clones | Duplicated lines | Percentage |", "| --- | --- | --- | --- | --- |"];
  for (const point of points) {
    const { totals } = point;
    lines.push(`| ${point.tokens} | ${point.lines} | ${totals.clones} | ${totals.duplicatedLines} | ${totals.percentage.toFixed(2)}% |`);
  }
  for (const point of points) {
    lines.push("", `### minTokens ${point.tokens}, minLines ${point.lines}`, "", "| Directory pair | Clones | Duplicated lines |", "| --- | --- | --- |");
    for (const pair of point.pairs) lines.push(`| \`${pair.pair}\` | ${pair.clones} | ${pair.lines} |`);
    lines.push("", "| Directory | Clones touching | Credited duplicated lines |", "| --- | --- | --- |");
    for (const dir of point.directories) lines.push(`| \`${dir.dir}\` | ${dir.clones} | ${round(dir.lines)} |`);
  }
  return lines.join("\n");
}

function runJscpd({ tokens, lines }) {
  const output = mkdtempSync(join(tmpdir(), "bifrost-duplication-audit-"));
  try {
    const result = spawnSync(
      process.execPath,
      [JSCPD_ENTRY, ".", "--config", ".jscpd.json", "--reporters", "json", "--output", output, "--silent",
        // An audit must produce the report even when the grid point is over
        // budget; the gate is a separate command.
        "--threshold", "100",
        "--min-tokens", String(tokens), "--min-lines", String(lines)],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) return { error: `jscpd failed to start: ${result.error.message}` };
    if (result.status !== 0) return { error: `jscpd exited ${result.status}: ${(result.stderr ?? "").trim()}` };
    return { report: JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8")) };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const points = [];
  for (const tokens of GRID.tokens) {
    for (const lines of GRID.lines) {
      const { report, error } = runJscpd({ tokens, lines });
      if (error) {
        console.error(`duplication audit failed: ${error}`);
        return 2;
      }
      points.push({ tokens, lines, ...summarizeDuplicates(report) });
    }
  }
  if (json) {
    console.log(JSON.stringify({ check: "duplication-audit", status: "passed", grid: GRID, points }, null, 2));
    return 0;
  }
  console.log(renderMarkdown(points));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
