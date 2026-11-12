import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, symlinkSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arch, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { emptyReliabilityV2State, modelScopeKey } from "../reliability-v2.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";
import { ProviderCooldownStore, projectProviderCooldownsForRouting, providerScopeModelKey } from "../provider-cooldowns.ts";

const outputPath = process.argv[2];
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const headAtStart = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const BASELINE_REVISION = "b5b38945cd26cf684faafefea5dbf7d2dbad58d9";
const BASELINE_SOURCE_SHA256 = "ae3b365c1f395bf28ece26a7dd26c127fabb68e5766cd16bb6e4246251cb66e6";
const SOURCE_PATHS = [
  "provider-cooldowns.ts",
  "reliability-v2-store.ts",
  "reliability-v2.ts",
  "failure-observations.ts",
  "reliability-migration.ts",
  "storage.ts",
  "reliability-v1-fence.ts",
  "scripts/provider-projection-benchmark.mjs",
];
const fingerprint = (source) => createHash("sha256").update(source).digest("hex");
function sourceFingerprints() {
  return Object.fromEntries(SOURCE_PATHS.map((path) => [path, fingerprint(readFileSync(join(root, path)))]));
}
const sourceFingerprintsAtStart = sourceFingerprints();
const baselineSource = execFileSync("git", ["show", `${BASELINE_REVISION}:provider-cooldowns.ts`], { cwd: root, encoding: "utf8" });
assert.equal(fingerprint(baselineSource), BASELINE_SOURCE_SHA256, "pinned baseline source changed");
assert.match(baselineSource, /providers\.set\(model\.provider, providerStore\.read\(model\.provider/);
const fixedNow = 1_800_000_000_000;
const shortIterations = 12;
const representativeIterations = 101;
const warmupIterations = 3;
const fixtureDirectories = [];
const baselinePackage = mkdtempSync(join(tmpdir(), "bifrost-provider-projection-baseline-"));

writeFileSync(join(baselinePackage, "package.json"), JSON.stringify({ type: "module" }));
for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") && name !== "provider-cooldowns.ts")) {
  symlinkSync(join(root, file), join(baselinePackage, file));
}
writeFileSync(join(baselinePackage, "provider-cooldowns.ts"), baselineSource);
const baselineModule = await import(pathToFileURL(join(baselinePackage, "provider-cooldowns.ts")).href);
assert.equal(typeof baselineModule.projectProviderCooldownsForRouting, "function");

function fixture(modelCount, providerCount, historySize, mode) {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-provider-projection-state-"));
  fixtureDirectories.push(directory);
  const state = emptyReliabilityV2State();
  state.scopes[modelScopeKey(providerScopeModelKey("usage", "provider-0"))] = {
    generation: 1, failures: [], openUntil: fixedNow + 60_000,
  };
  for (let index = 0; index < historySize; index++) {
    state.settledOutcomes[`history-${index}`] = { expiresAt: fixedNow + 60_000 };
  }
  const config = {
    failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000, leaseTtlMs: 120_000,
    maxDispatchLifetimeMs: 120_000, dedupRetentionMs: 120_000,
    maxDedupEntries: historySize + 1, maxDispatchReceipts: 100_000,
  };
  const path = join(directory, "provider-state.json");
  let io;
  if (mode === "memory-io") {
    io = { readState: () => state, writeState() {}, writeMigrationBackup() {}, writeLock() {} };
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  }
  const v2 = new ReliabilityV2Store({ path, config, ...(io ? { io } : {}) });
  let reads = 0;
  const readSnapshot = v2.readSnapshot.bind(v2);
  v2.readSnapshot = () => { reads++; return readSnapshot(); };
  const providerStore = new ProviderCooldownStore(v2, 60_000);
  const models = Array.from({ length: modelCount }, (_, index) => ({
    provider: `provider-${index % providerCount}`,
    id: `model-${index}`,
  }));
  return { models, providerStore, getReads: () => reads, resetReads: () => { reads = 0; } };
}

function summarize(reads, samples, iterations, memoryBefore, memoryAfter) {
  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = (percentile) => sorted[Math.ceil(percentile * sorted.length) - 1];
  return {
    snapshotReads: reads,
    iterations,
    latencyMs: {
      p50: nearestRank(0.50),
      p95: nearestRank(0.95),
      mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    },
    observedMemoryDeltaBytes: {
      heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rss: memoryAfter.rss - memoryBefore.rss,
    },
  };
}

function measure(run, getReads, resetReads, iterations) {
  for (let index = 0; index < warmupIterations; index++) { resetReads(); run(); }
  const samples = [];
  resetReads();
  const memoryBefore = process.memoryUsage();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return summarize(getReads(), samples, iterations, memoryBefore, process.memoryUsage());
}

const scenarios = [];
try {
  for (const mode of ["memory-io", "durable-file"])
    for (const modelCount of [10, 100, 1_000])
      for (const providerCount of [...new Set([1, Math.min(5, modelCount), Math.min(20, modelCount), Math.min(100, modelCount)])])
        for (const historySize of [10, 1_000]) {
          const value = fixture(modelCount, providerCount, historySize, mode);
          const state = { version: 1, models: Object.create(null) };
          const snapshotPayloadJsonBytes = Buffer.byteLength(JSON.stringify(value.providerStore.store.readSnapshot()));
          value.resetReads();
          const baselineRun = () => baselineModule.projectProviderCooldownsForRouting(
            state, value.providerStore, value.models, true, fixedNow,
          );
          const fixedRun = () => projectProviderCooldownsForRouting(
            state, value.providerStore, value.models, true, fixedNow,
          );
          const baselineOutput = baselineRun();
          const baselineReadsPerRun = value.getReads();
          value.resetReads();
          const fixedOutput = fixedRun();
          const fixedReadsPerRun = value.getReads();
          assert.deepEqual(fixedOutput, baselineOutput, "selected and excluded model state must match baseline");
          assert.equal(baselineReadsPerRun, providerCount);
          assert.equal(fixedReadsPerRun, value.models.length === 0 ? 0 : 1);

          const iterations = modelCount === 100 && providerCount >= 20 && historySize === 1_000
            ? representativeIterations : shortIterations;
          const baseline = measure(baselineRun, value.getReads, value.resetReads, iterations);
          const fixed = measure(fixedRun, value.getReads, value.resetReads, iterations);
          const baselineReadsPerProjection = baseline.snapshotReads / iterations;
          const fixedReadsPerProjection = fixed.snapshotReads / iterations;
          scenarios.push({
            scope: mode === "durable-file" ? "projection plus default durable-file I/O" : "projection plus injected in-memory I/O",
            modelCount, providerCount, historySize, snapshotPayloadJsonBytes, baseline, fixed,
            baselineReadsPerProjection, fixedReadsPerProjection,
            baselineSnapshotPayloadJsonBytesPerProjection: snapshotPayloadJsonBytes * baselineReadsPerProjection,
            fixedSnapshotPayloadJsonBytesPerProjection: snapshotPayloadJsonBytes * fixedReadsPerProjection,
          });
        }

  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), headAtStart,
    "HEAD changed during the benchmark");
  const sourceFingerprintsAtEnd = sourceFingerprints();
  assert.deepEqual(sourceFingerprintsAtEnd, sourceFingerprintsAtStart, "benchmark source changed while running");

  const result = {
    benchmark: "provider-cooldown-routing-projection",
    scope: "core projection helper only; this is not a whole-Pi routing or end-to-end latency measurement",
    generatedAt: new Date().toISOString(),
    headAtStart,
    headAtEnd: headAtStart,
    environment: {
      cpu: cpus()[0]?.model,
      os: { platform: platform(), release: release(), arch },
      temporaryDirectory: tmpdir(),
      durableFilePolicy: "uses default fs reads under os.tmpdir(); no tmpfs assumption or cache flush; three warmup projections leave normal OS cache behavior in effect",
      warmupIterations,
      p95: "nearest-rank ceil(0.95 * n) - 1",
    },
    baseline: {
      revision: BASELINE_REVISION,
      source: "executed projectProviderCooldownsForRouting imported from an isolated temp package created from git show",
      sha256: BASELINE_SOURCE_SHA256,
    },
    fixed: {
      sourceFingerprintsAtStart,
      sourceFingerprintsAtEnd,
      node: process.version,
      shortIterations,
      representativeIterations,
      semanticParity: "asserted for every scenario",
      memory: "observed heapUsed/RSS deltas are noisy process snapshots; JSON state bytes multiplied by read count is an exact snapshot-volume proxy, not heap allocation",
    },
    scenarios,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), json, "utf8");
  else process.stdout.write(json);
} finally {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
  rmSync(baselinePackage, { recursive: true, force: true });
}
