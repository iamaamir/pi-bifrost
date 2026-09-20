import {
  getCircuitState,
  recordModelFailure,
  recordModelSuccess,
  beginTrial,
  abandonTrial,
  loadReliability,
  saveReliability,
  reliabilityPath,
  type CircuitState,
  type ReliabilityConfig,
  type ReliabilityRecord,
  type ReliabilityState,
} from "./reliability.ts";

// ── Types ────────────────────────────────────────────────────

export type ReliabilitySource = "probe" | "setModel" | "agent_settled" | "trial" | (string & {});

export type ReliabilityOutcome =
  | { model: string; ok: true; source: ReliabilitySource }
  | { model: string; ok: false; source: ReliabilitySource; reason: string };

export interface ReliabilityIo {
  load(path: string): ReliabilityState;
  save(path: string, state: ReliabilityState): void;
}

const DEFAULT_IO: ReliabilityIo = {
  load: loadReliability,
  save: saveReliability,
};

export interface ReliabilityStoreOptions {
  cwd: string;
  config?: ReliabilityConfig;
  io?: ReliabilityIo;
  now?: () => number;
  initialState?: ReliabilityState;
}

// ── Store ────────────────────────────────────────────────────

export class ReliabilityStore {
  private stateValue: ReliabilityState;
  private pathValue: string;
  private configValue: ReliabilityConfig | undefined;
  private io: ReliabilityIo;
  private nowFn: () => number;

  constructor(opts: ReliabilityStoreOptions) {
    this.io = opts.io ?? DEFAULT_IO;
    this.nowFn = opts.now ?? Date.now;
    this.configValue = opts.config;
    this.pathValue = reliabilityPath(opts.cwd, opts.config?.path);
    this.stateValue = this.pruneStaleTrials(
      opts.initialState ?? this.io.load(this.pathValue),
    );
  }

  get path(): string { return this.pathValue; }

  /** Read-only view for routing/UI. Do not mutate. */
  getState(): Readonly<ReliabilityState> { return this.stateValue; }

  getCircuitState(model: string, now?: number): CircuitState {
    return getCircuitState(this.stateValue, model, now ?? this.nowFn(), this.configValue);
  }

  isModelHealthy(model: string, now?: number): boolean {
    const circuit = this.getCircuitState(model, now);
    return !circuit.open && !circuit.trialActive;
  }

  openCircuitCount(now?: number): number {
    if (this.configValue?.enabled === false) return 0;
    const t = now ?? this.nowFn();
    return Object.keys(this.stateValue.models).filter((key) =>
      getCircuitState(this.stateValue, key, t, this.configValue).open
    ).length;
  }

  // ── Intent-only writes (config read from store internally) ──

  recordFailure(model: string, source: ReliabilitySource, reason: string, now?: number): void {
    if (this.configValue?.enabled === false) return;
    this.stateValue = recordModelFailure(this.stateValue, model, this.configValue, now ?? this.nowFn(), source, reason);
    this.persist();
  }

  recordSuccess(model: string, source: ReliabilitySource, now?: number): void {
    if (this.configValue?.enabled === false) return;
    this.stateValue = recordModelSuccess(this.stateValue, model, now ?? this.nowFn(), source);
    this.persist();
  }

  /** Policy A: success only when trial was active; failure always. */
  recordSettled(model: string, reason?: string, now?: number): void {
    if (reason) {
      this.recordFailure(model, "agent_settled", reason, now);
    } else if (this.getCircuitState(model, now).trialActive) {
      this.recordSuccess(model, "agent_settled", now);
    }
  }

  beginTrial(model: string): void {
    if (this.configValue?.enabled === false) return;
    const next = beginTrial(this.stateValue, model);
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.persist();
  }

  abandonTrial(model: string): void {
    if (this.configValue?.enabled === false) return;
    const next = abandonTrial(this.stateValue, model);
    if (next === this.stateValue) return;
    this.stateValue = next;
    this.persist();
  }

  /** Claim result distinguishes a newly owned half-open trial from a healthy target. */
  tryClaimTrial(model: string, now?: number): { allowed: boolean; claimed: boolean } {
    if (this.configValue?.enabled === false) return { allowed: true, claimed: false };
    const circuit = this.getCircuitState(model, now);
    if (circuit.open || circuit.trialActive) return { allowed: false, claimed: false };
    if (!circuit.halfOpen) return { allowed: true, claimed: false };
    this.beginTrial(model);
    return { allowed: true, claimed: true };
  }

  /** Synchronously claim the single half-open trial for this store instance. */
  tryBeginTrial(model: string, now?: number): boolean {
    return this.tryClaimTrial(model, now).allowed;
  }

  applyOutcomes(outcomes: readonly ReliabilityOutcome[], now?: number): void {
    const t = now ?? this.nowFn();
    // Track whether any outcome actually changed state to avoid a no-op persist.
    // recordModelSuccess/Failure always spreads new state when enabled, so the
    // changed flag mainly short-circuits the disabled case.
    let changed = false;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        if (this.configValue?.enabled === false) continue;
        const next = recordModelSuccess(this.stateValue, outcome.model, t, outcome.source);
        if (next !== this.stateValue) { this.stateValue = next; changed = true; }
      } else {
        const next = recordModelFailure(this.stateValue, outcome.model, this.configValue, t, outcome.source, outcome.reason);
        if (next !== this.stateValue) { this.stateValue = next; changed = true; }
      }
    }
    if (changed) this.persist();
  }

  // ── Config lifecycle ─────────────────────────────────────────

  updateConfig(config: ReliabilityConfig | undefined): void {
    this.configValue = config;
  }

  reload(config?: ReliabilityConfig, cwd?: string): void {
    if (config !== undefined) this.configValue = config;
    if (cwd !== undefined) this.pathValue = reliabilityPath(cwd, this.configValue?.path);
    this.stateValue = this.pruneStaleTrials(this.io.load(this.pathValue));
  }

  // ── Private ─────────────────────────────────────────────────

  private persist(): void {
    this.io.save(this.pathValue, this.stateValue);
  }

  private pruneStaleTrials(state: ReliabilityState): ReliabilityState {
    const now = this.nowFn();
    let changed = false;
    const models: Record<string, ReliabilityRecord> = { ...state.models };
    for (const [key, record] of Object.entries(models)) {
      if (record.trialActive && record.openUntil !== undefined && record.openUntil <= now) {
        models[key] = { ...record, trialActive: false };
        changed = true;
      }
    }
    return changed ? { ...state, models } : state;
  }
}
