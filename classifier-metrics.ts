import { resolveStoragePath, readJsonFile, writeJsonFile } from "./storage.ts";

export type TypeSafeOutcome =
  | "success"
  | "missing_key"
  | "circuit_open"
  | "aborted"
  | "timeout"
  | "network"
  | "auth"
  | "rate_limited"
  | "http"
  | "invalid_response"
  | "low_confidence";

export interface TypeSafeObservation {
  readonly outcome: TypeSafeOutcome;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly tier?: string;
  readonly confidence?: number;
}

export interface ClassifierMetricsState {
  readonly version: 1;
  readonly model: "jev-1.13.0";
  readonly total: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly tiers: Readonly<Record<string, number>>;
  readonly confidenceBands: Readonly<Record<string, number>>;
  readonly latencyBuckets: Readonly<Record<string, number>>;
  readonly totalLatencyMs: number;
  readonly totalAttempts: number;
  readonly lastObservedAt?: number;
}

export interface ClassifierMetricsIo {
  load(path: string): ClassifierMetricsState | undefined;
  save(path: string, state: ClassifierMetricsState): void;
}

const DEFAULT_IO: ClassifierMetricsIo = {
  load: (path) => readJsonFile<ClassifierMetricsState>(path),
  save: writeJsonFile,
};

export interface ClassifierMetricsStoreOptions {
  readonly cwd: string;
  readonly path?: string;
  readonly enabled?: boolean;
  readonly io?: ClassifierMetricsIo;
  readonly now?: () => number;
}

function emptyState(): ClassifierMetricsState {
  return {
    version: 1,
    model: "jev-1.13.0",
    total: 0,
    outcomes: {},
    tiers: {},
    confidenceBands: {},
    latencyBuckets: {},
    totalLatencyMs: 0,
    totalAttempts: 0,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key.length <= 100 && count(item) > 0)
      .map(([key, item]) => [key, count(item)]),
  );
}

function normalizeState(value: ClassifierMetricsState | undefined): ClassifierMetricsState {
  if (!value || value.version !== 1 || value.model !== "jev-1.13.0") return emptyState();
  return {
    version: 1,
    model: "jev-1.13.0",
    total: count(value.total),
    outcomes: counts(value.outcomes),
    tiers: counts(value.tiers),
    confidenceBands: counts(value.confidenceBands),
    latencyBuckets: counts(value.latencyBuckets),
    totalLatencyMs: count(value.totalLatencyMs),
    totalAttempts: count(value.totalAttempts),
    lastObservedAt: count(value.lastObservedAt) || undefined,
  };
}

export class ClassifierMetricsStore {
  private state = emptyState();
  private enabled = true;
  private path = "";
  private readonly io: ClassifierMetricsIo;
  private readonly now: () => number;

  constructor(options: ClassifierMetricsStoreOptions) {
    this.io = options.io ?? DEFAULT_IO;
    this.now = options.now ?? Date.now;
    this.reload(options);
  }

  reload(options: Pick<ClassifierMetricsStoreOptions, "cwd" | "path" | "enabled">): void {
    this.enabled = options.enabled ?? true;
    this.path = resolveStoragePath(options.cwd, options.path, ".pi/bifrost-classifier-metrics.json");
    if (!this.enabled) {
      this.state = emptyState();
      return;
    }
    try {
      this.state = normalizeState(this.io.load(this.path));
    } catch (error) {
      console.error(`[bifrost] failed to load classifier metrics: ${error}`);
      this.state = emptyState();
    }
  }

  record(observation: TypeSafeObservation): void {
    if (!this.enabled) return;
    const outcome = observation.outcome;
    const outcomes = { ...this.state.outcomes, [outcome]: (this.state.outcomes[outcome] ?? 0) + 1 };
    const tiers = observation.tier
      ? { ...this.state.tiers, [observation.tier]: (this.state.tiers[observation.tier] ?? 0) + 1 }
      : this.state.tiers;
    const confidenceBand = observation.confidence === undefined
      ? undefined
      : observation.confidence >= 0.9 ? "0.9-1.0" : observation.confidence >= 0.8 ? "0.8-0.9" : "<0.8";
    const confidenceBands = confidenceBand
      ? { ...this.state.confidenceBands, [confidenceBand]: (this.state.confidenceBands[confidenceBand] ?? 0) + 1 }
      : this.state.confidenceBands;
    const latency = Math.max(0, Math.round(observation.latencyMs));
    const latencyBucket = latency <= 250 ? "<=250ms"
      : latency <= 500 ? "<=500ms"
      : latency <= 1000 ? "<=1000ms"
      : latency <= 3000 ? "<=3000ms"
      : latency <= 10000 ? "<=10000ms"
      : ">10000ms";
    const latencyBuckets = { ...this.state.latencyBuckets, [latencyBucket]: (this.state.latencyBuckets[latencyBucket] ?? 0) + 1 };
    this.state = {
      version: 1,
      model: "jev-1.13.0",
      total: this.state.total + 1,
      outcomes,
      tiers,
      confidenceBands,
      latencyBuckets,
      totalLatencyMs: this.state.totalLatencyMs + latency,
      totalAttempts: this.state.totalAttempts + Math.max(0, Math.floor(observation.attempts)),
      lastObservedAt: this.now(),
    };
    try {
      this.io.save(this.path, this.state);
    } catch (error) {
      console.error(`[bifrost] failed to save classifier metrics: ${error}`);
    }
  }

  snapshot(): Readonly<ClassifierMetricsState> {
    return this.state;
  }
}
