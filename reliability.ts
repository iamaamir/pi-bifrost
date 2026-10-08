import { resolveStoragePath, readJsonFile, writeJsonFile } from "./storage.ts";
import { acquireReliabilitySourceFenceSync, releaseReliabilitySourceFence, reliabilitySourceFenceOwned, ReliabilitySourceFenceError } from "./reliability-v1-fence.ts";
import { isNormalizedFailureObservation, type FailureObservation } from "./failure-observations.ts";

export interface ReliabilityConfig {
  enabled?: boolean;
  /** Explicitly opt into the experimental receipt-owned runtime (requires schemaVersion 2). */
  stateVersion?: 1 | 2;
  /** Store only allowlisted failure categories in reliability v2. Disabled by default. */
  observations?: { enabled?: boolean };
  /** Open a model-only cooldown immediately for a normalized allowance-exhaustion failure. */
  cooldownOnAllowanceExhausted?: boolean;
  /** Retry one proven side-effect-free Auto generation on a different configured model after allowance exhaustion. */
  retryOnAllowanceExhausted?: boolean;
  failureThreshold?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
  path?: string;
}

export interface ReliabilityRecord {
  failures: number[];
  openUntil?: number;
  trialActive?: boolean;
  cooldownMultiplier?: number;
  lastFailureAt?: number;
  lastFailureSource?: string;
  lastFailureReason?: string;
  lastSuccessAt?: number;
  lastSuccessSource?: string;
}

export interface ReliabilityState {
  version: 1;
  models: Record<string, ReliabilityRecord>;
}

export interface CircuitState {
  open: boolean;
  halfOpen: boolean;
  trialActive: boolean;
  openUntil?: number;
  recentFailures: number;
}

export const DEFAULT_RELIABILITY: Required<Omit<ReliabilityConfig, "path" | "stateVersion" | "observations">> = {
  enabled: true,
  cooldownOnAllowanceExhausted: true,
  retryOnAllowanceExhausted: true,
  failureThreshold: 3,
  windowMinutes: 5,
  cooldownMinutes: 60,
};

export function resolveReliabilityConfig(config?: ReliabilityConfig): Required<Omit<ReliabilityConfig, "path" | "stateVersion" | "observations">> & Pick<ReliabilityConfig, "path"> {
  return {
    enabled: config?.enabled ?? DEFAULT_RELIABILITY.enabled,
    cooldownOnAllowanceExhausted: config?.cooldownOnAllowanceExhausted ?? DEFAULT_RELIABILITY.cooldownOnAllowanceExhausted,
    retryOnAllowanceExhausted: config?.retryOnAllowanceExhausted ?? DEFAULT_RELIABILITY.retryOnAllowanceExhausted,
    failureThreshold: config?.failureThreshold ?? DEFAULT_RELIABILITY.failureThreshold,
    windowMinutes: config?.windowMinutes ?? DEFAULT_RELIABILITY.windowMinutes,
    cooldownMinutes: config?.cooldownMinutes ?? DEFAULT_RELIABILITY.cooldownMinutes,
    path: config?.path,
  };
}

/** Exact persisted, content-free marker for a still-active runtime allowance cooldown. */
export function hasActiveAllowanceCooldown(state: ReliabilityState, model: string, now: number): boolean {
  const record = state.models[model];
  return !!record
    && typeof record.openUntil === "number" && Number.isFinite(record.openUntil) && record.openUntil > now
    && (record.lastFailureReason === "allowance_exhausted:structured:model-only"
      || record.lastFailureReason === "allowance_exhausted:text_heuristic:model-only");
}

export function emptyReliabilityState(): ReliabilityState {
  return { version: 1, models: {} };
}

function pruneFailures(failures: unknown, now: number, windowMinutes: number): number[] {
  if (!Array.isArray(failures)) return [];
  const cutoff = now - windowMinutes * 60_000;
  return failures.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts) && ts >= cutoff);
}

