#!/usr/bin/env node
/**
 * On-demand benchmark runner.
 *
 * Wraps Hyperfine around fixed, deterministic workloads and writes a JSON
 * report under the gitignored reports/bench directory. Hyperfine is an optional
 * host tool: a missing binary is reported as unavailable, never as a pass.
 *
 * Usage: node scripts/bench.mjs [route|projection] [--runs N] [--warmup N] [--json]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_RUNS = 100;
const MAX_WARMUP = 20;

export const TARGETS = {
  route: {
    description: "Resolve-only router hot loop (200,000 resolutions)",
    script: "scripts/perf-workload.mjs",
    args: ["--iterations", "200000"],
    nodeFlags: ["--experimental-strip-types"],
  },
  projection: {
    description: "Provider-failure projection against the pinned baseline",
    script: "scripts/provider-projection-benchmark.mjs",
    args: [],
    nodeFlags: ["--experimental-strip-types"],
  },
};

function positiveInteger(raw, fallback, maximum, name) {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} requires a positive integer`);
  const value = Number.parseInt(raw, 10);
  if (value > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return value;
}

export function parseArgs(argv) {
  const options = { target: "route", runs: 10, warmup: 3, json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--runs") options.runs = positiveInteger(argv[++index], 10, MAX_RUNS, "--runs");
    else if (argument === "--warmup") options.warmup = positiveInteger(argv[++index], 3, MAX_WARMUP, "--warmup");
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown bench flag: ${argument}`);
    else positional.push(argument);
  }
  if (positional.length > 1) throw new Error(`Unknown bench target: ${positional[1]}`);
  if (positional[0]) options.target = positional[0];
  if (!Object.hasOwn(TARGETS, options.target)) throw new Error(`Unknown bench target: ${options.target}`);
  return options;
}

function quoteCommand(parts) {
  if (process.platform === "win32") {
    return parts.map((part) => (/\s/u.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)).join(" ");
  }
  return parts.map((part) => (/^[A-Za-z0-9_./:=@-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}

export function benchPlan(target, { runs, warmup, stamp }) {
  const definition = TARGETS[target];
  if (!definition) throw new Error(`Unknown bench target: ${target}`);
  const command = [
    process.execPath,
    ...definition.nodeFlags,
    join(ROOT, definition.script),
    ...definition.args,
    ...(target === "projection" ? [join(ROOT, "reports", "bench", `projection-${stamp}.json`)] : []),
  ];
  return {
    command,
    artifact: join(ROOT, "reports", "bench", `${target}-${stamp}.json`),
    hyperfineArgs: [
      "--warmup", String(warmup),
      "--runs", String(runs),
      "--command-name", target,
      "--export-json", join(ROOT, "reports", "bench", `${target}-${stamp}.json`),
      "--",
      quoteCommand(command),
    ],
  };
}

export function parseHyperfine(raw) {
  const report = JSON.parse(raw);
  const results = report.results ?? [];
  if (results.length !== 1) throw new Error(`expected one hyperfine result, found ${results.length}`);
  const result = results[0];
  // Hyperfine 2 reports a metric summary object; 1.x reported flat seconds.
  const wall = result.summary?.time_wall_clock;
  const toMs = (value, unit = "second") => value * (unit === "millisecond" ? 1 : unit === "microsecond" ? 0.001 : 1000);
  const mean = wall ? toMs(wall.mean, wall.unit) : toMs(result.mean);
  if (!Number.isFinite(mean)) throw new Error("hyperfine result has no wall-clock mean");
  return {
    command: result.command,
    runs: wall?.count ?? results.length,
    meanMs: Number(mean.toFixed(3)),
    stddevMs: Number((wall ? toMs(wall.stddev, wall.unit) : toMs(result.stddev)).toFixed(3)),
    minMs: Number((wall ? toMs(wall.min, wall.unit) : toMs(result.min)).toFixed(3)),
    maxMs: Number((wall ? toMs(wall.max, wall.unit) : toMs(result.max)).toFixed(3)),
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log([
        "Usage: node scripts/bench.mjs [target] [--runs N] [--warmup N] [--json]",
        "",
        ...Object.entries(TARGETS).map(([name, target]) => `  ${name.padEnd(12)} ${target.description}`),
        "",
        "Requires Hyperfine (https://github.com/sharkdp/hyperfine). Reports go to reports/bench/.",
      ].join("\n"));
      return 0;
    }
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const plan = benchPlan(options.target, { ...options, stamp });
  mkdirSync(dirname(plan.artifact), { recursive: true });
  const result = spawnSync("hyperfine", plan.hyperfineArgs, { cwd: ROOT, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    const message = "hyperfine is not installed. Install it with: brew install hyperfine";
    if (options.json) console.log(JSON.stringify({ target: options.target, status: "unavailable", exitCode: 2, error: message }));
    else console.error(message);
    return 2;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(-2000);
    if (options.json) console.log(JSON.stringify({ target: options.target, status: "failed", exitCode: result.status ?? 1, error: detail }));
    else console.error(`benchmark failed (exit ${result.status ?? 1})\n${detail}`);
    return result.status === 0 ? 1 : result.status ?? 1;
  }

  let summary;
  try {
    summary = parseHyperfine(readFileSync(plan.artifact, "utf8"));
  } catch (error) {
    const message = `could not read hyperfine report: ${error.message}`;
    if (options.json) console.log(JSON.stringify({ target: options.target, status: "failed", exitCode: 1, error: message }));
    else console.error(message);
    return 1;
  }
  const report = { target: options.target, status: "measured", artifact: plan.artifact, ...summary };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${options.target}: mean ${report.meanMs} ms, stddev ${report.stddevMs} ms, min ${report.minMs} ms, max ${report.maxMs} ms`);
    console.log(`report: ${report.artifact}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
