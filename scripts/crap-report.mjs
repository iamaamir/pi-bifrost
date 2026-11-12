#!/usr/bin/env node
/**
 * CRAP (Change Risk Anti-Patterns) report.
 *
 * CRAP(m) = CC(m)^2 * (1 - cov(m)/100)^3 + CC(m)
 *
 * CC(m)   = cyclomatic complexity of the function.
 * cov(m)  = percentage of the function's own statements exercised by the
 *           unit test suite (statement coverage from the c8 report).
 *
 * Functions with a score at or above the threshold, 30 by default, are
 * "CRAP-y": complex and not tested enough to change safely.
 *
 * Origin: the C.R.A.P. metric and the crap4j tool, introduced by Alberto
 * Savoia and Bob Evans (Agitar Labs, 2007). Sources: crap4j FAQ
 * (http://www.crap4j.org/faq.html) and Savoia's 2007 announcement.
 *
 * Why 30: the authors picked it empirically after reviewing their own code
 * and many open source projects, and called it a starting point to refine
 * rather than a derived constant. It is configuration here, not a fact.
 *
 * The number is nonetheless self-consistent, because a fully covered
 * function scores exactly its own complexity. So a threshold T also caps
 * the complexity worth testing at T: at 30, a function of complexity 31 or
 * more can never comply, whatever its tests do. The authors' published
 * table matches: complexity 10 needs 42% coverage, 20 needs 71%, 26-30
 * needs 100%.
 *
 * Caveat: crap4j measured basis path coverage. This report uses statement
 * coverage from c8, which is usually higher for the same tests, so scores
 * here can run slightly more optimistic than the original calibration.
 *
 * Settings live outside the code, in package.json:
 *
 *   "crap": {
 *     "threshold": 30,
 *     "coverage": "coverage/coverage-final.json",
 *     "failAbove": null,
 *     "history": "docs/quality/crap-history.jsonl"
 *   }
 *
 * Precedence: CLI flag > package.json "crap" block > built-in default.
 *
 * The report reads the configured coverage file, produced by
 * `npm run test:coverage`, and analyzes TypeScript files (default:
 * top-level *.ts package sources).
 *
 * Usage:
 *   node scripts/crap-report.mjs [--threshold N] [--fail-above N] [--all]
 *                                [--record] [--trend] [files...]
 *
 *   --threshold N   override crap.threshold for this run.
 *   --fail-above N  exit 1 when any function scores above N (advisory
 *                   report otherwise; no gate unless configured).
 *   --all           list every function, not only those above the threshold.
 *   --record        append a one-line snapshot to the history file.
 *   --trend         print the snapshot history as a table. Works without
 *                   coverage data, so it never needs a test run.
 *
 * Snapshots let you see whether quality is improving or drifting across
 * revisions. The history file is crap.history in package.json.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const CONFIG_KEY = "crap";

/** Built-in defaults; package.json and CLI flags override them. */
const DEFAULTS = Object.freeze({
  threshold: 30,
  coverage: "coverage/coverage-final.json",
  failAbove: null,
  history: "docs/quality/crap-history.jsonl",
});

