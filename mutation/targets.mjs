// Derivation of mutation targets from the repository, not from a hand-written
// list. Every consumer of this module — the Stryker config, the workflow matrix,
// the local runner and the reporter — reads the same derivation, so adding a
// module to ./config.mjs cannot produce a binding that disagrees with reality.
//
// The hand-written list used by issue #62 drifted: `reliability.ts` has 15 direct
// test consumers and `routing.ts` has 10, but the old config bound five files for
// four modules across all of them. Most of its survivors measured absent tests
// rather than weak tests.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SANDBOX_IGNORES,
  SHARDING,
  STRYKER_OPTIONS,
  TAP_NODE_ARGS,
  TARGETS,
  BUN_RUNNER_PLUGIN,
  RUNNER_OVERRIDES,
  TEST_RUNNER,
  TIME_BUDGET,
  estimatedMinutes,
  legMinutes,
} from "./config.mjs";

/** Repository root, one level above this directory. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function allTestFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.(?:ts|mjs)$/u.test(entry.name)) files.push(path);
    }
  };
  walk("tests");
  return files.sort();
}

const IMPORT_PATTERN = /\bfrom\s+["']([^"']+)["']/gu;

/**
 * The repo-relative modules a test imports. Only relative specifiers resolve to
 * a mutated root module; a package specifier never does.
 */
function importedModules(testFile) {
  const source = readFileSync(join(ROOT, testFile), "utf8");
  const modules = new Set();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    modules.add(relative(ROOT, join(dirname(join(ROOT, testFile)), specifier)));
  }
  return modules;
}

let consumerCache;

/** Map of repo-relative module -> sorted test files that import it directly. */
export function directConsumers() {
  if (consumerCache) return consumerCache;
  const cache = new Map();
  for (const testFile of allTestFiles()) {
    for (const module of importedModules(testFile)) {
      if (!cache.has(module)) cache.set(module, []);
      cache.get(module).push(testFile);
    }
  }
  for (const [module, files] of cache) cache.set(module, files.sort());
  consumerCache = cache;
  return cache;
}

/**
 * A bound test that reads the mutated module's own source text cannot be bound
 * to it: Stryker rewrites that source to insert each mutant, so an assertion on
 * the original text fails and the dry run fails before any mutant is measured.
 *
 * Two shapes occur in this repository:
 *   1. an inline read: `readFileSync(join(ROOT, "routing.ts"), "utf8")`;
 *   2. a resolved constant: `const SOURCE = new URL("../x.ts", import.meta.url)`
 *      then `readFileSync(SOURCE, "utf8")`.
 *
 * A plain `from "../target.ts"` import is the normal binding and is not a hit;
 * only a read of the target's bytes is.
 */
