/** Read-only, content-free projection for experimental reliability inspection. */

import {
  validateReliabilityV2State,
  type ReliabilityV2ObservationSummary,
} from "./reliability-v2.ts";

export interface ReliabilityV2ObservationProjection extends ReliabilityV2ObservationSummary {}

type DataRecord = Record<string, unknown>;

function plainRecord(value: unknown): DataRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as DataRecord : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(record: DataRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

/** Returns the newest still-retained summary per model, without receipt or owner IDs. */
export function projectReliabilityV2Observations(
  stateValue: unknown,
  configValue: unknown,
  now: unknown,
): readonly ReliabilityV2ObservationProjection[] | undefined {
  if (!timestamp(now) || !validateReliabilityV2State(stateValue, configValue)) return undefined;
  const state = stateValue;
  const outcomes = plainRecord(state.settledOutcomes);
  if (!outcomes) return undefined;
  const latest = new Map<string, ReliabilityV2ObservationProjection>();
  for (const id of Object.keys(outcomes)) {
    const outcome = plainRecord(ownValue(outcomes, id));
    if (!outcome) return undefined;
    const expiresAt = ownValue(outcome, "expiresAt");
    const raw = plainRecord(ownValue(outcome, "observation"));
    if (!raw || !timestamp(expiresAt) || expiresAt < now) continue;
    const modelKey = ownValue(raw, "modelKey");
    const observedAt = ownValue(raw, "observedAt");
    if (typeof modelKey !== "string" || !timestamp(observedAt)) return undefined;
    if (observedAt > now) continue;
    const previous = latest.get(modelKey);
    if (previous && previous.observedAt >= observedAt) continue;
    const summary: ReliabilityV2ObservationProjection = Object.freeze({
      modelKey,
      category: ownValue(raw, "category") as ReliabilityV2ObservationProjection["category"],
      categoryEvidence: ownValue(raw, "categoryEvidence") as ReliabilityV2ObservationProjection["categoryEvidence"],
      observedAt,
      ...(ownValue(raw, "retryAt") === undefined ? {} : { retryAt: ownValue(raw, "retryAt") as number }),
      source: ownValue(raw, "source") as ReliabilityV2ObservationProjection["source"],
    });
    latest.set(modelKey, summary);
  }
  return Object.freeze([...latest.values()].sort((left, right) => left.modelKey.localeCompare(right.modelKey)));
}
