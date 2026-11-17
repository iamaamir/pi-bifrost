// Turn Stryker JSON reports into (a) a readable summary for the workflow step
// page and (b) a survivor extract an agent can consume later.
//
// Two numbers are reported per module. The Stryker score counts a `Timeout` as
// detected, so a mutant that hangs the suite raises the score. That is not a
// detection the tests made on purpose, and on a contended runner it can dominate
// the run: a measured eight-file reliability binding produced 208 of 352 mutants
// as timeouts and a reported 99.43%. The honest score is
// killed / (killed + survived), and this reports both plus the raw status counts
// so the difference is visible rather than argued about.
//
// Usage:
//   node mutation/report.mjs --dir mutation-reports --out summary.md
//   node mutation/report.mjs --dir mutation-reports --json summary.json
//   node mutation/report.mjs --dir mutation-reports --survivors survivors.jsonl
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SUMMARY, moduleUnusableReasons, timeoutTolerance } from "./config.mjs";
import { ROOT, bindingExclusions, measurementIdentity, targetNames } from "./targets.mjs";

const COUNTED_STATUSES = ["Killed", "Timeout", "Survived", "NoCoverage", "RuntimeError", "CompileError"];

function parseList(raw, flag) {
  const values = raw.split(",").map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value === "")) {
    throw new Error(`${flag} must not be empty`);
  }
  return values;
}

function parseTargets(raw) {
  const selected = parseList(raw, "--targets");
  const known = targetNames();
  for (const target of selected) {
    if (!known.includes(target)) {
      throw new Error(`unknown module name "${target}"; known: ${known.join(", ")}`);
    }
  }
  return [...new Set(selected)];
}

function parseShardsPerTarget(raw) {
  const entries = parseList(raw, "--shards-per-target");
  const known = targetNames();
  const expected = new Map();
  for (const entry of entries) {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`--shards-per-target entries must be module=count, got "${entry}"`);
    }
    const module = entry.slice(0, separator);
    const countText = entry.slice(separator + 1);
    if (!known.includes(module)) {
      throw new Error(`unknown module name "${module}" in --shards-per-target; known: ${known.join(", ")}`);
    }
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`--shards-per-target count for "${module}" must be a positive integer`);
    }
    if (expected.has(module)) {
      throw new Error(`--shards-per-target lists "${module}" more than once`);
    }
    expected.set(module, count);
  }
  return expected;
}

