import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRouter } from "../router.ts";
import { resolveConfiguredTier } from "../routing.ts";
import { type ReliabilityState } from "../reliability.ts";
import { emptyEconomicSnapshot, publishEconomicObservation, type EconomicSignal, type ReservePolicy } from "../economic-signals.ts";

const BASELINE_SHA = "236622dbc40789e8ca82226337a26cdd1eb26d2f";
const DEFAULT_BASELINE = "/private/tmp/bifrost-upstream-research-1007";
const NOW = 1_000_000;
const candidatesCounts = [10, 100, 1_000];
const tierCounts = [3, 20, 100];
const modes = [
  "baseline-legacy",
  "current-legacy",
  "current-strict",
  "current-reserve",
  "current-api-legacy",
  "current-api-strict",
  "current-api-factory",
] as const;
type BenchmarkMode = typeof modes[number];

interface Model {
  provider: string;
  id: string;
  cost: { input: number; output: number };
  contextWindow: number;
}

function parseArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function selectedKey(value: unknown, mode: BenchmarkMode): string | undefined {
  const record = value as Record<string, unknown> | undefined;
  if (!record) return undefined;
  if (mode === "current-api-legacy" || mode === "current-api-strict") {
    const decision = record.decision as Record<string, unknown> | undefined;
    return typeof decision?.selected === "string" ? decision.selected : undefined;
  }
  if (mode === "current-api-factory") return typeof record.resolve === "function" ? "factory-created" : undefined;
  const resolution = mode === "baseline-legacy" ? record : record.resolution as Record<string, unknown> | undefined;
  const model = resolution?.selected as Model | undefined;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function buildModels(count: number): Model[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "fixture",
    id: `model-${index.toString().padStart(4, "0")}`,
    cost: { input: (index + 1) / 1_000, output: (index + 1) / 500 },
    contextWindow: 16_000 + index * 8,
  }));
}

function reliability(models: Model[], exhausted: boolean): ReliabilityState | undefined {
  if (!exhausted) return undefined;
  return {
    version: 1,
    models: Object.fromEntries(models.map((model) => [`${model.provider}/${model.id}`, {
      failures: [], openUntil: NOW + 60_000,
    }])),
  };
}

function reserveContext(reject: boolean) {
  const policy: ReservePolicy = {
    mode: "policy",
    scopes: { syntheticProvider: { kind: "provider", provider: "fixture" } },
    sources: [{ id: "synthetic", scopeRef: "syntheticProvider", authority: "authoritative" }],
    admission: [{ id: "synthetic-reserve", scopeRef: "syntheticProvider", windowId: "daily", reserveRatio: 0.2, unknown: "block" }],
  };
  const signal: EconomicSignal = {
    sourceId: "synthetic", scopeRef: "syntheticProvider", billing: "subscription",
    observedAt: NOW - 100, expiresAt: NOW + 60_000, revision: 1,
    windows: [{ id: "daily", period: { id: "p1", sequence: 1 }, unit: "ratio", remaining: reject ? 0.1 : 0.8, resetsAt: NOW + 60_000 }],
  };
  const published = publishEconomicObservation(emptyEconomicSnapshot(), policy, signal);
  if (!published.accepted) throw new Error("Generated economic fixture was rejected.");
  return { policy, snapshot: published.snapshot };
}

function fixture(count: number, tierCount: number, exhausted: boolean, mode: BenchmarkMode) {
  const models = buildModels(count);
  const tierNames = Array.from({ length: tierCount }, (_, index) => `tier${index}`);
  const patterns = models.map((model) => `${model.provider}/${model.id}`);
  const tiers = Object.fromEntries(tierNames.map((tier) => [tier, patterns]));
  const state = reliability(models, exhausted);
  const useReserve = mode === "current-reserve";
  const useStrict = mode === "current-strict" || useReserve || mode === "current-api-strict";
  const economic = useReserve ? reserveContext(exhausted) : undefined;
  const config = {
    schemaVersion: useStrict ? 2 : 1,
    models: tiers,
    default: tierNames[1] ?? tierNames[0],
    strategy: "first" as const,
    rules: [],
    ...(useStrict ? {
      tierPolicies: { [tierNames[0]!]: { fallbackTiers: tierNames.slice(1) } },
    } : {}),
    ...(state ? { reliability: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 } } : {}),
  };
  const registry = {
    knownModels: models,
    availableModels: models,
  };
  const modelIndex = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => modelIndex.get(`${provider}/${id}`),
      getAvailable: () => models,
    },
  } as never;
  return { models, patterns, tierNames, tiers, state, economic, config, registry, ctx };
}

async function loadBaseline(directory: string) {
  const commit = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (commit !== BASELINE_SHA) throw new Error(`Pinned baseline SHA mismatch: ${commit}`);
  const module = await import(pathToFileURL(join(directory, "routing.ts")).href);
  if (typeof module.resolveModelWithFallback !== "function") throw new Error("Pinned baseline does not export resolveModelWithFallback.");
  return { commit, resolveModelWithFallback: module.resolveModelWithFallback as (...args: unknown[]) => unknown };
}

