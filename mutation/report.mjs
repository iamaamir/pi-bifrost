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
import { SUMMARY, timeoutTolerance } from "./config.mjs";
import { ROOT, bindingExclusions, targetNames } from "./targets.mjs";

const COUNTED_STATUSES = ["Killed", "Timeout", "Survived", "NoCoverage", "RuntimeError", "CompileError"];

function parseArgs(argv) {
  const options = {
    dir: "mutation-reports",
    out: null,
    json: null,
    survivors: null,
    annotations: null,
    timeoutTolerance: null,
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

/** Status counts for one report's mutants, plus both score definitions. */
export function summarise(mutants) {
  const counts = Object.fromEntries(COUNTED_STATUSES.map((status) => [status, 0]));
  for (const mutant of mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  // Stryker's own definition: timeouts count as detected.
  const strykerDetected = counts.Killed + counts.Timeout;
  const strykerDenominator = strykerDetected + counts.Survived + counts.NoCoverage;
  // Honest definition: a timeout is not evidence the tests caught anything, and
  // an uncovered mutant is definitely not caught. Both belong in the denominator
  // and neither in the numerator. (With the old command runner `NoCoverage` was
  // always 0 because coverage was unmeasured; the TAP runner measures it, so
  // excluding it here would flatter the score.)
  const honestDetected = counts.Killed;
  const honestDenominator = counts.Killed + counts.Survived + counts.NoCoverage;
  return {
    total: mutants.length,
    ...counts,
    strykerScore: strykerDenominator === 0 ? null : (100 * strykerDetected) / strykerDenominator,
    honestScore: honestDenominator === 0 ? null : (100 * honestDetected) / honestDenominator,
  };
}

/**
 * Split one Stryker JSON report into per-module results. A matrix leg writes a
 * report with exactly one file; a single combined run writes several. Both are
 * supported so a hand-run local report can be summarised the same way.
 */
export function modulesOf(report, name) {
  return Object.entries(report.files ?? {})
    .map(([absolutePath, file]) => {
      const mutants = file.mutants ?? [];
      return {
        name,
        module: basename(absolutePath),
        file: absolutePath,
        mutants,
        summary: summarise(mutants),
        framework: report.framework ?? null,
        thresholds: report.thresholds ?? null,
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
    if (!byModule.has(module)) byModule.set(module, { module, mutants: [], byIdentity: new Map(), conflicts: [] });
    const bucket = byModule.get(module);
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
    framework: reports.find((report) => report.module === bucket.module)?.framework ?? null,
    thresholds: reports.find((report) => report.module === bucket.module)?.thresholds ?? null,
    file: null,
  }));
}

/**
 * Read every `*.json` Stryker report in a directory, merging shards of the same
 * module together.
 */
export function readReports(directory) {
  if (!existsSync(directory)) return [];
  const perReport = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      let report;
      try {
        report = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return [];
      }
      // A file that is not a Stryker report (for example a merged summary) is
      // skipped rather than counted as a module.
      if (!report || typeof report !== "object" || !report.files) return [];
      return modulesOf(report, name);
    });
  return mergeShardReports(perReport);
}

function formatPercent(value) {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

function formatDelta(value) {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
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
    "| Module | Mutants | Killed | Survived | NoCoverage | Timeout | Errors | Honest score | Stryker score |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const report of reports) {
    const s = report.summary;
    const errors = s.RuntimeError + s.CompileError;
    const timeoutMark = s.Timeout > 0 ? `**${s.Timeout}**` : "0";
    const uncoveredMark = s.NoCoverage > 0 ? `**${s.NoCoverage}**` : "0";
    lines.push(
      `| \`${report.module}\` | ${s.total} | ${s.Killed} | ${s.Survived} | ${uncoveredMark} | ${timeoutMark} | ${errors} | ${formatPercent(s.honestScore)} | ${formatPercent(s.strykerScore)} |`,
    );
  }
  const aggregate = summarise(reports.flatMap((report) => report.mutants));
  const shardConflicts = reports.reduce((total, report) => total + (report.conflicts?.length ?? 0), 0);
  aggregate.shardConflicts = shardConflicts;
  lines.push(
    `| **Total** | **${aggregate.total}** | **${aggregate.Killed}** | **${aggregate.Survived}** | **${aggregate.NoCoverage}** | **${aggregate.Timeout}** | **${aggregate.RuntimeError + aggregate.CompileError}** | **${formatPercent(aggregate.honestScore)}** | **${formatPercent(aggregate.strykerScore)}** |`,
  );
  return { lines, aggregate };
}

function healthFlags(reports, aggregate, expectedTargets, toleranceOverride) {
  const flags = [];
  const tolerance = toleranceOverride ?? timeoutTolerance(aggregate.total);
  if (aggregate.Timeout > tolerance) {
    flags.push(
      `**${aggregate.Timeout} mutant(s) timed out, above the tolerance of ${tolerance}.** Stryker counts a timeout as detected, so the Stryker score is inflated. Raise the module's \`timeoutFactor\`/\`timeoutMS\` in \`mutation/config.mjs\` before trusting this run.`,
    );
  } else if (aggregate.Timeout > 0) {
    flags.push(
      `${aggregate.Timeout} mutant(s) timed out (tolerance ${tolerance}). A timeout counts as detected in the Stryker score, so the honest score is the one to read. A few are expected: a mutant that inverts a loop bound or decrements a counter instead of incrementing it genuinely does not terminate.`,
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
      `${aggregate.NoCoverage} mutant(s) have no coverage: no bound test reaches those lines. That is a coverage or dead-code gap rather than a weak assertion. They count against the honest score.`,
    );
  }
  const missing = expectedTargets.filter((target) => !reports.some((report) => report.module === target));
  if (missing.length > 0) {
    flags.push(`**Missing reports** for: ${missing.map((target) => `\`${target}\``).join(", ")}. A missing matrix leg is not a pass.`);
  }
  const unexpected = reports.map((report) => report.module).filter((module) => !expectedTargets.includes(module));
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

function renderTrend(current, previous) {
  if (!previous) return [];
  const lines = ["| Module | Honest score | Previous | Delta |", "| --- | --- | --- | --- |"];
  for (const entry of current) {
    const prior = previous.modules?.find((item) => item.module === entry.module);
    if (!prior || prior.honestScore === null || entry.honestScore === null) continue;
    const delta = entry.honestScore - prior.honestScore;
    lines.push(`| \`${entry.module}\` | ${formatPercent(entry.honestScore)} | ${formatPercent(prior.honestScore)} | ${formatDelta(delta)} |`);
  }
  lines.push("", "Scores move by a few points between identical revisions: at least one mutant was measured at 12 kills and 4 survivals across 16 identical trials. Read the delta as a band, not a regression proof.");
  return lines;
}

