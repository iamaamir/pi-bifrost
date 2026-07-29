import { resolveStoragePath, readJsonFile, writeJsonFile } from "./storage.ts";

export interface ReliabilityConfig {
  enabled?: boolean;
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

export const DEFAULT_RELIABILITY: Required<Omit<ReliabilityConfig, "path">> = {
  enabled: true,
  failureThreshold: 3,
  windowMinutes: 5,
  cooldownMinutes: 60,
};

export function resolveReliabilityConfig(config?: ReliabilityConfig): Required<Omit<ReliabilityConfig, "path">> & Pick<ReliabilityConfig, "path"> {
  return {
    enabled: config?.enabled ?? DEFAULT_RELIABILITY.enabled,
    failureThreshold: config?.failureThreshold ?? DEFAULT_RELIABILITY.failureThreshold,
    windowMinutes: config?.windowMinutes ?? DEFAULT_RELIABILITY.windowMinutes,
    cooldownMinutes: config?.cooldownMinutes ?? DEFAULT_RELIABILITY.cooldownMinutes,
    path: config?.path,
  };
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
): ReliabilityState {
  const resolved = resolveReliabilityConfig(config);
  if (!resolved.enabled) return state;

  const current = state.models[model] ?? { failures: [] };
  const wasTrial = current.trialActive;
  const multiplier = wasTrial ? (current.cooldownMultiplier ?? 1) * 2 : (current.cooldownMultiplier ?? 1);
  const cooldownMs = resolved.cooldownMinutes * 60_000 * multiplier;
  const failures = [...pruneFailures(current.failures, now, resolved.windowMinutes), now];
  const openUntil = failures.length >= resolved.failureThreshold ? now + cooldownMs : current.openUntil;

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
        lastFailureReason: reason,
      },
    },
  };
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
  if (!current) return state;
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

export function saveReliability(path: string, state: ReliabilityState): void {
  try {
    writeJsonFile(path, state);
  } catch (err) {
    console.error(`[bifrost] failed to save reliability state: ${err}`);
  }
}
