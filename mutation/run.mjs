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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SHARDING, TARGETS, estimatedMinutes } from "./config.mjs";
import { ROOT, bindingFor, measurementIdentity, shardsFor, suggestedShards, targetNames } from "./targets.mjs";

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
 * Canonical form of a path, resolving symlinks in every component that exists.
 *
 * `realpathSync` alone requires the whole path to exist, which a report path
 * usually does not. Resolution therefore walks up to the nearest existing
 * ancestor and appends the components that do not exist yet: those cannot
 * redirect anything, because creating them creates exactly what they name.
 */
function canonical(path) {
  const created = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...created);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`cannot resolve ${current}: ${error.message}`);
      const parent = dirname(current);
      if (parent === current) throw new Error(`cannot resolve ${path}`);
      created.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether `candidate` is `root` or below it, both already canonical. */
function within(candidate, root) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

/**
 * The reporting boundary, resolved, and refused unless it lies inside the checkout.
 *
 * Resolving the boundary alone is not enough: a symlinked `reports/` makes
 * whatever it points at the boundary, so `reports -> /tmp/elsewhere` authorizes
 * writes and deletions outside the repository. Git cannot commit the link
 * (`reports/` is ignored), but anything with write access to the working tree
 * can create one, so the default boundary is pinned to the repository.
 *
 * A caller that passes its own root is using that root as its trust anchor, which
 * is what lets the tests exercise an isolated fixture.
 */
export function reportingRoot(reportsRoot = REPORTS_ROOT) {
  const root = canonical(reportsRoot);
  const repo = canonical(ROOT);
  const isDefault = canonical(REPORTS_ROOT) === root;
  if (isDefault && (root === repo || !within(root, repo))) {
    throw new Error(
      `refusing to use ${reportsRoot} as the reporting directory: it resolves to ${root}, outside the repository ${repo}`,
    );
  }
  return root;
}

/**
 * Resolve a path against the reporting directory, refusing any answer outside it.
 *
 * Lexical containment is not a boundary: a path can be spelled inside `reports/`
 * while a component is a symlink elsewhere, and `unlinkSync`/`writeFileSync`
 * follow that link and act on the outside target. So the boundary test is made on
 * canonical paths, after every existing component has been resolved. That one
 * check covers `..` traversal, a sibling directory that merely shares a string
 * prefix, and a symlinked intermediate directory, dangling or not.
 */
export function canonicalInside(candidate, reportsRoot = REPORTS_ROOT) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("a report path needs a file path");
  }
  const lexicalRoot = resolve(reportsRoot);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(ROOT, candidate);
  const fromRoot = relative(lexicalRoot, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`not under the reporting directory ${lexicalRoot}`);
  }
  const rootCanonical = reportingRoot(reportsRoot);
  const resolved = canonical(absolute);
  if (resolved === rootCanonical || !within(resolved, rootCanonical)) {
    throw new Error(`resolves to ${resolved}, outside the reporting directory ${rootCanonical}`);
  }
  return resolved;
}

/**
 * Whether a path is inside the reporting directory, as resolved on disk.
 *
 * A bare prefix test is not enough: `reports-archive/x.json` shares the string
 * prefix but is a different directory, and a symlink inside the reporting
 * directory that points outside is not inside it.
 */
