import {
  emptyReliabilityV2State,
  modelScopeKey,
  validateReliabilityV2State,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "./reliability-v2.ts";

const MAX_V1_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_V1_MODEL_RECORDS = 10_000;
const MAX_V1_FAILURES_PER_MODEL = 100_000;
const MAX_TIMESTAMP = 8.64e15;

type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): PlainRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as PlainRecord : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactKeys(record: PlainRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => allowed.has(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return !!descriptor && "value" in descriptor;
    });
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function decodeSnapshot(snapshot: Uint8Array): unknown {
  if (!(snapshot instanceof Uint8Array) || snapshot.byteLength > MAX_V1_SNAPSHOT_BYTES) {
    throw new Error("Reliability v1 migration snapshot is invalid or too large.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Reliability v1 migration snapshot is not valid UTF-8 JSON.");
  }
}

/** Strict, pure v1-to-v2 conversion. Raw reasons and sources are validated then discarded. */
export function convertReliabilityV1Snapshot(snapshot: Uint8Array, config: ReliabilityV2Config): ReliabilityV2State {
  const parsed = decodeSnapshot(snapshot);
  const root = plainRecord(parsed);
  if (!root || !exactKeys(root, ["version", "models"]) || ownValue(root, "version") !== 1) {
    throw new Error("Reliability v1 migration snapshot has an unsupported shape.");
  }
  const models = plainRecord(ownValue(root, "models"));
  if (!models) throw new Error("Reliability v1 migration model map is invalid.");
  const modelKeys = Object.keys(models);
  if (modelKeys.length > MAX_V1_MODEL_RECORDS) throw new Error("Reliability v1 migration snapshot has too many models.");

  const state = emptyReliabilityV2State();
  for (const model of modelKeys) {
    try {
      modelScopeKey(model);
    } catch {
      throw new Error("Reliability v1 migration snapshot contains an invalid model key.");
    }
    const raw = plainRecord(ownValue(models, model));
    if (!raw || !exactKeys(raw, ["failures"], [
      "openUntil", "trialActive", "cooldownMultiplier", "lastFailureAt", "lastFailureSource",
      "lastFailureReason", "lastSuccessAt", "lastSuccessSource",
    ])) throw new Error("Reliability v1 migration record has an invalid shape.");

    const failures = ownValue(raw, "failures");
    if (!Array.isArray(failures) || Object.getPrototypeOf(failures) !== Array.prototype
      || failures.length > MAX_V1_FAILURES_PER_MODEL
      || !failures.every((time) => safeTimestamp(time))) {
      throw new Error("Reliability v1 migration record has invalid failure timestamps.");
    }
    for (const field of ["openUntil", "lastFailureAt", "lastSuccessAt"] as const) {
      const value = ownValue(raw, field);
      if (value !== undefined && !safeTimestamp(value)) throw new Error("Reliability v1 migration record has an invalid timestamp.");
    }
    const trialActive = ownValue(raw, "trialActive");
    if (trialActive !== undefined && typeof trialActive !== "boolean") throw new Error("Reliability v1 migration record has an invalid trial flag.");
    const multiplier = ownValue(raw, "cooldownMultiplier");
    if (multiplier !== undefined && (typeof multiplier !== "number" || !Number.isSafeInteger(multiplier) || multiplier < 1 || multiplier > 1_000_000)) {
      throw new Error("Reliability v1 migration record has an invalid cooldown multiplier.");
    }
    for (const field of ["lastFailureSource", "lastFailureReason", "lastSuccessSource"] as const) {
      const value = ownValue(raw, field);
      if (value !== undefined && typeof value !== "string") throw new Error("Reliability v1 migration record has an invalid text field.");
    }

    const scopeKey = modelScopeKey(model);
    state.scopes[scopeKey] = {
      generation: 0,
      failures: [...(failures as number[])].sort((left, right) => left - right).slice(-config.failureThreshold),
      ...(ownValue(raw, "openUntil") !== undefined ? { openUntil: ownValue(raw, "openUntil") as number } : {}),
      ...(multiplier !== undefined ? { cooldownMultiplier: multiplier as number } : {}),
    };
  }
  if (!validateReliabilityV2State(state, config)) throw new Error("Reliability v1 migration produced invalid v2 state.");
  return state;
}