export function renderSummary({ reports, expectedTargets = targetNames(), previous = null, metadata = {}, tolerance = null }) {
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
    "**Honest score = killed / (killed + survived + no-coverage).** Stryker's score also counts `Timeout` as detected, which is why both columns are shown. Neither number is enforced as a merge gate; this is a scheduled measurement, not a release gate.",
    "",
  );

  const flags = healthFlags(reports, aggregate, expectedTargets, tolerance);
  if (flags.length > 0) {
    lines.push("### Health flags", "");
    for (const flag of flags) lines.push(`- ${flag}`);
    lines.push("");
  }

  const trend = renderTrend(
    reports.map((report) => ({ module: report.module, honestScore: report.summary.honestScore })),
    previous,
  );
  if (trend.length > 0) lines.push("### Trend", "", ...trend, "");

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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const reports = readReports(options.dir);
  const expectedTargets = targetNames();
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
    missingTargets: expectedTargets.filter((target) => !reports.some((report) => report.module === target)),
    timeoutTolerance: options.timeoutTolerance ?? timeoutTolerance(aggregate.total),
  };
  // A dispatch override is carried into the payload so the pass/fail step can
  // apply it without re-parsing flags.
  if (options.timeoutTolerance !== null) payload.aggregate.timeoutToleranceOverride = options.timeoutTolerance;

  if (options.json) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, JSON.stringify(payload, null, 2));
  }

  const markdown = renderSummary({
    reports,
    expectedTargets,
    tolerance: options.timeoutTolerance ?? undefined,
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