class ConfigError extends Error {}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot read ${file}: ${error.message}`);
  }
}

/** Read the "crap" block from package.json in the given directory. */
function readPackageConfig(cwd) {
  const file = path.join(cwd, "package.json");
  if (!fs.existsSync(file)) return {};
  const config = readJsonFile(file)[CONFIG_KEY];
  if (config === undefined) return {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ConfigError(`package.json "${CONFIG_KEY}" must be an object.`);
  }
  return config;
}

/**
 * Merge CLI flags over the package.json "crap" block over built-in
 * defaults. Exported so tests can assert precedence deterministically.
 */
export function resolveOptions(argv = [], config = {}) {
  const cli = { files: [], showAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // A flag at the end of the arguments has no value; reject it instead of
    // silently falling back to the configured default.
    const takeValue = (flag, kind = "a number") => {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new ConfigError(`${flag} expects ${kind}.`);
      }
      i += 1;
      return value;
    };
    if (arg === "--all") {
      cli.showAll = true;
    } else if (arg === "--record") {
      cli.record = true;
    } else if (arg === "--trend") {
      cli.trend = true;
    } else if (arg === "--threshold") {
      cli.threshold = takeValue(arg);
    } else if (arg === "--fail-above") {
      cli.failAbove = takeValue(arg);
    } else if (arg === "--history") {
      cli.history = takeValue(arg, "a path");
    } else if (arg.startsWith("--history=")) {
      const value = arg.slice("--history=".length);
      if (value === "") {
        throw new ConfigError("--history expects a path.");
      }
      cli.history = value;
    } else if (arg.startsWith("--")) {
      throw new ConfigError(`Unknown flag ${arg}.`);
    } else {
      cli.files.push(arg);
    }
  }

  const readNumber = (label, cliValue, configValue, fallback) => {
    if (cliValue !== undefined) {
      const value = Number(cliValue);
      if (cliValue === undefined || cliValue === "" || !Number.isFinite(value)) {
        throw new ConfigError(`${label} expects a number, got ${JSON.stringify(cliValue)}.`);
      }
      return { value, source: "cli" };
    }
    if (configValue !== undefined && configValue !== null) {
      const value = Number(configValue);
      if (!Number.isFinite(value)) {
        throw new ConfigError(
          `package.json "${CONFIG_KEY}.${label}" must be a finite number, got ` +
            `${JSON.stringify(configValue)}.`,
        );
      }
      return { value, source: "package.json" };
    }
    return { value: fallback, source: "default" };
  };

  const threshold = readNumber(
    "threshold",
    cli.threshold,
    config.threshold,
    DEFAULTS.threshold,
  );
  if (threshold.value <= 0) {
    throw new ConfigError(
      `CRAP threshold must be greater than 0, got ${threshold.value}.`,
    );
  }
  const failAbove = readNumber(
    "failAbove",
    cli.failAbove,
    config.failAbove,
    DEFAULTS.failAbove,
  );

  const readPath = (label, configValue, fallback) => {
    if (configValue === undefined || configValue === null) {
      return { value: fallback, source: "default" };
    }
    if (typeof configValue !== "string" || configValue.trim() === "") {
      throw new ConfigError(
        `package.json "${CONFIG_KEY}.${label}" must be a non-empty string.`,
      );
    }
    return { value: configValue, source: "package.json" };
  };

  const coverage = readPath("coverage", config.coverage, DEFAULTS.coverage);
  const history =
    cli.history !== undefined
      ? (() => {
          if (typeof cli.history !== "string" || cli.history.trim() === "") {
            throw new ConfigError("--history must be a non-empty path.");
          }
          return { value: cli.history, source: "cli" };
        })()
      : readPath("history", config.history, DEFAULTS.history);

  return {
    files: cli.files,
    showAll: cli.showAll,
    record: cli.record === true,
    trend: cli.trend === true,
    threshold: threshold.value,
    failAbove: failAbove.value,
    coverage: coverage.value,
    history: history.value,
    sources: {
      threshold: threshold.source,
      failAbove: failAbove.source,
      coverage: coverage.source,
      history: history.source,
    },
  };
}

/** CRAP score for a function with the given complexity and coverage %. */
export function computeCrap(complexity, coveragePct) {
  const uncovered = 1 - Math.min(Math.max(coveragePct, 0), 100) / 100;
  return complexity * complexity * uncovered ** 3 + complexity;
}

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isFunctionLike(node) {
  return FUNCTION_LIKE.has(node.kind);
}

/** Cyclomatic complexity of one function, excluding nested functions. */
export function complexityOf(fnNode) {
  let complexity = 1;
  const visit = (node) => {
    if (isFunctionLike(node)) return; // nested functions score on their own
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = node.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity += 1;
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  if (fnNode.body) visit(fnNode.body);
  return complexity;
}

function labelFor(fnNode, sourceFile) {
  if (fnNode.name && ts.isIdentifier(fnNode.name)) return fnNode.name.text;
  const parent = fnNode.parent;
  if (!parent) return "(anonymous)";
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name
  ) {
    return parent.name.getText(sourceFile);
  }
  if (ts.isCallExpression(parent)) {
    return "(inline callback)";
  }
  return "(anonymous)";
}

/**
 * Collect every function in a TypeScript source with its complexity,
 * line span, and line spans of nested functions (so their statements are
 * not credited to the enclosing function's coverage).
 */
export function collectFunctions(sourceText, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      functions.push({
        name: labelFor(node, sourceFile),
        complexity: complexityOf(node),
        startLine: start.line + 1,
        endLine: end.line + 1,
        nested: [],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  // Attribute nested-function statements to the nested function only.
  for (const fn of functions) {
    for (const other of functions) {
      if (other === fn) continue;
      if (other.startLine >= fn.startLine && other.endLine <= fn.endLine) {
        fn.nested.push([other.startLine, other.endLine]);
      }
    }
  }
  return functions;
}

function inNested(line, spans) {
  for (const [start, end] of spans) {
    if (line >= start && line <= end) return true;
  }
  return false;
}

/** Statement coverage % for a function's own statements, or null when the
 *  file has no coverage data (treated as 0% by the caller). */
export function coverageFor(coverageEntry, fn) {
  if (!coverageEntry || !coverageEntry.statementMap) return null;
  const map = coverageEntry.statementMap;
  const counts = coverageEntry.s;
  let total = 0;
  let covered = 0;
  for (const [id, loc] of Object.entries(map)) {
    const line = loc.start.line;
    if (line < fn.startLine || line > fn.endLine) continue;
    if (inNested(line, fn.nested)) continue;
    total += 1;
    if ((counts[id] ?? 0) > 0) covered += 1;
  }
  if (total === 0) return 100; // no statements of its own (e.g. empty body)
  return (covered / total) * 100;
}

function loadCoverage(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function targetFiles(argvFiles) {
  if (argvFiles.length > 0) {
    return argvFiles.map((f) => path.resolve(f));
  }
  return fs
    .readdirSync(".")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.resolve(f));
}

function formatRow(row) {
  return [
    row.crap.toFixed(1).padStart(6),
    String(row.complexity).padStart(3),
    `${row.coverage.toFixed(0)}%`.padStart(5),
    row.location.padEnd(42),
    row.name,
  ].join("  ");
}

/**
 * Shorten a path for display, but keep it absolute when it lies outside
 * the working directory. A relative path that escapes cwd would otherwise
 * read as "../../../Users/...", which hides where the code actually lives.
 */
export function displayPath(file, cwd = process.cwd()) {
  const relative = path.relative(cwd, file);
  if (relative === "" || relative.startsWith("..")) return file;
  return relative;
}

function buildRows(files, coverage) {
  const rows = [];
  for (const file of targetFiles(files)) {
    const sourceText = fs.readFileSync(file, "utf8");
    const entry = coverage[path.resolve(file)] ?? null;
    const rel = displayPath(file);
    for (const fn of collectFunctions(sourceText, file)) {
      const cov = coverageFor(entry, fn);
      const effectiveCov = cov === null ? 0 : cov;
      rows.push({
        name: fn.name,
        complexity: fn.complexity,
        coverage: effectiveCov,
        crap: computeCrap(fn.complexity, effectiveCov),
        location: `${rel}:${fn.startLine}`,
      });
    }
  }
  rows.sort((a, b) => b.crap - a.crap);
  return rows;
}

/** Project-wide counts for one snapshot. Exported for deterministic tests. */
export function summarize(rows, threshold) {
  const flagged = rows.filter((row) => row.crap >= threshold);
  const max = rows.reduce((best, row) => Math.max(best, row.crap), 0);
  const worst = rows.reduce(
    (best, row) => (best === null || row.crap > best.crap ? row : best),
    null,
  );
  return {
    functions: rows.length,
    flagged: flagged.length,
    percentFlagged:
      rows.length === 0
        ? 0
        : Number(((flagged.length / rows.length) * 100).toFixed(1)),
    max: Number(max.toFixed(1)),
    worst: worst === null ? null : `${worst.location} ${worst.name}`,
  };
}

/**
 * Git revision and whether the working tree has uncommitted changes. A
 * snapshot from a dirty tree is marked, so the history never pretends an
 * uncommitted result belongs to a clean revision.
 */
function gitState() {
  try {
    const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    });
    if (
      revision.status !== 0 ||
      typeof revision.stdout !== "string" ||
      revision.stdout.trim() === ""
    ) {
      return { revision: "unknown", dirty: false };
    }
    const status = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    });
    const dirty =
      status.status === 0 &&
      typeof status.stdout === "string" &&
      status.stdout.trim() !== "";
    return { revision: revision.stdout.trim(), dirty };
  } catch {
    // Not a Git checkout, for example an unpacked tarball; the revision is
    // optional, so record it as unknown instead of failing.
    return { revision: "unknown", dirty: false };
  }
}

/** One history line: what the codebase looked like at a revision. */
export function makeRecord(rows, threshold, options = {}) {
  const state =
    options.revision === undefined || options.dirty === undefined
      ? gitState()
      : null;
  return {
    at: options.at ?? new Date().toISOString(),
    revision: options.revision ?? state.revision,
    dirty: options.dirty ?? state.dirty,
    threshold,
    coverageKind: "statement",
    ...summarize(rows, threshold),
  };
}

/** Read a JSONL history file into records. */
export function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new ConfigError(`${file}: unreadable history line (${error.message})`);
    }
  }
  return records;
}

/** Append one snapshot, creating the directory when needed. */
export function appendRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function formatDelta(value) {
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : String(value);
}

/** Render the snapshot history as a text trend table. */
export function renderTrend(records, threshold) {
  if (records.length === 0) {
    return "No CRAP history yet. Record one with: npm run crap:record";
  }
  const lines = [
    `CRAP trend (threshold ${threshold})`,
    "",
    "Date (UTC)        Rev       Thr  Functions  Flagged  Share   Max      Δ flagged",
    "----------------  --------  ---  ---------  -------  ------  -------  ---------",
  ];
  let previous = null;
  let anyDirty = false;
  for (const record of records) {
    const delta =
      previous === null ? "-" : formatDelta(record.flagged - previous.flagged);
    if (record.dirty === true) anyDirty = true;
    lines.push(
      [
        String(record.at ?? "?").slice(0, 16).replace("T", " "),
        `${String(record.revision ?? "?").slice(0, 7)}${record.dirty === true ? "*" : ""}`.padEnd(8),
        String(record.threshold ?? "?").padStart(3),
        String(record.functions ?? "?").padStart(9),
        String(record.flagged ?? "?").padStart(7),
        `${record.percentFlagged ?? "?"}%`.padStart(6),
        String(record.max ?? "?").padStart(7),
        delta.padStart(9),
      ].join("  "),
    );
    previous = record;
  }
  if (records.length > 1) {
    const first = records[0];
    const last = records[records.length - 1];
    const delta = last.flagged - first.flagged;
    const direction =
      delta === 0 ? "unchanged" : delta > 0 ? "drifting up" : "improving";
    lines.push(
      "",
      `${records.length} snapshots ${String(first.at ?? "?").slice(0, 10)} → ` +
        `${String(last.at ?? "?").slice(0, 10)}: flagged ${first.flagged} → ` +
        `${last.flagged} (${formatDelta(delta)}), ${direction}.`,
    );
  }
  if (anyDirty) {
    lines.push(
      "",
      "A revision marked * was recorded with uncommitted changes, so it does " +
        "not describe a frozen candidate.",
    );
  }
  const thresholds = [...new Set(records.map((record) => record.threshold))];
  if (thresholds.length > 1) {
    lines.push(
      "",
      `These snapshots used different thresholds (${thresholds.join(", ")}), ` +
        "so their flagged counts are not directly comparable.",
    );
  }
  return lines.join("\n");
}

function printTrend(file, threshold) {
  try {
    console.log(renderTrend(readHistory(file), threshold));
  } catch (error) {
    console.error(`CRAP config error: ${error.message}`);
    process.exit(2);
  }
}

function main() {
  let options;
  try {
    options = resolveOptions(process.argv.slice(2), readPackageConfig(process.cwd()));
  } catch (error) {
    console.error(`CRAP config error: ${error.message}`);
    process.exit(2);
  }
  const { files, showAll, threshold, failAbove } = options;

  // The trend reads only the history file, so it works without coverage data.
  if (options.trend && !options.record) {
    printTrend(options.history, threshold);
    return;
  }

  const coverage = loadCoverage(options.coverage);
  if (!coverage) {
    console.error(
      `No coverage data at ${options.coverage}. Run: npm run test:coverage`,
    );
    process.exit(2);
  }

  const rows = buildRows(files, coverage);
  const flagged = rows.filter((r) => r.crap >= threshold);
  const listed = showAll ? rows : flagged;

  console.log(
    `CRAP analysis: ${rows.length} functions in ${targetFiles(files).length} files ` +
      `(${Object.keys(coverage).length} files in coverage data)`,
  );
  console.log(
    `Settings: threshold ${threshold} (${options.sources.threshold}), ` +
      `coverage ${options.coverage} (${options.sources.coverage})` +
      (failAbove !== null
        ? `, gate above ${failAbove} (${options.sources.failAbove})`
        : ", no gate") +
      (options.record || options.trend
        ? `, history ${options.history} (${options.sources.history})`
        : ""),
  );
  console.log("");
  if (listed.length === 0) {
    console.log(
      showAll
        ? ""
        : `No function scores >= ${threshold}. Minimum score: ` +
            Math.min(...rows.map((r) => r.crap)).toFixed(1),
    );
  } else {
    console.log(" CRAP    CC   Cov%  Location                               Function");
    console.log("------ ---- -----  -------------------------------------  --------");
    for (const row of listed) console.log(formatRow(row));
  }
  console.log("");
  console.log(
    `Summary: ${flagged.length}/${rows.length} functions at or above the ` +
      `CRAP threshold of ${threshold}; max score ` +
      (rows.length > 0 ? rows[0].crap.toFixed(1) : "n/a") +
      ".",
  );
  console.log(
    "Formula: CC^2 * (1 - coverage)^3 + CC. Coverage is statement-level " +
      "from the unit test run; files absent from coverage count as 0%.",
  );

  if (options.record) {
    const record = makeRecord(rows, threshold);
    try {
      appendRecord(options.history, record);
    } catch (error) {
      console.error(`CRAP config error: ${error.message}`);
      process.exit(2);
    }
    console.log(
      `Recorded snapshot ${record.revision} (${record.flagged}/${record.functions} ` +
        `flagged) in ${options.history}.`,
    );
  }

  if (options.trend) {
    console.log("");
    printTrend(options.history, threshold);
  }

  if (failAbove !== null) {
    const failing = rows.filter((r) => r.crap > failAbove);
    if (failing.length > 0) {
      console.error(
        `\nFAIL: ${failing.length} function(s) score above ${failAbove}.`,
      );
      process.exit(1);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