export function isInsideReports(path, reportsRoot = REPORTS_ROOT) {
  if (typeof path !== "string") return false;
  try {
    canonicalInside(path, reportsRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Stryker invocation for one run.
 *
 * Both branches build the same arguments; only `--dryRunOnly` differs. Keeping
 * them in one function is why a dry run cannot quietly drop `--concurrency`,
 * which it did when the branch was written out separately.
 */
export function strykerArgs(options, { dryRun = false } = {}) {
  const args = ["stryker", "run"];
  if (dryRun) args.push("--dryRunOnly");
  if (options.concurrency) args.push("--concurrency", options.concurrency);
  return args;
}

/**
 * Resolve an explicit `--report` path, confined to the reporting directory.
 *
 * The flag used to accept any path inside the checkout, which is unsafe in two
 * ways that share a root cause: this run *deletes its own previous output*
 * before measuring, and Stryker then writes over that path. `--report
 * package.json` therefore deleted a tracked file and replaced it with a JSON
 * report. `reports/` is gitignored, so confining output there means the command
 * can only ever touch measurement artifacts.
 *
 * A directory is rejected rather than left to fail obscurely, and so is a
 * symlink: "remove our own output" is unambiguous only for a regular file, since
 * `unlinkSync` removes the link while a write follows it.
 */
export function resolveReportPath(reportPath, reportsRoot = REPORTS_ROOT) {
  if (typeof reportPath !== "string" || reportPath.trim() === "") {
    throw new Error("--report needs a file path");
  }
  let resolved;
  try {
    resolved = canonicalInside(reportPath, reportsRoot);
  } catch (error) {
    throw new Error(
      `--report must name a file under ${relative(ROOT, resolve(reportsRoot))}/ (got ${reportPath}); the runner removes its own previous output, so a path elsewhere could delete a source or tracked file (${error.message})`,
    );
  }
  const spelled = isAbsolute(reportPath) ? resolve(reportPath) : resolve(ROOT, reportPath);
  let stat = null;
  try {
    stat = lstatSync(spelled);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink()) throw new Error(`--report must name a regular file, not a symlink (got ${reportPath})`);
  if (stat?.isDirectory()) throw new Error(`--report must name a file, not a directory (got ${reportPath})`);
  return resolved;
}

/**
 * Stamp a Stryker report with the identity of the measurement it belongs to.
 *
 * Stryker's JSON carries no measurement identity, so the directory alone cannot
 * be judged as one coherent measurement. The runner stamps each report it writes
 * with the content identity of what the run measured -- the module's bytes, its
 * bound tests, and the measurement configuration -- and the summariser accepts a
 * report only if the identity matches the current checkout. A stale report from a
 * different revision, a different binding, or a different config never enters the
 * merged population.
 */
export function stampReport(run, reportPath, identity = measurementIdentity(run.target)) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    console.error(`warning: could not read ${reportPath} to stamp measurement provenance: ${error.message}`);
    return false;
  }
  if (!report || typeof report !== "object" || report.files === undefined) return false;
  report.bifrost = {
    measurement: identity,
    // What was actually mutated. An unsharded report must cover the whole
    // module; a line range is partial and the summariser checks it.
    scope: run.mutate,
  };
  writeFileSync(reportPath, JSON.stringify(report));
  return true;
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
 * Refuse a directory that resolves outside the reporting boundary.
 *
 * Deletion uses the *spelled* path, never a canonicalized one: removing a symlink
 * removes the link, whereas resolving first and unlinking the result would delete
 * the target instead. What has to be contained is therefore the directory the
 * entry lives in.
 */
function assertDirectoryInside(directory, reportsRoot) {
  const resolved = canonical(directory);
  const boundary = reportingRoot(reportsRoot);
  if (!within(resolved, boundary)) {
    throw new Error(`refusing to clear reports: ${directory} resolves to ${resolved}, outside ${boundary}`);
  }
}

/**
 * The files a measured run may remove before it starts, as absolute paths.
 *
 * Exported and pure-ish so the ownership rule is testable without touching the
 * filesystem. An explicit `--report` owns exactly one path; a normal run owns the
 * target's whole report set inside the reporting directory. Nothing else in that
 * directory is ever a candidate, so a summary, a notes file, or another module's
 * report cannot be deleted by accident, and a symlinked directory cannot redirect
 * the delete outside the boundary.
 *
 * A dry run returns nothing: it measures nothing and writes nothing, so clearing
 * would destroy a completed measurement to make room for a report that is never
 * produced.
 */
export function reportsToClear(options, run, reportsDir, entries, reportsRoot = null) {
  if (options.dryRun) return [];
  const plan = staleReportsFor(options, run);
  if (plan.scope === "own") {
    // Defence in depth: a caller can hand this function a path directly, so the
    // boundary is enforced here as well as at resolution time.
    assertDirectoryInside(dirname(plan.path), reportsRoot ?? REPORTS_ROOT);
    return [plan.path];
  }
  // The boundary is the reporting root, not `reportsDir`. Passing `reportsDir`
  // compared the directory against its own canonical form, which is trivially
  // true — so `reports/mutation -> /tmp/x` resolved the check to
  // `within("/tmp/x", "/tmp/x")` and the delete went through. Only the *root* is
  // the trust anchor; anything below it has to be shown to be inside.
  const boundary = reportsRoot ?? REPORTS_ROOT;
  assertDirectoryInside(reportsDir, boundary);
  return entries
    .filter((entry) => isReportFor(entry, run.target))
    .map((entry) => {
      // Fail closed: if the file cannot be shown to be inside the boundary,
      // deleting nothing is better than deleting the wrong file.
      assertDirectoryInside(dirname(join(reportsDir, entry)), boundary);
      return join(reportsDir, entry);
    });
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
  if (options.mutate !== null) {
    // A scope is one module's scope, and a range is not the whole module. If a
    // partial run were allowed to write `<target>.json`, a one-shard plan would
    // accept it as complete and publish a score over part of the module.
    if (targets.length !== 1) throw new Error("--mutate applies to exactly one target");
    // A dry run writes no report, so it has no artifact whose name could claim to
    // be the whole module; requiring --report made every scoped dry run
    // impossible, because --report is refused for dry runs.
    if (!options.dryRun && options.mutate !== targets[0] && options.report === null) {
      throw new Error(
        `--mutate ${options.mutate} measures only part of ${targets[0]}; name the artifact with --report so a partial result is not stored as the whole module`,
      );
    }
  }
  if (options.report !== null) {
    // One explicit output file has to mean one measurement. Previously the flag
    // was silently ignored unless --mutate was also given, and ignored entirely
    // when sharding, so an operator could believe they had captured a report
    // that was never written to the path they named.
    if (targets.length !== 1) throw new Error("--report applies to exactly one target");
    if (options.shards !== null) throw new Error("--report cannot be combined with --shards; each shard writes its own file");
  }
  if (options.dryRun && options.report !== null) {
    throw new Error("--dry-run writes no report; --report would name a file that is never produced");
  }

  const reportsDir = join(ROOT, "reports", "mutation");
  // Validate the boundary before creating anything: creating directories through
  // a redirecting `reports/` would already be outside the repository.
  reportingRoot();
  // A dry run writes no report, so it never creates the reporting directory.
  if (!options.dryRun) mkdirSync(reportsDir, { recursive: true });
  // Per-target identities are computed when each report is stamped: a run may
  // span modules, and each report names the measurement it belongs to.
  const failed = [];

  // A previous run of the same target can leave `<target>.json` and/or
  // `<target>.shardN.json` behind. The summariser merges every `*.json` in the
  // directory, so stale files would be counted alongside the new measurement
  // (e.g. an unsharded report reappearing after a sharded rerun). Clearing is
  // per target, per measurement, so a multi-target run keeps each earlier
  // target's fresh output while still discarding that target's own stale files.
  //
  // A dry run measures nothing and writes nothing, so clearing would only
  // destroy the previous measurement to make room for a report that never
  // exists. It is skipped entirely.
  const clearedKeys = new Set();
  function clearPreviousReports(run) {
    if (options.dryRun) return;
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
    if (options.dryRun) {
      run.reportPath = null;
      continue;
    }
    run.reportPath = options.report === null ? join(reportsDir, run.reportName) : resolveReportPath(options.report);
    mkdirSync(dirname(run.reportPath), { recursive: true });
  }

  for (const run of runs) {
    clearPreviousReports(run);
    console.log(`\n=== ${run.label} (${bindingFor(run.target).length} bound test files) ===`);
    if (options.dryRun) {
      // Validate the sandbox and the binding only. Stryker's `--dryRunOnly`
      // never enters the mutation executor, so no report is written; point the
      // reporter at a per-invocation file that is removed afterwards in case a
      // future Stryker writes something anyway.
      const tempReport = join(ROOT, ".stryker-tmp", `dry-run-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
      mkdirSync(dirname(tempReport), { recursive: true });
      const result = spawnSync("npx", strykerArgs(options, { dryRun: true }), {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          MUTATION_TARGET: run.target,
          MUTATION_MUTATE: run.mutate,
          MUTATION_REPORT_FILE: relative(ROOT, tempReport),
          MUTATION_INCREMENTAL: "",
        },
      });
      try {
        unlinkSync(tempReport);
      } catch {
        // Never created, which is the documented behaviour of --dryRunOnly.
      }
      if (result.status !== 0) failed.push(run.label);
      continue;
    }
    const args = strykerArgs(options);
    // Captured before Stryker starts, because Stryker measures its sandbox copy.
    // Editing the module or a bound test during a long run would otherwise stamp
    // the *new* bytes onto results measured from the old ones.
    const identity = measurementIdentity(run.target);
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
    if (result.status !== 0) {
      failed.push(run.label);
      continue;
    }
    // Every report that reaches the summariser is stamped with the measurement
    // it belongs to. An unstamped report is rejected there, so a run that
    // cannot record its provenance is a failed measurement, not a stale one.
    let stamped = false;
    try {
      if (measurementIdentity(run.target) !== identity) {
        console.error(
          `\nerror: ${run.target} inputs changed while it was being measured; discarding ${run.reportName} rather than stamping it with bytes it did not measure`,
        );
      } else {
        stamped = stampReport(run, run.reportPath, identity);
      }
    } catch (error) {
      console.error(`\nerror: could not confirm ${run.target} inputs after the run: ${error.message}`);
    }
    if (!stamped) failed.push(run.label);
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