function readsTargetSource(source, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const constantPattern = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:new URL\\(|join\\()[^;\\n]*${escaped}`,
    "gu",
  );
  const references = [...source.matchAll(constantPattern)].map((match) => match[1]);
  const readCall = /(?:readFileSync|readFile|cpSync|copyFileSync)\s*\(/u;
  if (!readCall.test(source)) return false;
  const inlinePattern = new RegExp(`(?:readFileSync|readFile|cpSync|copyFileSync)\\s*\\([^)]*${escaped}`, "u");
  if (inlinePattern.test(source)) return true;
  return references.some((name) =>
    new RegExp(`(?:readFileSync|readFile|cpSync|copyFileSync)\\s*\\(\\s*${name}\\b`, "u").test(source),
  );
}

function selfReferentialTests(target) {
  return (directConsumers().get(target) ?? []).filter((file) =>
    readsTargetSource(readFileSync(join(ROOT, file), "utf8"), target),
  );
}

/** The bound test files for one target: its direct consumers, minus self-referential ones. */
export function bindingFor(target) {
  if (!(target in TARGETS)) throw new Error(`unknown mutation target ${target}`);
  const excluded = new Set(selfReferentialTests(target));
  const binding = (directConsumers().get(target) ?? []).filter((file) => !excluded.has(file));
  if (binding.length === 0) {
    throw new Error(`mutation target ${target} has no bindable test consumers; widen the suite or drop the target`);
  }
  return binding;
}

/**
 * Fingerprint of one module's measurement inputs, content-addressed.
 *
 * A measurement's identity is everything whose bytes decide what the bound
 * tests do with this module: the module, the local modules it imports, the
 * bound test files and the local modules they import, plus the configuration
 * that decides how the measurement runs. Two measurements with the same
 * fingerprint covered the same code; the summariser accepts a report only if
 * its fingerprint matches the current checkout, so artifacts from a different
 * revision, binding or config never contribute mutants to the score.
 *
 * The git head is deliberately not part of the key: unrelated commits move HEAD
 * every day and would make every report look foreign. Content identity answers
 * the question that matters -- did the bytes involved in the measurement change?
 */
export function identityInputs(target) {
  return [
    // The measurement configuration, the binding rules, the Stryker shim and the
    // resolved dependency set: each decides what runs, so a change in any of them
    // makes a stored result incomparable even when the module's bytes are equal.
    "mutation/config.mjs",
    "mutation/targets.mjs",
    "stryker.config.mjs",
    "package-lock.json",
    ...localImportClosure([target, ...bindingFor(target)]),
  ];
}

/**
 * SHA-256 over `name`, bytes and newline for every input, in order.
 *
 * Split from the input derivation so both halves can be tested on their own: the
 * derivation says *which* files matter, and the digest says that different bytes
 * produce a different identity. Composed, they prove that changing a transitive
 * dependency invalidates a stored result without either test writing to the
 * repository.
 */
export function identityDigest(files, read) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\n");
    hash.update(read(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function readRepoFile(file) {
  try {
    return readFileSync(join(ROOT, file));
  } catch {
    // An unreadable input invalidates this measurement, not the repo: hash a
    // marker so the identity differs from every readable one.
    return "unreadable";
  }
}

/** The identity of one measurement: its inputs, digested. */
export function measurementIdentity(target) {
  return identityDigest(identityInputs(target), readRepoFile);
}

/**
 * The target plus every local module it (transitively) imports.
 *
 * A measurement's identity has to cover every file whose bytes can change what
 * the bound tests do. Hashing only the mutated module missed its helpers:
 * `cache.ts` imports `storage.ts`, so changing `storage.ts` left the identity
 * unchanged and an old report was still accepted against the new code.
 *
 * Only relative specifiers are followed; a package never resolves into this
 * checkout. The walk is bounded so a pathological graph cannot stall a run, and
 * the visited set makes cycles safe.
 */
function localImportClosure(starts, limit = 200) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length > 0 && seen.size < limit) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const resolved = relative(ROOT, join(dirname(join(ROOT, file)), specifier));
      if (resolved.startsWith("..") || seen.has(resolved)) continue;
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/** Targets and the consumer tests that cannot be bound, for the summary. */
export function bindingExclusions() {
  return Object.fromEntries(
    Object.keys(TARGETS)
      .map((target) => [target, selfReferentialTests(target)])
      .filter(([, files]) => files.length > 0),
  );
}

/** The bound test command for one target. */
export function commandFor(target) {
  return ["node", "--test", "--experimental-strip-types", ...bindingFor(target)].join(" ");
}

/** Line count of the mutated module. */
export function lineCount(target) {
  return readFileSync(join(ROOT, target), "utf8").split("\n").length;
}

/**
 * Split a module into overlapping line ranges for sharded measurement.
 *
 * Ranges must overlap: adjacent boundaries silently drop mutants that straddle
 * them (measured on cache.ts: 176 of 229 mutants recovered). The overlap is
 * `SHARDING.overlapLines`, and `mergeReports` deduplicates by mutant identity.
 */
export function shardsFor(target, shardCount = 1) {
  if (!(target in TARGETS)) throw new Error(`unknown mutation target ${target}`);
  const total = lineCount(target);
  const count = Math.max(1, Math.min(shardCount, total));
  if (count === 1) return [{ index: 0, count: 1, mutate: target, startLine: 1, endLine: total }];
  const stride = total / count;
  const overlap = SHARDING.overlapLines;
  return Array.from({ length: count }, (_, index) => {
    const startLine = Math.max(1, Math.round(index * stride) - (index === 0 ? 0 : overlap));
    const endLine = index === count - 1 ? total : Math.min(total, Math.round((index + 1) * stride) + overlap);
    return { index, count, mutate: `${target}:${startLine}-${endLine}`, startLine, endLine };
  });
}

/**
 * Shard count needed to fit one module inside the per-leg time budget.
 *
 * A shard is a slice of one module measured as its own job, so sharding is the
 * only lever that reduces wall clock without touching the mutant population,
 * the binding, or the thresholds. Concurrency does not help: measured throughput
 * is 1.61 s/mutant at 6 workers and 1.67 at 4, because the cost is per-mutant
 * process startup rather than CPU.
 *
 * Shards are sized to `targetLegMinutes` rather than to the hard allowance, so
 * the plan lands comfortably inside the cap instead of exactly on it.
 */
export function suggestedShards(target) {
  const cost = estimatedMinutes(target);
  return Math.max(1, Math.min(SHARDING.maxShards, Math.ceil(cost / TIME_BUDGET.targetLegMinutes)));
}

/**
 * Whether a module cannot fit the budget even at `maxShards`. This is the case
 * `planMatrix` must refuse: the alternative is a job that runs long and fails,
 * or worse, one that quietly measures fewer mutants to stay inside the cap.
 */
export function exceedsBudget(target) {
  return estimatedMinutes(target) / SHARDING.maxShards > legMinutes();
}

/** Estimated wall clock for one leg of this target, after sharding. */
export function legEstimateMinutes(target) {
  return estimatedMinutes(target) / suggestedShards(target);
}

export function targetNames() {
  return Object.keys(TARGETS);
}

/**
 * The runner a target uses: its override, else the default. Absent means
 * `TEST_RUNNER`. Kept as a function so callers cannot disagree with config.
 */
export function runnerFor(target) {
  return RUNNER_OVERRIDES[target]?.runner ?? TEST_RUNNER;
}

/**
 * The Stryker config for one target. `MUTATION_TARGET` selects the module so a
 * single matrix leg measures exactly one module with its own budget.
 *
 * `mutate` overrides the mutated scope, which is how a shard narrows one module
 * to a line range (`cache.ts:1-140`). It defaults to the whole module.
 *
 * `runner` overrides the target's configured runner. Normally omit it: the
 * per-target choice in `RUNNER_OVERRIDES` records *why* a module cannot use the
 * default, and an ad-hoc override loses that.
 */
export function targetConfig(
  target,
  {
    reporters = STRYKER_OPTIONS.reporters,
    reportFile = STRYKER_OPTIONS.reportFile,
    mutate,
    runner = runnerFor(target),
    incremental = false,
  } = {},
) {
  const budget = TARGETS[target];
  if (!budget) throw new Error(`unknown mutation target ${target}`);
  const config = {
    ...STRYKER_OPTIONS,
    reporters,
    mutate: [mutate ?? target],
    ignorePatterns: SANDBOX_IGNORES,
    timeoutFactor: budget.timeoutFactor,
    timeoutMS: budget.timeoutMS,
    tempDirName: STRYKER_OPTIONS.tempDirName,
    testRunner: runner,
  };
  if (runner === "bun") {
    // Per-test coverage: each mutant runs only the individual tests that reach
    // it, which is what makes this the fastest option.
    config.appendPlugins = [BUN_RUNNER_PLUGIN];
    config.coverageAnalysis = "perTest";
    config.bun = { testFiles: bindingFor(target) };
  } else if (runner === "tap") {
    // Per-test-file coverage: each mutant runs only the files that reach it.
    config.coverageAnalysis = "perTest";
    config.tap = {
      testFiles: bindingFor(target),
      // The runner spawns the child from the sandbox, so the guard needs an
      // absolute path; a relative `-r` fails the dry run there (measured).
      nodeArgs: TAP_NODE_ARGS.map((arg) =>
        arg === "{{cwdGuard}}" ? join(ROOT, "mutation", "preload-restore-cwd.mjs") : arg,
      ),
    };
  } else {
    throw new Error(`unknown mutation runner ${runner}; expected "bun" or "tap"`);
  }
  // Incremental reuse is opt-in and off by default.
  //
  // The nightly is the authoritative measurement, so it must measure every
  // mutant. Incremental produces a full report by replaying stored results, and
  // it cannot see changes outside the mutated files and the bound test files
  // (dependency updates, environment, fixtures). With the TAP runner it does
  // correctly invalidate on test edits, which makes it a good *local* loop, but
  // a nightly that silently replays last night's score is not a measurement.
  if (incremental) {
    if (runner === "command") {
      // Blind reuse: no test reporting means every stored result is reused
      // (measured: 228 of 229 after editing a bound test file).
      throw new Error("incremental mode requires the tap runner; the command runner reuses results blindly");
    }
    config.incremental = true;
    // One file per target: a matrix leg must not read or write another module's
    // stored results.
    config.incrementalFile = `reports/mutation/.incremental-${target.replace(/\.ts$/u, "")}.json`;
  }
  delete config.reportFile;
  if (reportFile) config.jsonReporter = { fileName: reportFile };
  return config;
}

/** Machine-readable target inventory for the workflow matrix and local scripts. */
export function targetInventory() {
  return targetNames().map((target) => ({
    target,
    runner: runnerFor(target),
    timeoutFactor: TARGETS[target].timeoutFactor,
    timeoutMS: TARGETS[target].timeoutMS,
    estimatedMinutes: estimatedMinutes(target),
    shards: suggestedShards(target),
    binding: bindingFor(target),
  }));
}
