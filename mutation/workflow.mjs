// Workflow helpers for the scheduled mutation measurement.
//
// These live in a file rather than inline `node -e` because actionlint runs
// shellcheck over workflow `run:` blocks, and a multi-line script inside single
// quotes trips SC2016. Keeping the logic here also makes it testable without
// shelling out.
import { appendFileSync, readFileSync } from "node:fs";
import { SHARDING, TARGETS, TIME_BUDGET, estimatedMinutes, legMinutes, timeoutTolerance, unusableReasons } from "./config.mjs";
import { exceedsBudget, shardsFor, suggestedShards, targetNames } from "./targets.mjs";

/** Resolve the dispatched target selection into a matrix list. */
export function resolveTargets(requested, known = targetNames()) {
  const value = requested === undefined || requested === null || requested === "" ? "all" : requested;
  const selected = value === "all" ? [...known] : [value];
  const unknown = selected.filter((target) => !known.includes(target));
  if (unknown.length > 0) {
    throw new Error(`unknown mutation target(s): ${unknown.join(", ")}; known: ${known.join(", ")}`);
  }
  if (selected.length === 0) throw new Error("no mutation targets selected");
  return selected;
}

/** Parse the `shards` input: 0 means auto, otherwise an explicit count. */
export function resolveShardCount(raw, target) {
  const value = raw === undefined || raw === null || raw === "" ? "0" : String(raw).trim();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > SHARDING.maxShards) {
    throw new Error(`shards must be an integer 0-${SHARDING.maxShards} (0 = auto), got "${value}"`);
  }
  return parsed === 0 ? suggestedShards(target) : parsed;
}

/** Parse the `concurrency` input with a hard bound, so a typo cannot spawn 900 workers. */
export function resolveConcurrency(raw) {
  const value = raw === undefined || raw === null || raw === "" ? "4" : String(raw).trim();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error(`concurrency must be an integer 1-16, got "${value}"`);
  }
  return parsed;
}

/** Parse the optional timeout-tolerance override. */
export function resolveTimeoutTolerance(raw) {
  const value = raw === undefined || raw === null || raw === "" ? "" : String(raw).trim();
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`timeout_tolerance must be a non-negative integer or blank, got "${value}"`);
  }
  return parsed;
}

/**
 * Build the workflow matrix: one entry per shard of each selected module.
 *
 * Each entry carries its own mutated scope, so the matrix expresses sharding
 * without the workflow needing to know how ranges are computed.
 *
 * The projected wall clock is computed from measured per-mutant cost and the
 * plan **fails** when it would exceed `TIME_BUDGET.minutes`. Refusing here costs
 * seconds; discovering the overrun after the fact costs the whole window, and
 * GitHub's 6-hour job limit cannot be raised. The one thing this must never do is
 * meet the cap by measuring fewer mutants.
 */
export function planMatrix({ requested, shards, concurrency } = {}) {
  const targets = resolveTargets(requested);
  const workers = resolveConcurrency(concurrency);

  const overBudget = targets.filter((target) => exceedsBudget(target));
  if (overBudget.length > 0) {
    const detail = overBudget
      .map((target) => `${target} ~${estimatedMinutes(target).toFixed(0)}m even at ${SHARDING.maxShards} shards`)
      .join(", ");
    throw new Error(
      `time budget of ${TIME_BUDGET.minutes}m cannot be met: ${detail}. Sharding is capped at ${SHARDING.maxShards}; raise SHARDING.maxShards or narrow the binding. Do not reduce the mutant population to fit.`,
    );
  }

  const include = [];
  // Resolved counts drive both the matrix and the projection. Using the matrix's
  // own counts matters because an explicit operator choice can be smaller than the
  // automatic suggestion, which would make a leg slower than `legEstimateMinutes`
  // predicts and let an over-budget plan slip through.
  const resolvedCounts = new Map();
  for (const target of targets) {
    const count = resolveShardCount(shards, target);
    resolvedCounts.set(target, count);
    for (const shard of shardsFor(target, count)) {
      include.push({
        target,
        shard: shard.index,
        shardCount: shard.count,
        mutate: shard.mutate,
        // A per-shard artifact name keeps the shards of one module distinct.
        label: shard.count === 1 ? target : `${target} (shard ${shard.index + 1}/${shard.count})`,
      });
    }
  }

  // Legs run in parallel, so the projected wall clock is the slowest leg plus the
  // fixed overhead, not the sum of the legs. Each leg cost comes from the resolved
  // shard count actually placed in the matrix.
  const slowestLeg = Math.max(
    ...targets.map((target) => estimatedMinutes(target) / resolvedCounts.get(target)),
  );
  const projectedMinutes = slowestLeg + TIME_BUDGET.reserveMinutes;
  if (projectedMinutes > TIME_BUDGET.minutes) {
    throw new Error(
      `plan projects ${projectedMinutes.toFixed(0)}m, over the ${TIME_BUDGET.minutes}m budget (slowest leg ${slowestLeg.toFixed(1)}m + ${TIME_BUDGET.reserveMinutes}m overhead). Lower TIME_BUDGET.targetLegMinutes to shard further.`,
    );
  }

  return { targets, include, concurrency: workers, shards: shards ?? "0", projectedMinutes };
}

