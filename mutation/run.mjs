#!/usr/bin/env node
// Mutation runner. One entry point for a developer machine and CI, so the two
// cannot drift apart.
//
//   node mutation/run.mjs                         # every target, sequentially
//   node mutation/run.mjs routing.ts              # one target
//   node mutation/run.mjs routing.ts --concurrency 8
//   node mutation/run.mjs cache.ts --shards 2     # split one module across shards
//   node mutation/run.mjs cache.ts --mutate cache.ts:1-140 --report reports/mutation/leg.json
//   node mutation/run.mjs --list                  # inventory and bindings, no run
//   node mutation/run.mjs cache.ts --dry-run      # verify the binding only
//
// Reports land in reports/mutation/. Summarise with:
//   node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SHARDING, TARGETS, estimatedMinutes } from "./config.mjs";
import { ROOT, bindingFor, shardsFor, suggestedShards, targetNames } from "./targets.mjs";

function parseArgs(argv) {
  const options = {
    targets: [],
    concurrency: null,
    list: false,
    dryRun: false,
    shards: null,
    mutate: null,
    report: null,
    incremental: false,
  };
  const value = (index) => {
    if (index + 1 >= argv.length) throw new Error(`${argv[index]} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--incremental") options.incremental = true;
    else if (arg === "--concurrency") {
      options.concurrency = value(index);
      index += 1;
    } else if (arg === "--shards") {
      options.shards = Number(value(index));
      index += 1;
    } else if (arg === "--mutate") {
      options.mutate = value(index);
      index += 1;
    } else if (arg === "--report") {
      options.report = value(index);
      index += 1;
    } else if (arg.startsWith("-")) throw new Error(`unknown argument ${arg}`);
    else options.targets.push(arg);
  }
  if (
    options.shards !== null &&
    (!Number.isInteger(options.shards) || options.shards < 1 || options.shards > SHARDING.maxShards)
  ) {
    throw new Error(`--shards must be an integer 1-${SHARDING.maxShards}`);
  }
  if (options.mutate !== null && !/^[\w.-]+(:\d+(:\d+)?-\d+(:\d+)?)?$/u.test(options.mutate)) {
    throw new Error("--mutate must look like file.ts or file.ts:120-260");
  }
  if (options.mutate !== null && options.targets.length === 0) {
    throw new Error("--mutate requires an explicit target");
  }
  if (options.mutate !== null && options.shards !== null) {
    throw new Error("--mutate and --shards are mutually exclusive");
  }
  return options;
}

function inventory() {
  for (const target of targetNames()) {
    const budget = TARGETS[target];
    const local = estimatedMinutes(target, { planned: false });
    const planned = estimatedMinutes(target);
    const shards = suggestedShards(target);
    console.log(
      `\n${target}  (timeoutFactor ${budget.timeoutFactor}, timeoutMS ${budget.timeoutMS})`,
    );
    console.log(
      `  measured ~${local.toFixed(1)}m locally, ~${planned.toFixed(1)}m on CI as planned; ${shards} shard(s) -> ~${(planned / shards).toFixed(1)}m/leg`,
    );
    for (const file of bindingFor(target)) console.log(`  ${file}`);
  }
}

/** The only directory a measurement may write a report into (gitignored). */
export const REPORTS_ROOT = join(ROOT, "reports");

/**
 * Whether a path is inside the reporting directory.
 *
 * A bare prefix test is not enough: `reports-archive/x.json` shares the string
 * prefix but is a different directory, so the separator is part of the check.
 * The root itself is not inside itself, which is what rejects `--report reports`.
 */
export function isInsideReports(path, reportsRoot = REPORTS_ROOT) {
  const prefix = reportsRoot.endsWith(sep) ? reportsRoot : `${reportsRoot}${sep}`;
  return resolve(path).startsWith(prefix);
}

/**
 * Resolve an explicit `--report` path, confined to the reporting directory.
 *
 * The flag used to accept any path inside the checkout, which is unsafe in two
 * ways that share a root cause: this run *deletes its own previous output*
 * before measuring, and Stryker then writes over that path. `--report
 * package.json` would therefore delete a tracked file and replace it with a
 * JSON report. `reports/` is gitignored, so confining output there means the
 * command can only ever touch measurement artifacts.
 *
 * A directory is rejected rather than left to fail obscurely: the cleanup step
 * cannot unlink a directory and Stryker cannot write to one.
 */
export function resolveReportPath(reportPath, reportsRoot = REPORTS_ROOT) {
  if (typeof reportPath !== "string" || reportPath.trim() === "") {
    throw new Error("--report needs a file path");
  }
  const resolved = resolve(ROOT, reportPath);
  if (!isInsideReports(resolved, reportsRoot)) {
    throw new Error(
      `--report must name a file under ${relative(ROOT, reportsRoot)}/ (got ${reportPath}); the runner removes its own previous output, so a path elsewhere could delete a source or tracked file`,
    );
  }
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new Error(`--report must name a file, not a directory (got ${reportPath})`);
  }
  return resolved;
}

/**
 * Which reports this invocation may delete before measuring.
 *
 * A normal run writes the target's whole report set, so every stale report for
 * that target goes. An explicit `--report` writes exactly one file: sibling
 * shards must survive, but this run's own output must not, or a run that fails
 * before writing leaves its previous contents to be read as a completed shard.
 */
export function staleReportsFor(options, run) {
  if (!options.report) return { scope: "target" };
  return { scope: "own", path: run.reportPath };
}

/**
 * The files a measured run may remove before it starts, as absolute paths.
 *
 * Exported and pure so the ownership rule is testable without touching the
 * filesystem. An explicit `--report` owns exactly one path; a normal run owns
 * the target's whole report set inside the reporting directory. Nothing else in
 * that directory is ever a candidate, so a summary, a notes file, or another
 * module's report cannot be deleted by accident.
 */
export function reportsToClear(options, run, reportsDir, entries) {
  const plan = staleReportsFor(options, run);
  if (plan.scope === "own") {
    // Defence in depth: a caller can hand this function a path directly, so the
    // ownership boundary is enforced here as well as at resolution time.
    if (!isInsideReports(plan.path)) {
      throw new Error(`refusing to clear a report outside ${relative(ROOT, REPORTS_ROOT)}/: ${plan.path}`);
    }
    return [plan.path];
  }
  return entries.filter((entry) => isReportFor(entry, run.target)).map((entry) => join(reportsDir, entry));
}

/**
 * Whether a file in the report directory is one of `target`'s own reports.
 * Exact-name and exact-suffix only: `cache.ts` must never match
 * `cache-classifier.ts.json`, because deleting another module's report would
 * silently shrink that module's measured population.
 */
export function isReportFor(entry, target) {
  if (entry === `${target}.json`) return true;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}\\.shard\\d+\\.json$`, "u").test(entry);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    inventory();
    return;
  }
  const targets = options.targets.length > 0 ? options.targets : targetNames();
  const unknown = targets.filter((target) => !(target in TARGETS));
  if (unknown.length > 0) {
    console.error(`unknown target(s): ${unknown.join(", ")}; known: ${targetNames().join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (options.shards !== null && targets.length > 1) {
    // A shard is a slice of one module; applying it to several would make the
    // report names ambiguous.
    throw new Error("--shards applies to exactly one target");
  }
  if (options.report !== null) {
    // One explicit output file has to mean one measurement. Previously the flag
    // was silently ignored unless --mutate was also given, and ignored entirely
    // when sharding, so an operator could believe they had captured a report
    // that was never written to the path they named.
    if (targets.length !== 1) throw new Error("--report applies to exactly one target");
    if (options.shards !== null) throw new Error("--report cannot be combined with --shards; each shard writes its own file");
  }

  const reportsDir = join(ROOT, "reports", "mutation");
  mkdirSync(reportsDir, { recursive: true });
  const failed = [];

  // A previous run of the same target can leave `<target>.json` and/or
  // `<target>.shardN.json` behind. The summariser merges every `*.json` in the
  // directory, so stale files would be counted alongside the new measurement
  // (e.g. an unsharded report reappearing after a sharded rerun). Clearing is
  // per target, per measurement, so a multi-target run keeps each earlier
  // target's fresh output while still discarding that target's own stale files.
  const clearedKeys = new Set();
  function clearPreviousReports(run) {
    const plan = staleReportsFor(options, run);
    // Keyed by plan, not just target: two own-scope runs of the same target in one
    // invocation write different files and each must clear its own.
    const key = plan.scope === "own" ? `own\u0000${plan.path}` : run.target;
    if (clearedKeys.has(key)) return;
    clearedKeys.add(key);
    let entries;
    try {
      entries = readdirSync(reportsDir);
    } catch (error) {
      console.error(`warning: could not read ${reportsDir} to clear previous reports for ${run.target}: ${error.message}`);
      return;
    }
    for (const path of reportsToClear(options, run, reportsDir, entries)) {
      if (!existsSync(path)) continue;
      try {
        unlinkSync(path);
      } catch (error) {
        // A stale report left in place is a silent-wrong-answer risk, but
        // aborting here would discard every other target's measurement too.
        console.error(`warning: could not remove stale report ${path}: ${error.message}`);
      }
    }
  }

  // One run per shard when sharding, otherwise one per target. Each shard writes
  // its own report so the summariser can merge them back together.
  const runs = targets.flatMap((target) => {
    if (options.mutate) {
      return [{ target, mutate: options.mutate, reportName: `${target}.json`, label: options.mutate }];
    }
    const shards = shardsFor(target, options.shards ?? 1);
    if (shards.length === 1) return [{ target, mutate: target, reportName: `${target}.json`, label: target }];
    return shards.map((shard) => ({
      target,
      mutate: shard.mutate,
      reportName: `${target}.shard${shard.index}.json`,
      label: `${target} shard ${shard.index + 1}/${shard.count}`,
    }));
  });

  // An explicit --report file is written where the operator asked; everything
  // else lands in the reporting directory under its derived name.
  for (const run of runs) {
    run.reportPath = options.report === null ? join(reportsDir, run.reportName) : resolveReportPath(options.report);
    mkdirSync(dirname(run.reportPath), { recursive: true });
  }

  for (const run of runs) {
    clearPreviousReports(run);
    console.log(`\n=== ${run.label} (${bindingFor(run.target).length} bound test files) ===`);
    const args = ["stryker", "run"];
    if (options.concurrency) args.push("--concurrency", options.concurrency);
    if (options.dryRun) args.push("--dryRunOnly");
    const result = spawnSync("npx", args, {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        MUTATION_TARGET: run.target,
        MUTATION_MUTATE: run.mutate,
        MUTATION_REPORT_FILE: relative(ROOT, run.reportPath),
        // Opt-in local reuse. CI never sets this: the nightly must measure
        // every mutant rather than replay a stored score.
        MUTATION_INCREMENTAL: options.incremental ? "1" : "",
      },
    });
    if (result.status !== 0) failed.push(run.label);
  }

  if (failed.length > 0) {
    console.error(`\nmutation run failed for: ${failed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nreports: reports/mutation/");
  console.log("summarise: node mutation/report.mjs --dir reports/mutation --out /tmp/mutation.md");
}

if (process.argv[1] && process.argv[1].endsWith("run.mjs")) {
  try {
    main();
  } catch (error) {
    // Clear a partial sandbox so the next run is not confused by it.
    rmSync(join(ROOT, ".stryker-tmp"), { recursive: true, force: true });
    throw error;
  }
}
