import { dirname } from "node:path";
import {
  getCircuitState,
  recordModelFailure,
  recordModelSuccess,
  beginTrial,
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
    this.stateValue = opts.initialState
      ? this.pruneStaleTrials(opts.initialState)
      : this.io.load(this.pathValue);
  }

  get path(): string { return this.pathValue; }

  /** Read-only view for routing/UI. Do not mutate. */
  getState(): Readonly<ReliabilityState> { return this.stateValue; }

  getCircuitState(model: string, now?: number): CircuitState {
    return getCircuitState(this.stateValue, model, now ?? this.nowFn(), this.configValue);
  }

  isModelHealthy(model: string, now?: number): boolean {
    return !this.getCircuitState(model, now).open;
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
    this.stateValue = beginTrial(this.stateValue, model);
    this.persist();
  }

  applyOutcomes(outcomes: readonly ReliabilityOutcome[], now?: number): void {
    const t = now ?? this.nowFn();
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
    else this.pathValue = reliabilityPath(dirname(this.pathValue), this.configValue?.path);
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