function createRunner(mode: BenchmarkMode, data: ReturnType<typeof fixture>, baseline: Awaited<ReturnType<typeof loadBaseline>>) {
  const { tierNames, patterns, ctx, config, state, economic, registry } = data;
  const requestedTier = tierNames[0]!;
  const routerSnapshot = {
    config: config as never,
    registry,
    now: NOW,
    ...(state ? { reliabilityState: state } : {}),
    ...(economic ? { economic } : {}),
  };
  const publicRouter = mode === "current-api-legacy" || mode === "current-api-strict"
    ? createRouter(routerSnapshot)
    : undefined;
  const route = () => {
    if (mode === "baseline-legacy") {
      return baseline.resolveModelWithFallback(ctx, {
        requestedTier,
        requestedPattern: patterns,
        requestedStrategy: "first",
        defaultTier: tierNames[1] ?? tierNames[0],
        defaultPattern: patterns,
        defaultStrategy: "first",
        reliabilityState: state,
        reliabilityConfig: { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 },
        now: NOW,
      });
    }
    if (mode === "current-legacy") {
      return resolveConfiguredTier(ctx, requestedTier, config as never, state, config.reliability as never, NOW, undefined, () => 0);
    }
    if (mode === "current-strict") {
      return resolveConfiguredTier(ctx, requestedTier, config as never, state, config.reliability as never, NOW, undefined, () => 0);
    }
    if (mode === "current-reserve") {
      return resolveConfiguredTier(ctx, requestedTier, config as never, state, config.reliability as never, NOW, economic, () => 0);
    }
    if (mode === "current-api-factory") return createRouter(routerSnapshot);
    return publicRouter!.resolve({ prompt: "synthetic benchmark request", forcedTier: requestedTier, random: () => 0 });
  };
  return route;
}

async function measure(route: () => unknown | Promise<unknown>, work: number, expected: string | undefined, mode: BenchmarkMode) {
  const representative = work > 0 && work <= 2_000;
  const warmups = representative ? 15 : work >= 50_000 ? 1 : work >= 10_000 ? 2 : 5;
  const samples = representative ? 101 : work >= 50_000 ? 5 : work >= 10_000 ? 9 : 21;
  const verify = (result: unknown) => {
    if (selectedKey(result, mode) !== expected) {
      throw new Error(`Benchmark path ${mode} did not match expected route ${expected ?? "no-route"}.`);
    }
  };
  verify(await route());
  for (let index = 0; index < warmups; index += 1) verify(await route());
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = process.hrtime.bigint();
    verify(await route());
    durations.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  durations.sort((left, right) => left - right);
  return {
    warmups,
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
  };
}

const baselineDir = resolve(parseArg("--baseline-dir", DEFAULT_BASELINE));
const outputPath = resolve(parseArg("--out", "/private/tmp/routing-release-benchmark.json"));
const baseline = await loadBaseline(baselineDir);
const rows: Array<Record<string, unknown>> = [];
for (const count of candidatesCounts) {
  for (const tierCount of tierCounts) {
    for (const exhausted of [false, true]) {
      for (const mode of modes) {
        const data = fixture(count, tierCount, exhausted, mode);
        const route = createRunner(mode, data, baseline);
        const strictPath = mode === "current-strict" || mode === "current-reserve" || mode === "current-api-strict" || mode === "current-api-factory";
        const work = count * (strictPath ? tierCount : exhausted ? 2 : 1);
        const expected = mode === "current-api-factory" ? "factory-created"
          : exhausted ? undefined : `${data.models[0]!.provider}/${data.models[0]!.id}`;
        const timing = await measure(route, work, expected, mode);
        rows.push({
          mode,
          phase: mode === "current-api-factory" ? "router_factory_snapshot_normalization" : "resolve",
          workload: exhausted ? "exhausted_fallback_chain" : "selected_first_pool",
          candidateCount: count,
          configuredTierCount: tierCount,
          maxAttemptedTierCount: mode === "baseline-legacy" || mode === "current-legacy" || mode === "current-api-legacy"
            ? 2 : mode === "current-api-factory" ? 0 : tierCount,
          ...timing,
        });
      }
    }
  }
}

const cpu = cpus()[0];
const report = {
  benchmark: "synthetic offline routing release evaluation",
  createdAt: new Date().toISOString(),
  baseline: { path: baselineDir, commit: baseline.commit, method: "pinned v0.5.0 resolveModelWithFallback legacy requested/default tiers" },
  host: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpu?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    memoryBytes: totalmem(),
    repoPeerPiVersion: "1.0.1",
    hostPiVersion: "not used by this resolver harness",
  },
  methodology: {
    clock: NOW,
    strategy: "first",
    warmCold: "module imports, fixture construction, and router creation occur before timing; timed calls are warmed; cold startup is not measured",
    timing: "per-call wall-clock with process.hrtime.bigint; nearest-rank p50/p95",
    noNetworkOrWrites: true,
    boundedSampling: "101 samples and 15 warmups at 100 candidates/20 tiers; otherwise 21/5, 9/2 above 10k, and 5/1 at or above 50k candidate-tier work units",
    comparability: "only baseline-legacy and current-legacy share legacy low-level requested/default behavior; current-api-legacy measures the public legacy path; strict/reserve/current-api-strict are current-only behavior; factory rows isolate snapshot normalization",
    limits: "synthetic fixture timing is not route accuracy, provider performance, cost savings, or production latency evidence",
  },
  rows,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ outputPath, baseline: baseline.commit, rows: rows.length, host: report.host }) + "\n");