/** Summary lines appended to the workflow step page. */
export function summaryLines(data) {
  const honest = data?.aggregate?.honestScore;
  const lines = [
    `\`modules=${data?.modules?.length ?? 0} mutants=${data?.aggregate?.total ?? 0} honest=${honest === null || honest === undefined ? "n/a" : honest.toFixed(2)} timeouts=${data?.aggregate?.Timeout ?? 0} tolerance=${timeoutTolerance(data?.aggregate?.total ?? 0)} missing=${(data?.missingTargets?.length ?? 0) + (data?.missingShards?.length ?? 0)}\``,
    "",
  ];
  for (const module of data?.modules ?? []) {
    const score = module.honestScore === null || module.honestScore === undefined ? "n/a" : `${module.honestScore.toFixed(2)}%`;
    lines.push(
      `- \`${module.module}\`: ${score} honest (${module.Killed} killed / ${module.Survived} survived / ${module.Timeout} timeout)`,
    );
  }
  return lines;
}

function run(command, argv) {
  if (command === "plan") {
    // Reads the dispatch inputs from the environment so no workflow expression
    // is interpolated into shell text.
    const plan = planMatrix({
      requested: process.env.REQUESTED,
      shards: process.env.SHARDS,
      concurrency: process.env.CONCURRENCY,
    });
    const tolerance = resolveTimeoutTolerance(process.env.TIMEOUT_TOLERANCE);
    // Per-leg job bound: the slowest leg plus room for the runner to report. A
    // single global bound would either cut a slow shard short or let a stuck leg
    // burn the whole window.
    const legTimeout = Math.ceil(legMinutes());
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan.include })}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(plan.targets)}\n`);
      // The reporter needs the planned shard set to tell a complete module from a
      // module missing an artifact. Derive it from the matrix it is about to run
      // rather than letting the summariser guess.
      const shardCounts = {};
      for (const leg of plan.include) shardCounts[leg.target] = Math.max(shardCounts[leg.target] ?? 0, leg.shardCount);
      appendFileSync(process.env.GITHUB_OUTPUT, `shard_counts=${JSON.stringify(shardCounts)}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `concurrency=${plan.concurrency}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `leg_timeout=${legTimeout}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `timeout_tolerance=${tolerance === null ? "" : tolerance}\n`);
    }
    console.log(`targets: ${plan.targets.join(", ")}`);
    console.log(`matrix legs: ${plan.include.length} (concurrency ${plan.concurrency})`);
    console.log(
      `projected wall clock: ${plan.projectedMinutes.toFixed(1)}m of the ${TIME_BUDGET.minutes}m cap (per-leg bound ${legTimeout}m)`,
    );
    for (const leg of plan.include) console.log(`  ${leg.label}: mutate ${leg.mutate}`);
    return;
  }
  if (command === "resolve-targets") {
    const selected = resolveTargets(process.env.REQUESTED);
    // GITHUB_OUTPUT is only set inside a workflow step; locally this command is
    // a plain inventory print.
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(selected)}\n`);
    console.log(`selected ${selected.length} target(s): ${selected.join(", ")}`);
    return;
  }
  if (command === "plan-cli") {
    // Prints the plan's completeness expectations as report.mjs CLI arguments.
    // Lives here rather than inline in the workflow: actionlint runs shellcheck
    // over `run:` blocks, and multi-line JavaScript inside single quotes trips
    // SC2016.
    const targets = JSON.parse(process.env.PLAN_TARGETS ?? "[]");
    const shardCounts = JSON.parse(process.env.PLAN_SHARDS ?? "{}");
    // An empty set here means the plan job's outputs did not reach this step.
    // Failing loudly beats handing the reporter an empty expectation, which would
    // report every module missing and blame the measurement.
    if (targets.length === 0) throw new Error("plan-cli needs PLAN_TARGETS from the plan job; got none");
    console.log(targets.join(","));
    console.log(Object.entries(shardCounts).map(([target, count]) => `${target}=${count}`).join(","));
    return;
  }
  if (command === "summarise") {
    const path = argv[0] ?? "mutation-out/summary.json";
    const data = JSON.parse(readFileSync(path, "utf8"));
    const lines = summaryLines(data);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
    console.log(lines[0]);
    return;
  }
  if (command === "require-usable") {
    const path = argv[0] ?? "mutation-out/summary.json";
    const data = JSON.parse(readFileSync(path, "utf8"));
    // A dispatch may override the timeout tolerance; the default is calibrated in
    // config.mjs. Blank means "use the calibrated default".
    const override = resolveTimeoutTolerance(process.env.TIMEOUT_TOLERANCE);
    const reasons = unusableReasons(override === null ? data : { ...data, timeoutToleranceOverride: override });
    if (reasons.length > 0) {
      for (const reason of reasons) console.error(`mutation measurement unusable: ${reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`mutation measurement usable: ${data.modules.length} modules`);
    return;
  }
  if (command === "inventory") {
    const requested = argv[0];
    const selected = resolveTargets(requested);
    for (const target of selected) {
      const budget = TARGETS[target];
      console.log(`${target}: timeoutFactor=${budget.timeoutFactor} timeoutMS=${budget.timeoutMS}`);
    }
    return;
  }
  throw new Error(`unknown command ${command}; expected resolve-targets, summarise, require-usable, or inventory`);
}

if (process.argv[1] && process.argv[1].endsWith("workflow.mjs")) run(process.argv[2], process.argv.slice(3));