function normalizeRecord(raw: unknown): ReliabilityRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const failures = pruneFailures(record.failures, Date.now(), Number.MAX_SAFE_INTEGER);
  const openUntil = typeof record.openUntil === "number" && Number.isFinite(record.openUntil)
    ? record.openUntil
    : undefined;
  const lastFailureAt = typeof record.lastFailureAt === "number" && Number.isFinite(record.lastFailureAt)
    ? record.lastFailureAt
    : undefined;
  const lastSuccessAt = typeof record.lastSuccessAt === "number" && Number.isFinite(record.lastSuccessAt)
    ? record.lastSuccessAt
    : undefined;

  return {
    failures,
    openUntil,
    trialActive: typeof record.trialActive === "boolean" ? record.trialActive : undefined,
    cooldownMultiplier: typeof record.cooldownMultiplier === "number" && Number.isFinite(record.cooldownMultiplier) && record.cooldownMultiplier > 0 ? record.cooldownMultiplier : undefined,
    lastFailureAt,
    lastFailureSource: typeof record.lastFailureSource === "string" ? record.lastFailureSource : undefined,
    lastFailureReason: typeof record.lastFailureReason === "string" ? record.lastFailureReason : undefined,
    lastSuccessAt,
    lastSuccessSource: typeof record.lastSuccessSource === "string" ? record.lastSuccessSource : undefined,
  };
}

export function getCircuitState(
  state: ReliabilityState,
  model: string,
  now: number,
  config: ReliabilityConfig | undefined,
): CircuitState {
  const resolved = resolveReliabilityConfig(config);
  const record = state.models[model];
  const failures = pruneFailures(record?.failures ?? [], now, resolved.windowMinutes);
  const openUntil = record?.openUntil;
  return {
    open: !!openUntil && openUntil > now,
    halfOpen: !!openUntil && openUntil <= now && !record?.trialActive,
    trialActive: !!record?.trialActive,
    openUntil,
    recentFailures: failures.length,
  };
}

export function recordModelFailure(
  state: ReliabilityState,
  model: string,
  config: ReliabilityConfig | undefined,
  now: number,
  source: string,
  reason: string,
  observation?: FailureObservation,
): ReliabilityState {
  const resolved = resolveReliabilityConfig(config);
  if (!resolved.enabled) return state;

  const current = state.models[model] ?? { failures: [] };
  const normalizedObservation = observation && isNormalizedFailureObservation(observation, { now })
    ? observation : undefined;
  const boundAllowanceObservation = normalizedObservation
    && normalizedObservation.category === "allowance_exhausted"
    && normalizedObservation.source === "runtime"
    && normalizedObservation.modelKey === model
    && normalizedObservation.scope.kind === "model"
    && normalizedObservation.scope.modelKey === model
    ? normalizedObservation : undefined;
  const wasTrial = current.trialActive;
  const multiplier = wasTrial ? (current.cooldownMultiplier ?? 1) * 2 : (current.cooldownMultiplier ?? 1);
  const cooldownMs = resolved.cooldownMinutes * 60_000 * multiplier;
  const failures = [...pruneFailures(current.failures, now, resolved.windowMinutes), now];
  const preserveActiveAllowanceMarker = !boundAllowanceObservation
    && hasActiveAllowanceCooldown(state, model, now);
  const allowanceCooldownUntil = boundAllowanceObservation && resolved.cooldownOnAllowanceExhausted
    ? Math.max(current.openUntil ?? 0, now + cooldownMs, trustedAllowanceRetryAt(boundAllowanceObservation, now) ?? 0)
    : undefined;
  const openUntil = allowanceCooldownUntil !== undefined
    ? allowanceCooldownUntil
    : wasTrial || failures.length >= resolved.failureThreshold
      ? preserveActiveAllowanceMarker ? Math.max(current.openUntil ?? 0, now + cooldownMs) : now + cooldownMs
      : current.openUntil;
  const storedReason = boundAllowanceObservation
    ? `allowance_exhausted:${boundAllowanceObservation.categoryEvidence}:model-only`
    : preserveActiveAllowanceMarker ? current.lastFailureReason! : reason;

  return {
    ...state,
    models: {
      ...state.models,
      [model]: {
        ...current,
        failures,
        openUntil,
        trialActive: false,
        cooldownMultiplier: wasTrial ? multiplier : current.cooldownMultiplier,
        lastFailureAt: now,
        lastFailureSource: source,
        lastFailureReason: storedReason,
      },
    },
  };
}