function parseArgs(argv) {
  const options = {
    dir: "mutation-reports",
    out: null,
    json: null,
    survivors: null,
    annotations: null,
    timeoutTolerance: null,
    targets: null,
    shardsPerTarget: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--json") options.json = value();
    else if (arg === "--survivors") options.survivors = value();
    else if (arg === "--annotations") options.annotations = value();
    else if (arg === "--targets") options.targets = parseTargets(value());
    else if (arg === "--shards-per-target") options.shardsPerTarget = parseShardsPerTarget(value());
    else if (arg === "--timeout-tolerance") {
      // Blank means "use the calibrated default from config.mjs".
      const raw = value();
      if (raw === "") continue;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--timeout-tolerance must be a non-negative integer");
      options.timeoutTolerance = parsed;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/**
 * Three scores, each over an explicit denominator. One number cannot answer all
 * three questions honestly, and the previous pair (Stryker's and one called
 * "honest") invited exactly the wrong reading: a run with one kill and nine
 * timeouts reported 100% "honest" because timeouts sat in neither the numerator
 * nor the denominator.
 *
 *   strykerScore     (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)
 *                    Stryker's native score. Counts a timeout as detected.
 *
 *   conclusiveScore  Killed / (Killed + Survived + NoCoverage)
 *                    Of the mutants that reached a conclusive verdict, the share
 *                    the tests killed. Excludes `Timeout`, `RuntimeError` and
 *                    `CompileError`, so it is a conditional rate, NOT a
 *                    conservative one. Read it as "when we got an answer, how
 *                    often was it the right one".
 *
 *   populationScore  Killed / (total - Ignored)
 *                    Of every instrumented, evaluated mutant, the share the tests
 *                    killed. Timeouts and errors stay in the denominator and
 *                    never reach the numerator, so an unresolved mutant can never
 *                    be mistaken for a verified kill. This is the conservative
 *                    number and the one to read first.
 *
 * `Ignored` mutants are excluded from the population denominator because Stryker
 * never evaluated them; counting them would penalise a run for mutants it was
 * told not to measure. Every raw count is preserved, so any score can be
 * recomputed from the payload.
 */
export function summarise(mutants) {
  const counts = Object.fromEntries(COUNTED_STATUSES.map((status) => [status, 0]));
  for (const mutant of mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  // Stryker's own definition: timeouts count as detected.
  const strykerDetected = counts.Killed + counts.Timeout;
  const strykerDenominator = strykerDetected + counts.Survived + counts.NoCoverage;
  // Conclusive outcomes only. A timeout is not evidence the tests caught
  // anything, and an uncovered mutant is definitely not caught, so `NoCoverage`
  // stays in this denominator. (With the old command runner `NoCoverage` was
  // always 0 because coverage was unmeasured; the TAP runner measures it.)
  const conclusiveDenominator = counts.Killed + counts.Survived + counts.NoCoverage;
  // Whole evaluated population. Everything Stryker instrumented and evaluated is
  // in the denominator; only a kill reaches the numerator.
  const ignored = counts.Ignored ?? 0;
  const populationDenominator = mutants.length - ignored;
  return {
    total: mutants.length,
    ...counts,
    ignored,
    evaluated: populationDenominator,
    unresolved: counts.Timeout + counts.RuntimeError + counts.CompileError,
    strykerScore: strykerDenominator === 0 ? null : (100 * strykerDetected) / strykerDenominator,
    conclusiveScore: conclusiveDenominator === 0 ? null : (100 * counts.Killed) / conclusiveDenominator,
    populationScore: populationDenominator <= 0 ? null : (100 * counts.Killed) / populationDenominator,
  };
}

function parseReportShard(name) {
  const match = /^(.*?)(?:\.shard(\d+))?\.json$/u.exec(name);
  if (!match) return { moduleName: null, shard: null };
  return {
    moduleName: match[1] || null,
    shard: match[2] === undefined ? null : Number(match[2]),
  };
}

/**
 * Split one Stryker JSON report into per-module results. A matrix leg writes a
 * report with exactly one file; a single combined run writes several. Both are
 * supported so a hand-run local report can be summarised the same way.
 *
 * The `name` is the file the report came from. Provenance (`bifrost`, stamped by
 * the runner) is carried through so the selection step can judge whether the
 * file is a measurement of this checkout. A Stryker report without it is still
 * read, but it belongs to no measurement and is rejected by the selection step.
 */
export function modulesOf(report, name) {
  const { shard } = parseReportShard(name);
  const provenance =
    report.bifrost && typeof report.bifrost === "object"
      ? {
          measurement: typeof report.bifrost.measurement === "string" ? report.bifrost.measurement : null,
        }
      : null;
  return Object.entries(report.files ?? {})
    .map(([absolutePath, file]) => {
      const mutants = file.mutants ?? [];
      return {
        name,
        module: basename(absolutePath),
        shard,
        file: absolutePath,
        mutants,
        summary: summarise(mutants),
        framework: report.framework ?? null,
        thresholds: report.thresholds ?? null,
        provenance,
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * Identify a mutant independent of the shard that measured it. Two shards that
 * overlap both measure the mutants in the overlap, and their results agreed in
 * every measured case, so deduplication keeps the first result and records a
 * conflict if they ever disagree.
 */
function mutantIdentity(module, mutant) {
  const { start, end } = mutant.location ?? {};
  return [
    module,
    `${start?.line ?? 0}:${start?.column ?? 0}-${end?.line ?? 0}:${end?.column ?? 0}`,
    mutant.mutatorName,
    mutant.replacement,
  ].join("|");
}

/**
 * Merge per-shard reports of the same module into one result set.
 *
 * Sharded runs overlap by design (adjacent line ranges would otherwise silently
 * drop mutants that straddle a boundary), so the same mutant can appear in more
 * than one report. Keeping only one copy per identity yields the same mutant set
 * a single full run would produce. A status disagreement between shards is
 * surfaced rather than hidden, because it means the measurement is not
 * reproducible and the score should not be trusted.
 */
export function mergeShardReports(reports) {
  const byModule = new Map();
  for (const report of reports) {
    const module = report.module;
    if (!byModule.has(module)) {
      byModule.set(module, { module, mutants: [], byIdentity: new Map(), conflicts: [], shardsSeen: new Set() });
    }
    const bucket = byModule.get(module);
    // An unsharded run writes `<target>.json` and covers the whole module, which
    // is shard 0 of 1. Recording it as "no shard seen" made every single-shard
    // target look like it had lost its only artifact.
    bucket.shardsSeen.add(Number.isInteger(report.shard) ? report.shard : 0);
    for (const mutant of report.mutants) {
      const identity = mutantIdentity(module, mutant);
      const existing = bucket.byIdentity.get(identity);
      if (!existing) {
        bucket.byIdentity.set(identity, mutant);
        bucket.mutants.push(mutant);
        continue;
      }
      // Both shards measured this mutant. Prefer a real result over Ignored.
      if (existing.status === "Ignored" && mutant.status !== "Ignored") {
        bucket.byIdentity.set(identity, mutant);
        bucket.mutants[bucket.mutants.indexOf(existing)] = mutant;
        continue;
      }
      if (mutant.status !== "Ignored" && existing.status !== "Ignored" && mutant.status !== existing.status) {
        bucket.conflicts.push({
          identity,
          statuses: [existing.status, mutant.status],
          line: mutant.location?.start?.line ?? null,
        });
      }
    }
  }
  return [...byModule.values()].map((bucket) => ({
    module: bucket.module,
    mutants: bucket.mutants,
    summary: summarise(bucket.mutants),
    conflicts: bucket.conflicts,
    shardsSeen: [...bucket.shardsSeen].sort((a, b) => a - b),
    framework: reports.find((report) => report.module === bucket.module)?.framework ?? null,
    thresholds: reports.find((report) => report.module === bucket.module)?.thresholds ?? null,
    provenance: reports.find((report) => report.module === bucket.module)?.provenance ?? null,
    file: null,
  }));
}

/**
 * Partition report files into the modules this invocation may trust and the
 * files it may not.
 *
 * The identity is **per module**, because a module's population is exactly what
 * one measurement of it covered: the module's bytes, its bound tests, and the
 * measurement configuration. The runner stamps that identity into each report it
 * writes, so the summariser can ask, for each module, "was this report produced
 * from the bytes in this checkout?" A report that answers no measured something
 * else -- a different revision, a different binding, a different config -- and
 * must never contribute mutants to the score.
 *
 * A per-run identity cannot express this: modules have different populations, so
 * one scalar would either accept everything or reject everything.
 *
 * Two files claiming the same shard of a module are also rejected. An unsharded
 * `<module>.json` parses as shard 0, so it collides with `<module>.shard0.json`;
 * merging them would publish a composite that no run produced.
 */
export function selectMeasurement(perReport, { identityFor = measurementIdentity } = {}) {
  const rejected = [];
  const eligible = [];
  const grouped = new Map();
  for (const report of perReport) {
    const list = grouped.get(report.module) ?? [];
    list.push(report);
    grouped.set(report.module, list);
  }
  for (const [module, reports] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const reject = (reason) => rejected.push(...reports.map((report) => ({ module, name: report.name, reason })));

    const byShard = new Map();
    let duplicate = null;
    for (const report of reports) {
      const shard = Number.isInteger(report.shard) ? report.shard : 0;
      const first = byShard.get(shard);
      if (first === undefined) byShard.set(shard, report.name);
      else if (first !== report.name) duplicate ??= `${first} and ${report.name} both claim shard ${shard}`;
    }
    if (duplicate) {
      reject(`${duplicate}; keep one measurement of ${module} and rerun the shard`);
      continue;
    }

    const unstamped = reports.find((report) => !report.provenance?.measurement);
    if (unstamped) {
      reject(`${unstamped.name} has no measurement provenance; produce it with mutation/run.mjs`);
      continue;
    }

    let expected;
    try {
      expected = identityFor(module);
    } catch (error) {
      reject(`${module} cannot be identified in this checkout (${error.message})`);
      continue;
    }

    const foreign = reports.find((report) => report.provenance.measurement !== expected);
    if (foreign) {
      reject(
        `${module} was measured against different bytes (${foreign.provenance.measurement.slice(0, 12)} in ${foreign.name}, ${expected.slice(0, 12)} here); rerun it against this checkout`,
      );
      continue;
    }
    eligible.push(...reports);
  }
  return { reports: mergeShardReports(eligible), rejected, rejectedNames: rejected.map((entry) => entry.name) };
}

/**
 * Read every `*.json` Stryker report in a directory and select the modules this
 * measurement can trust before merging anything.
 *
 * The nightly's download merges every leg into one directory, so the directory
 * alone is not evidence of a coherent measurement. A report whose stamped
 * identity does not match the current bytes is reported as rejected rather than
 * silently merged, and reaches the gate as a failure condition.
 */
export function readReports(directory, { identityFor } = {}) {
  const empty = { reports: [], rejected: [], rejectedNames: [] };
  if (!existsSync(directory)) return empty;
  const perReport = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      let report;
      try {
        report = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        // Silently dropping an unreadable report turns a corrupt artifact into a
        // "missing module" with no cause. Say so, then let the missing-report
        // check fail the run.
        console.error(`warning: ignoring unreadable report ${path}: ${error.message}`);
        return [];
      }
      // A file that is not a Stryker report (for example a merged summary) is
      // skipped rather than counted as a module.
      if (!report || typeof report !== "object" || !report.files) return [];
      return modulesOf(report, name);
    });
  return selectMeasurement(perReport, identityFor ? { identityFor } : {});
}

function formatPercent(value) {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

/** Survivor rows, one JSON object per line, for later agent consumption. */
export function survivorRows(reports) {
  return reports.flatMap((report) =>
    report.mutants
      .filter((mutant) => mutant.status === "Survived")
      .map((mutant) => ({
        module: report.module,
        mutantId: mutant.id,
        mutator: mutant.mutatorName,
        replacement: mutant.replacement,
        startLine: mutant.location?.start?.line ?? null,
        startColumn: mutant.location?.start?.column ?? null,
        endLine: mutant.location?.end?.line ?? null,
        endColumn: mutant.location?.end?.column ?? null,
      })),
  );
}

/**
 * Render survivors as GitHub Actions annotations, so each one appears against
 * the exact source line on the run page and in the pull-request diff instead of
 * being buried in an artifact, which is how the previous evidence extracts went
 * unread.
 *
 * Only the highest-signal mutants are annotated: a changed search space of
 * thousands is not readable inline, and GitHub caps annotations per step. The
 * full list stays in `survivors.jsonl`.
 */
export function annotationLines(survivors, limit = 20) {
  // Comparator/conditional/logical survivors usually mean a missing assertion,
  // which is actionable, so they come first. String/block noise comes last.
  const weight = (row) =>
    ({ ConditionalExpression: 0, EqualityOperator: 1, LogicalOperator: 2 })[row.mutator] ?? 3;
  const selected = [...survivors]
    .sort((a, b) => weight(a) - weight(b) || (a.startLine ?? 0) - (b.startLine ?? 0))
    .slice(0, limit);
  return selected.map((row) => {
    const line = row.startLine ?? 1;
    // Commas and newlines would break the workflow-command syntax.
    const detail = `Survived ${row.mutator}: ${String(row.replacement).replaceAll("\n", " ").slice(0, 120)}`;
    return `::warning file=${row.module},line=${line},col=${row.startColumn ?? 1},title=Mutation survived::${detail}`;
  });
}

function topMutators(report, limit) {
  const counts = new Map();
  for (const mutant of report.mutants) {
    if (mutant.status !== "Survived") continue;
    counts.set(mutant.mutatorName, (counts.get(mutant.mutatorName) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function sourceLine(report, mutant) {
  const path = join(ROOT, report.module);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  return lines[(mutant.location?.start?.line ?? 0) - 1]?.trim() ?? null;
}

function topSurvivorLines(report, limit) {
  const survivors = report.mutants.filter((mutant) => mutant.status === "Survived");
  // Prefer comparator/conditional/logical survivors: they usually indicate a
  // missing assertion rather than an equivalent mutant.
  const weight = (mutant) =>
    ({ ConditionalExpression: 0, EqualityOperator: 1, LogicalOperator: 2 })[mutant.mutatorName] ?? 3;
  return survivors
    .sort((a, b) => weight(a) - weight(b) || (a.location?.start?.line ?? 0) - (b.location?.start?.line ?? 0))
    .slice(0, limit);
}

function renderModuleTable(reports) {
  const lines = [
    "| Module | Mutants | Killed | Survived | NoCoverage | Timeout | Errors | Population | Conclusive | Stryker |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    const s = report.summary;
    const errors = s.RuntimeError + s.CompileError;
    const timeoutMark = s.Timeout > 0 ? `**${s.Timeout}**` : "0";
    const uncoveredMark = s.NoCoverage > 0 ? `**${s.NoCoverage}**` : "0";
    lines.push(
      `| \`${report.module}\` | ${s.total} | ${s.Killed} | ${s.Survived} | ${uncoveredMark} | ${timeoutMark} | ${errors} | ${formatPercent(s.populationScore)} | ${formatPercent(s.conclusiveScore)} | ${formatPercent(s.strykerScore)} |`,
    );
  }
  const aggregate = summarise(reports.flatMap((report) => report.mutants));
  const shardConflicts = reports.reduce((total, report) => total + (report.conflicts?.length ?? 0), 0);
  aggregate.shardConflicts = shardConflicts;
  lines.push(
    `| **Total** | **${aggregate.total}** | **${aggregate.Killed}** | **${aggregate.Survived}** | **${aggregate.NoCoverage}** | **${aggregate.Timeout}** | **${aggregate.RuntimeError + aggregate.CompileError}** | **${formatPercent(aggregate.populationScore)}** | **${formatPercent(aggregate.conclusiveScore)}** | **${formatPercent(aggregate.strykerScore)}** |`,
  );
  return { lines, aggregate };
}

function healthFlags(reports, aggregate, expectedTargets, toleranceOverride, shardsPerTarget, unexpectedTargets) {
  const flags = [];
  const tolerance = toleranceOverride ?? timeoutTolerance(aggregate.total);
  if (aggregate.Timeout > tolerance) {
    flags.push(
      `**${aggregate.Timeout} mutant(s) timed out, above the tolerance of ${tolerance}.** Stryker counts a timeout as detected, so the Stryker score is inflated. Raise the module's \`timeoutFactor\`/\`timeoutMS\` in \`mutation/config.mjs\` before trusting this run.`,
    );
  } else if (aggregate.Timeout > 0) {
    flags.push(
      `${aggregate.Timeout} mutant(s) timed out (tolerance ${tolerance}). A timeout counts as detected in the Stryker score and is unresolved in the population score, so population is the one to read. A few are expected: a mutant that inverts a loop bound or decrements a counter instead of incrementing it genuinely does not terminate.`,
    );
  }
  const errors = aggregate.RuntimeError + aggregate.CompileError;
  if (errors > 0) {
    flags.push(
      `**${errors} mutant(s) errored at runtime or compile time.** With no type checker configured these are excluded from the denominator; \`@stryker-mutator/typescript-checker\` would classify them as compile errors instead.`,
    );
  }
  if (aggregate.NoCoverage > 0) {
    // Measured coverage means these are real: no bound test reaches the mutated
    // line at all. That is a coverage gap (or dead code), not a weak assertion,
    // so it belongs on a different backlog from the survivors.
    flags.push(
      `${aggregate.NoCoverage} mutant(s) have no coverage: no bound test reaches those lines. That is a coverage or dead-code gap rather than a weak assertion. They count against both scores.`,
    );
  }
  // The aggregate tolerances are sized for the whole run, so one badly broken
  // module can hide inside a large healthy population. Judge each module against
  // its own population as well, and name it.
  for (const report of reports) {
    for (const reason of moduleUnusableReasons({ module: report.module, ...report.summary }, toleranceOverride)) {
      flags.push(`**${reason}.**`);
    }
  }
  const missing = expectedTargets.filter((target) => !reports.some((report) => report.module === target));
  if (missing.length > 0) {
    flags.push(`**Missing reports** for: ${missing.map((target) => `\`${target}\``).join(", ")}. A missing matrix leg is not a pass.`);
  }
  // A module can report and still be short a shard. Without this flag the merged
  // score covers a subset of the planned mutants while looking complete.
  const shortShards = reports.flatMap((report) => {
    const planned = shardsPerTarget?.get?.(report.module) ?? shardsPerTarget?.[report.module] ?? 0;
    const seen = new Set(report.shardsSeen ?? []);
    return Array.from({ length: planned }, (_, shard) => shard)
      .filter((shard) => !seen.has(shard))
      .map((shard) => `\`${report.module}\` shard ${shard}`);
  });
  if (shortShards.length > 0) {
    flags.push(
      `**Missing shards** for: ${shortShards.join(", ")}. The score would cover only part of the planned mutants.`,
    );
  }
  const extraShards = unexpectedShardsFor(reports, expectedTargets, shardsPerTarget);
  if (extraShards.length > 0) {
    const detail = extraShards.map((entry) => `\`${entry.module}\` shard ${entry.shard} (plan has ${entry.planned})`).join(", ");
    flags.push(
      `**Unexpected shards** for: ${detail}. A shard the plan did not ask for is stale or misrouted, so the merged population is not the planned one.`,
    );
  }
  const unexpected = unexpectedTargets ?? reports.map((report) => report.module).filter((module) => !expectedTargets.includes(module));
  if (unexpected.length > 0) {
    flags.push(`**Unexpected reports** for: ${unexpected.map((module) => `\`${module}\``).join(", ")}. Update \`mutation/config.mjs\`.`);
  }
  // Overlapping shards measure some mutants twice. They agreed in every measured
  // case, so a disagreement means the run is not reproducible.
  const conflicts = reports.flatMap((report) =>
    (report.conflicts ?? []).map((conflict) => ({ module: report.module, ...conflict })),
  );
  if (conflicts.length > 0) {
    const sample = conflicts
      .slice(0, 5)
      .map((conflict) => `\`${conflict.module}:${conflict.line ?? "?"}\` (${conflict.statuses.join(" vs ")})`)
      .join(", ");
    flags.push(
      `**${conflicts.length} shard conflict(s):** overlapping shards disagreed on the same mutant: ${sample}. Rerun with a single shard; the score is not reproducible.`,
    );
  }
  return flags;
}

export function renderSummary({
  reports,
  expectedTargets = targetNames(),
  shardsPerTarget = null,
  metadata = {},
  tolerance = null,
  unexpectedTargets = null,
}) {
  const { lines: tableLines, aggregate } = renderModuleTable(reports);
  const lines = [];
  lines.push("## Mutation measurement", "");
  if (metadata.sha) {
    lines.push(
      `Revision \`${metadata.sha.slice(0, 12)}\` · ${metadata.branch ?? "unknown branch"} · Node ${metadata.node ?? "?"} · Stryker ${reports.find((report) => report.framework)?.framework?.version ?? "?"} · ${aggregate.total} mutants`,
      "",
    );
  }
  lines.push(...tableLines, "");

  lines.push(
    "**Population = killed / every evaluated mutant**, so a timeout or an errored mutant lowers it and can never look like a kill. **Conclusive = killed / (killed + survived + no-coverage)**, the rate among mutants that got a verdict: it excludes timeouts and errors, so it is conditional, not conservative. **Stryker** is Stryker's own score, which counts a `Timeout` as detected. Read population first. None of the three is enforced as a merge gate; this is a scheduled measurement, not a release gate.",
    "",
  );

  const flags = healthFlags(reports, aggregate, expectedTargets, tolerance, shardsPerTarget, unexpectedTargets);
  if (flags.length > 0) {
    lines.push("### Health flags", "");
    for (const flag of flags) lines.push(`- ${flag}`);
    lines.push("");
  }

  lines.push("### Where the survivors are", "");
  for (const report of reports) {
    const survivors = report.summary.Survived;
    if (survivors === 0) continue;
    const top = topMutators(report, SUMMARY.mutatorsPerModule).map(([mutator, count]) => `${mutator} ${count}`).join(", ");
    lines.push(`- \`${report.module}\`: ${survivors} survivors — ${top}`);
  }
  lines.push("", "Top unasserted boundaries (conditional, equality, logical survivors first):", "");

  for (const report of reports) {
    const survivors = topSurvivorLines(report, SUMMARY.survivorsPerModule);
    if (survivors.length === 0) continue;
    lines.push(`<details><summary><code>${report.module}</code> — first survivors</summary>`, "");
    for (const mutant of survivors) {
      const line = mutant.location?.start?.line ?? "?";
      const source = sourceLine(report, mutant);
      lines.push("```diff");
      if (source) lines.push(`  ${line}: ${source}`);
      lines.push(`  ${mutant.mutatorName} → ${String(mutant.replacement).slice(0, 100)}`);
      lines.push("```");
    }
    lines.push("</details>", "");
  }

  lines.push("### How to read this", "");
  lines.push(
    "- A surviving mutant means the bound tests still pass with that change, so the behaviour it encodes is unasserted *somewhere in the bound set*.",
    "- Binding is derived from direct imports. Tests that reach a module only through a caller are not bound, so these scores are a lower bound.",
    "- The TAP runner gives per-test-file coverage, so each mutant runs only the files that reach it. Coverage is per file, not per test name.",
    "- Full report and survivor extract are attached to this run. `survivors.jsonl` carries module, mutant id, mutator, replacement, and exact range.",
  );

  const exclusions = bindingExclusions();
  if (Object.keys(exclusions).length > 0) {
    lines.push(
      "",
      "### Deliberately unbound",
      "",
      "These consumer tests cannot be bound to their module: they assert on its source text, which Stryker rewrites to insert each mutant, so the dry run fails for every mutant.",
      "",
    );
    for (const [target, files] of Object.entries(exclusions)) {
      for (const file of files) lines.push(`- \`${file}\` → \`${target}\``);
    }
  }
  return lines.join("\n");
}

/**
 * Shards that reported but were not part of the plan.
 *
 * A previous run with more shards leaves artifacts behind, and the summariser
 * merges every report it finds. Missing-shard detection cannot see this: the plan
 * asked for 2, the directory holds 0, 1 and a stale 2, and nothing looks absent.
 * The stale shard's mutants are then merged into a population the plan never
 * described. Treating it as a misrouted or stale artifact is the only safe read.
 */
function unexpectedShardsFor(reports, expectedTargets, shardsPerTarget) {
  if (!shardsPerTarget) return [];
  const extra = [];
  for (const [module, count] of [...shardsPerTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!expectedTargets.includes(module)) continue;
    const report = reports.find((entry) => entry.module === module);
    for (const shard of report?.shardsSeen ?? []) {
      if (shard >= count) extra.push({ module, shard, planned: count });
    }
  }
  return extra;
}

function missingShardsFor(reports, expectedTargets, shardsPerTarget) {
  if (!shardsPerTarget) return [];
  const missing = [];
  for (const [module, count] of [...shardsPerTarget.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!expectedTargets.includes(module)) continue;
    const report = reports.find((entry) => entry.module === module);
    const seen = new Set(report?.shardsSeen ?? []);
    for (let shard = 0; shard < count; shard += 1) {
      if (!seen.has(shard)) missing.push({ module, shard });
    }
  }
  return missing;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedTargets = options.targets ?? targetNames();
  // A report for a module this run did not plan must never reach the score. A
  // stale artifact from an earlier wider run would otherwise be merged into the
  // aggregate and into `modules`, publishing a number that covers mutants the
  // run never measured. Only the selected set is scored; the foreign reports are
  // carried separately so the gate can name them.
  const readAll = readReports(options.dir);
  const ineligible = readAll.rejected ?? [];
  const reports = readAll.reports.filter((report) => expectedTargets.includes(report.module));
  // A rejected report for a selected module is a failure condition with a
  // reason; a report for a module outside the selection is reported as
  // unexpected, whether or not its provenance checked out.
  const rejected = ineligible
    .filter((entry) => expectedTargets.includes(entry.module))
    .map((entry) => ({ module: entry.module, name: entry.name, reason: entry.reason }));
  const rejectedModules = [...new Set(rejected.map((entry) => entry.module))].sort();
  const unexpectedTargets = [
    ...new Set([...readAll.reports, ...ineligible].map((entry) => entry.module).filter((module) => !expectedTargets.includes(module))),
  ].sort();
  const survivors = survivorRows(reports);

  if (options.survivors) {
    mkdirSync(dirname(options.survivors), { recursive: true });
    writeFileSync(options.survivors, survivors.map((row) => JSON.stringify(row)).join("\n") + (survivors.length ? "\n" : ""));
  }

  if (options.annotations) {
    // Written verbatim to stdout by the workflow so GitHub renders each one
    // against its source line.
    mkdirSync(dirname(options.annotations), { recursive: true });
    writeFileSync(options.annotations, annotationLines(survivors).join("\n") + "\n");
  }

  const aggregate = summarise(reports.flatMap((report) => report.mutants));
  aggregate.shardConflicts = reports.reduce((total, report) => total + (report.conflicts?.length ?? 0), 0);
  const payload = {
    generatedAt: new Date().toISOString(),
    modules: reports.map((report) => ({ module: report.module, ...report.summary })),
    aggregate,
    expectedTargets,
    unexpectedTargets,
    missingTargets: expectedTargets.filter((target) => !reports.some((report) => report.module === target)),
    missingShards: missingShardsFor(reports, expectedTargets, options.shardsPerTarget),
    unexpectedShards: unexpectedShardsFor(reports, expectedTargets, options.shardsPerTarget),
    rejectedReports: rejected,
    rejectedModules,
    timeoutTolerance: options.timeoutTolerance ?? timeoutTolerance(aggregate.total),
  };
  // unusableReasons (config.mjs) gates on the top-level timeoutToleranceOverride;
  // timeoutTolerance is the resolved value carried for display regardless of source.
  if (options.timeoutTolerance !== null) payload.timeoutToleranceOverride = options.timeoutTolerance;

  if (options.json) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, JSON.stringify(payload, null, 2));
  }

  const markdown = renderSummary({
    reports,
    expectedTargets,
    shardsPerTarget: options.shardsPerTarget,
    tolerance: options.timeoutTolerance ?? undefined,
    unexpectedTargets,
  });
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, markdown);
  } else {
    process.stdout.write(markdown + "\n");
  }
  return payload;
}

if (process.argv[1] && process.argv[1].endsWith("report.mjs")) main();