const MAX_ALLOWANCE_RETRY_HINT_MS = 24 * 60 * 60 * 1000;

function trustedAllowanceRetryAt(observation: FailureObservation, now: number): number | undefined {
  const retryAt = observation.retryAt;
  if (retryAt === undefined || !Number.isSafeInteger(retryAt) || retryAt <= now
    || retryAt - now > MAX_ALLOWANCE_RETRY_HINT_MS) return undefined;
  return retryAt;
}

export function recordModelSuccess(
  state: ReliabilityState,
  model: string,
  now: number,
  source: string,
): ReliabilityState {
  const current = state.models[model];
  if (!current) {
    return {
      ...state,
      models: {
        ...state.models,
        [model]: {
          failures: [],
          lastSuccessAt: now,
          lastSuccessSource: source,
        },
      },
    };
  }

  return {
    ...state,
    models: {
      ...state.models,
      [model]: {
        ...current,
        failures: [],
        openUntil: undefined,
        trialActive: false,
        cooldownMultiplier: undefined,
        lastSuccessAt: now,
        lastSuccessSource: source,
      },
    },
  };
}

export function beginTrial(
  state: ReliabilityState,
  model: string,
): ReliabilityState {
  const current = state.models[model];
  if (!current || current.trialActive) return state;
  return {
    ...state,
    models: {
      ...state.models,
      [model]: {
        ...current,
        trialActive: true,
      },
    },
  };
}

/** Release a half-open trial without treating cancellation as success or failure. */
export function abandonTrial(
  state: ReliabilityState,
  model: string,
): ReliabilityState {
  const current = state.models[model];
  if (!current?.trialActive) return state;
  return {
    ...state,
    models: {
      ...state.models,
      [model]: {
        ...current,
        trialActive: false,
      },
    },
  };
}

export function recordSetModelOutcome(
  state: ReliabilityState,
  modelKey: string,
  config: ReliabilityConfig | undefined,
  now: number,
  ok: boolean,
  reason: string,
): ReliabilityState {
  if (ok) return state;
  return recordModelFailure(state, modelKey, config, now, "setModel", reason);
}

export function reliabilityPath(cwd: string, configuredPath?: string): string {
  return resolveStoragePath(cwd, configuredPath, ".pi/bifrost-reliability.json");
}

export function loadReliability(path: string): ReliabilityState {
  try {
    const parsed = readJsonFile<Partial<ReliabilityState>>(path);
    if (parsed?.version !== 1 || typeof parsed.models !== "object" || !parsed.models) {
      return emptyReliabilityState();
    }
    const models: Record<string, ReliabilityRecord> = {};
    for (const [key, raw] of Object.entries(parsed.models)) {
      const normalized = normalizeRecord(raw);
      if (normalized) models[key] = normalized;
    }
    return { version: 1, models };
  } catch (err) {
    console.error(`[bifrost] failed to load reliability state: ${err}`);
    return emptyReliabilityState();
  }
}

export function saveReliability(path: string, state: ReliabilityState): boolean {
  let owner: ReturnType<typeof acquireReliabilitySourceFenceSync> | undefined;
  try {
    owner = acquireReliabilitySourceFenceSync(path);
    if (!reliabilitySourceFenceOwned(owner)) {
      console.error("[bifrost] reliability source lock ownership changed before save; no state was written, and the lock was left untouched.");
      return false;
    }
    writeJsonFile(path, state);
    return true;
  } catch (error) {
    console.error(error instanceof ReliabilitySourceFenceError && error.code === "contended"
      ? "[bifrost] reliability state write skipped because a source lock exists. Stop other writers; if the lock remains, follow the reliability lock recovery guide. Do not remove it based only on age or PID."
      : "[bifrost] reliability state could not be saved; check the state file and retry.");
    return false;
  } finally {
    if (owner) {
      try { releaseReliabilitySourceFence(owner); }
      catch { console.error("[bifrost] reliability source lock ownership changed; the lock was left untouched."); }
    }
  }
}
