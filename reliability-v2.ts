/** Pure experimental reliability transitions. No filesystem or Pi runtime wiring. */

import { isNormalizedFailureObservation, type CategoryEvidence, type FailureCategory, type FailureObservation, type FailureSource } from "./failure-observations.ts";

export interface ReliabilityV2Config {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  leaseTtlMs: number;
  maxDispatchLifetimeMs: number;
  dedupRetentionMs: number;
  maxDedupEntries: number;
  maxDispatchReceipts: number;
}

export interface ReliabilityV2Lease {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  leaseId: string;
  generation: number;
  expiresAt: number;
  maxExpiresAt: number;
}

export interface ReliabilityV2Scope {
  generation: number;
  failures: number[];
  openUntil?: number;
  cooldownMultiplier?: number;
  lease?: ReliabilityV2Lease;
}

export interface ReliabilityV2ScopeReceipt {
  scopeKey: string;
  modelKey: string;
  generation: number;
  leaseId?: string;
  expiresAt?: number;
  maxExpiresAt?: number;
}

export interface ReliabilityV2DispatchReceipt {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  admittedAt: number;
  proofUntil: number;
  scopes: ReliabilityV2ScopeReceipt[];
  settledAt?: number;
  settledKind?: "success" | "failure" | "cancelled";
}

export interface ReliabilityV2State {
  version: 2;
  revision: number;
  scopes: Record<string, ReliabilityV2Scope>;
  dispatches: Record<string, ReliabilityV2DispatchReceipt>;
  settledOutcomes: Record<string, { expiresAt: number; observation?: ReliabilityV2ObservationSummary }>;
}

/** Content-free failure facts retained only for the existing dedup lifetime. */
export interface ReliabilityV2ObservationSummary {
  modelKey: string;
  category: FailureCategory;
  categoryEvidence: CategoryEvidence;
  observedAt: number;
  retryAt?: number;
  source: FailureSource;
}

export interface ReliabilityV2LeaseReference {
  scopeKey: string;
  generation: number;
  leaseId: string;
  expiresAt: number;
  maxExpiresAt: number;
}

export type ReliabilityV2ResultStatus =
  | "admitted"
  | "blocked"
  | "renewed"
  | "settled"
  | "abandoned"
  | "duplicate"
  | "stale"
  | "expired"
  | "capacity"
  | "invalid"
  | "overflow";

export interface ReliabilityV2Result {
  status: ReliabilityV2ResultStatus;
  reason?: string;
  state: ReliabilityV2State;
  leases?: ReliabilityV2LeaseReference[];
}

export interface ReliabilityV2Admission {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  modelKeys: readonly string[];
  now: number;
}

export interface ReliabilityV2LeaseOperation {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  leaseReferences: readonly ReliabilityV2LeaseReference[];
  now: number;
  ttlMs?: number;
}

export type ReliabilityV2Settlement =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "failure"; observation?: FailureObservation };

export interface ReliabilityV2SettleRequest {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  settlement: ReliabilityV2Settlement;
  now: number;
}

const MAX_TIMESTAMP = 8.64e15;
const MAX_FAILURE_TIMESTAMPS = 10_000;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*\/[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

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

function mapValue<T>(map: Record<string, T>, key: string): T | undefined {
  const record = plainRecord(map);
  return record ? ownValue(record, key) as T | undefined : undefined;
}

function ownKeys(record: DataRecord): string[] | undefined {
  try {
    return Object.keys(record);
  } catch {
    return undefined;
  }
}

function exactKeys(record: DataRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = ownKeys(record);
  if (!keys || required.some((key) => !keys.includes(key))) return false;
  const permitted = new Set([...required, ...optional]);
  return keys.every((key) => permitted.has(key))
    && [...required, ...optional].every((key) => !keys.includes(key) || ownValue(record, key) !== undefined);
}

function safeArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !safeInteger(lengthDescriptor.value)) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function timestamp(value: unknown): value is number {
  return safeInteger(value) && value <= MAX_TIMESTAMP;
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function modelKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && MODEL_KEY.test(value);
}

function normalizeObservationFields(value: unknown, now: number): FailureObservation | undefined {
  return isNormalizedFailureObservation(value, { now }) ? value : undefined;
}

function validObservationSummary(value: unknown, outcomeId: string, now: number): value is ReliabilityV2ObservationSummary {
  const summary = plainRecord(value);
  if (!summary || !hasOnlyKeys(summary,
    ["modelKey", "category", "categoryEvidence", "observedAt", "source"], ["retryAt"])) return false;
  const dto: DataRecord = {
    outcomeId,
    modelKey: ownValue(summary, "modelKey"),
    category: ownValue(summary, "category"),
    categoryEvidence: ownValue(summary, "categoryEvidence"),
    scope: { kind: "model", modelKey: ownValue(summary, "modelKey") },
    scopeEvidence: "model-only",
    observedAt: ownValue(summary, "observedAt"),
    source: ownValue(summary, "source"),
  };
  const retryAt = ownValue(summary, "retryAt");
  if (retryAt !== undefined) dto.retryAt = retryAt;
  return !!normalizeObservationFields(dto, now);
}

function sameObservationSummary(
  left: ReliabilityV2ObservationSummary | undefined,
  right: ReliabilityV2ObservationSummary | undefined,
): boolean {
  return left === undefined ? right === undefined
    : right !== undefined
      && left.modelKey === right.modelKey
      && left.category === right.category
      && left.categoryEvidence === right.categoryEvidence
      && left.observedAt === right.observedAt
      && left.retryAt === right.retryAt
      && left.source === right.source;
}

function hasOnlyKeys(record: DataRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  return exactKeys(record, required, optional);
}

function isConfig(value: unknown): value is ReliabilityV2Config {
  const config = plainRecord(value);
  if (!config || !hasOnlyKeys(config, [
    "failureThreshold", "windowMs", "cooldownMs", "leaseTtlMs",
    "maxDispatchLifetimeMs", "dedupRetentionMs",
    "maxDedupEntries", "maxDispatchReceipts",
  ])) return false;
  const threshold = ownValue(config, "failureThreshold");
  const window = ownValue(config, "windowMs");
  const cooldown = ownValue(config, "cooldownMs");
  const leaseTtl = ownValue(config, "leaseTtlMs");
  const lifetime = ownValue(config, "maxDispatchLifetimeMs");
  const retention = ownValue(config, "dedupRetentionMs");
  const dedupCapacity = ownValue(config, "maxDedupEntries");
  const receiptCapacity = ownValue(config, "maxDispatchReceipts");
  return safeInteger(threshold, 1) && threshold <= MAX_FAILURE_TIMESTAMPS
    && safeInteger(window, 1) && window <= MAX_TIMESTAMP
    && safeInteger(cooldown, 1) && cooldown <= MAX_TIMESTAMP
    && safeInteger(leaseTtl, 1) && leaseTtl <= MAX_TIMESTAMP
    && safeInteger(lifetime, leaseTtl) && lifetime <= MAX_TIMESTAMP
    && safeInteger(retention, lifetime) && retention <= MAX_TIMESTAMP
    && safeInteger(dedupCapacity, 1) && dedupCapacity <= 1_000_000
    && safeInteger(receiptCapacity, 1) && receiptCapacity <= 1_000_000;
}

function nullMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyReliabilityV2State(): ReliabilityV2State {
  return {
    version: 2,
    revision: 0,
    scopes: nullMap<ReliabilityV2Scope>(),
    dispatches: nullMap<ReliabilityV2DispatchReceipt>(),
    settledOutcomes: nullMap<{ expiresAt: number; observation?: ReliabilityV2ObservationSummary }>(),
  };
}

export function modelScopeKey(key: string): string {
  if (!modelKey(key)) throw new Error("Invalid model key");
  return `model:${key.length}:${key}`;
}

function validLease(value: unknown): value is ReliabilityV2Lease {
  const lease = plainRecord(value);
  if (!lease || !hasOnlyKeys(lease, [
    "ownerToken", "dispatchId", "outcomeId", "leaseId", "generation", "expiresAt", "maxExpiresAt",
  ])) return false;
  const expiresAt = ownValue(lease, "expiresAt");
  const maxExpiresAt = ownValue(lease, "maxExpiresAt");
  return opaqueId(ownValue(lease, "ownerToken"))
    && opaqueId(ownValue(lease, "dispatchId"))
    && opaqueId(ownValue(lease, "outcomeId"))
    && opaqueId(ownValue(lease, "leaseId"))
    && safeInteger(ownValue(lease, "generation"))
    && timestamp(expiresAt)
    && timestamp(maxExpiresAt)
    && expiresAt <= maxExpiresAt;
}

function validScope(value: unknown): value is ReliabilityV2Scope {
  const scope = plainRecord(value);
  if (!scope || !hasOnlyKeys(scope, ["generation", "failures"], ["openUntil", "cooldownMultiplier", "lease"])) return false;
  const failures = safeArray(ownValue(scope, "failures"));
  const openUntil = ownValue(scope, "openUntil");
  const multiplier = ownValue(scope, "cooldownMultiplier");
  const lease = ownValue(scope, "lease");
  return safeInteger(ownValue(scope, "generation"))
    && !!failures
    && failures.length <= MAX_FAILURE_TIMESTAMPS
    && failures.every(timestamp)
    && (openUntil === undefined || timestamp(openUntil))
    && (multiplier === undefined || safeInteger(multiplier, 1) && multiplier <= 1_000_000)
    && (lease === undefined || validLease(lease));
}

function validScopeReceipt(value: unknown): value is ReliabilityV2ScopeReceipt {
  const receipt = plainRecord(value);
  if (!receipt || !hasOnlyKeys(receipt, ["scopeKey", "modelKey", "generation"], ["leaseId", "expiresAt", "maxExpiresAt"])) return false;
  const key = ownValue(receipt, "modelKey");
  const leaseId = ownValue(receipt, "leaseId");
  const expiresAt = ownValue(receipt, "expiresAt");
  const maxExpiresAt = ownValue(receipt, "maxExpiresAt");
  const hasLease = leaseId !== undefined || expiresAt !== undefined || maxExpiresAt !== undefined;
  return modelKey(key)
    && ownValue(receipt, "scopeKey") === modelScopeKey(key)
    && safeInteger(ownValue(receipt, "generation"))
    && (!hasLease || (opaqueId(leaseId) && timestamp(expiresAt) && timestamp(maxExpiresAt) && expiresAt <= maxExpiresAt));
}

function validDispatchReceipt(value: unknown, key: string): value is ReliabilityV2DispatchReceipt {
  const receipt = plainRecord(value);
  if (!receipt || !hasOnlyKeys(receipt,
    ["ownerToken", "dispatchId", "outcomeId", "admittedAt", "proofUntil", "scopes"],
    ["settledAt", "settledKind"])) return false;
  const scopes = safeArray(ownValue(receipt, "scopes"));
  const settledAt = ownValue(receipt, "settledAt");
  const settledKind = ownValue(receipt, "settledKind");
  const dispatchId = ownValue(receipt, "dispatchId");
  return opaqueId(ownValue(receipt, "ownerToken"))
    && opaqueId(dispatchId)
    && key === dispatchId
    && opaqueId(ownValue(receipt, "outcomeId"))
    && timestamp(ownValue(receipt, "admittedAt"))
    && timestamp(ownValue(receipt, "proofUntil"))
    && !!scopes
    && scopes.length > 0
    && scopes.every(validScopeReceipt)
    && new Set(scopes.map((entry) => (entry as ReliabilityV2ScopeReceipt).scopeKey)).size === scopes.length
    && (settledAt === undefined || timestamp(settledAt))
    && (settledKind === undefined || settledKind === "success" || settledKind === "failure" || settledKind === "cancelled")
    && ((settledAt === undefined) === (settledKind === undefined));
}

function validState(value: unknown, config: ReliabilityV2Config): value is ReliabilityV2State {
  const state = plainRecord(value);
  if (!state || !hasOnlyKeys(state, ["version", "revision", "scopes", "dispatches", "settledOutcomes"])) return false;
  if (ownValue(state, "version") !== 2 || !safeInteger(ownValue(state, "revision"))) return false;
  const scopes = plainRecord(ownValue(state, "scopes"));
  const dispatches = plainRecord(ownValue(state, "dispatches"));
  const outcomes = plainRecord(ownValue(state, "settledOutcomes"));
  if (!scopes || !dispatches || !outcomes) return false;

  const scopeKeys = ownKeys(scopes);
  const dispatchKeys = ownKeys(dispatches);
  const outcomeKeys = ownKeys(outcomes);
  if (!scopeKeys || !dispatchKeys || !outcomeKeys || dispatchKeys.length > config.maxDispatchReceipts || outcomeKeys.length > config.maxDedupEntries) return false;
  for (const key of scopeKeys) {
    const record = ownValue(scopes, key);
    const encodedModel = key.match(/^model:(\d+):(.+)$/);
    if (!encodedModel || Number(encodedModel[1]) !== encodedModel[2]!.length || !modelKey(encodedModel[2]) || !validScope(record)) return false;
  }
  const receiptOutcomes = new Set<string>();
  for (const id of dispatchKeys) {
    const rawReceipt = ownValue(dispatches, id);
    if (!opaqueId(id) || !validDispatchReceipt(rawReceipt, id)) return false;
    const receipt = rawReceipt as ReliabilityV2DispatchReceipt;
    if (receiptOutcomes.has(receipt.outcomeId)) return false;
    receiptOutcomes.add(receipt.outcomeId);
    const expectedProofUntil = safeAdd(receipt.admittedAt, config.maxDispatchLifetimeMs);
    if (expectedProofUntil === undefined || receipt.proofUntil !== expectedProofUntil) return false;
    for (const scopeReceipt of receipt.scopes) {
      const scopeRecord = ownValue(scopes, scopeReceipt.scopeKey);
      if (!scopeKeys.includes(scopeReceipt.scopeKey)
        || !validScope(scopeRecord)
        || scopeReceipt.generation > scopeRecord.generation) return false;
      if (scopeReceipt.maxExpiresAt !== undefined && scopeReceipt.maxExpiresAt > receipt.proofUntil) return false;
    }
    if (receipt.settledAt !== undefined) {
      if (receipt.settledAt > receipt.proofUntil) return false;
      const outcome = ownValue(outcomes, receipt.outcomeId);
      const record = plainRecord(outcome);
      if (!record || !timestamp(ownValue(record, "expiresAt")) || (ownValue(record, "expiresAt") as number) < receipt.proofUntil) return false;
      const observation = ownValue(record, "observation");
      if (observation !== undefined) {
        if (receipt.settledKind !== "failure" || receipt.scopes.length !== 1) return false;
        const summary = plainRecord(observation);
        const scopeReceipt = receipt.scopes[0]!;
        if (!summary || ownValue(summary, "modelKey") !== scopeReceipt.modelKey
          || !timestamp(ownValue(summary, "observedAt"))
          || (ownValue(summary, "observedAt") as number) < receipt.admittedAt
          || (ownValue(summary, "observedAt") as number) > receipt.settledAt
          || !validObservationSummary(summary, receipt.outcomeId, ownValue(summary, "observedAt") as number)) return false;
      }
    } else if (ownValue(outcomes, receipt.outcomeId) !== undefined) {
      return false;
    }
  }
  for (const id of outcomeKeys) {
    const outcome = plainRecord(ownValue(outcomes, id));
    if (!opaqueId(id) || !outcome || !hasOnlyKeys(outcome, ["expiresAt"], ["observation"]) || !timestamp(ownValue(outcome, "expiresAt"))) return false;
    const observation = ownValue(outcome, "observation");
    if (observation !== undefined) {
      const summary = plainRecord(observation);
      const key = summary ? ownValue(summary, "modelKey") : undefined;
      const observedAt = summary ? ownValue(summary, "observedAt") : undefined;
      if (!summary || !modelKey(key) || !timestamp(observedAt)
        || observedAt > (ownValue(outcome, "expiresAt") as number)
        || !scopeKeys.includes(modelScopeKey(key))
        || !validObservationSummary(summary, id, observedAt)) return false;
    }
  }
  for (const key of scopeKeys) {
    const current = ownValue(scopes, key) as ReliabilityV2Scope;
    const lease = current.lease;
    if (!lease) continue;
    const receipt = ownValue(dispatches, lease.dispatchId) as ReliabilityV2DispatchReceipt | undefined;
    const scopeReceipt = receipt?.scopes.find((entry) => entry.scopeKey === key);
    if (!receipt || receipt.settledAt !== undefined || !scopeReceipt
      || receipt.ownerToken !== lease.ownerToken
      || receipt.outcomeId !== lease.outcomeId
      || scopeReceipt.generation !== lease.generation
      || scopeReceipt.leaseId !== lease.leaseId
      || scopeReceipt.expiresAt !== lease.expiresAt
      || scopeReceipt.maxExpiresAt !== lease.maxExpiresAt
      || current.generation !== lease.generation) return false;
  }
  return true;
}

export function validateReliabilityV2State(value: unknown, config: unknown): value is ReliabilityV2State {
  return isConfig(config) && validState(value, config);
}

function increment(value: number): number | undefined {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : undefined;
}

function safeAdd(left: number, right: number): number | undefined {
  const value = left + right;
  return timestamp(value) ? value : undefined;
}

function cloneState(state: ReliabilityV2State): ReliabilityV2State {
  const scopes = nullMap<ReliabilityV2Scope>();
  for (const [key, scope] of Object.entries(state.scopes)) {
    scopes[key] = {
      generation: scope.generation,
      failures: [...scope.failures],
      ...(scope.openUntil === undefined ? {} : { openUntil: scope.openUntil }),
      ...(scope.cooldownMultiplier === undefined ? {} : { cooldownMultiplier: scope.cooldownMultiplier }),
      ...(scope.lease === undefined ? {} : { lease: { ...scope.lease } }),
    };
  }
  const dispatches = nullMap<ReliabilityV2DispatchReceipt>();
  for (const [id, receipt] of Object.entries(state.dispatches)) {
    dispatches[id] = {
      ...receipt,
      scopes: receipt.scopes.map((scope) => ({ ...scope })),
    };
  }
  const settledOutcomes = nullMap<{ expiresAt: number; observation?: ReliabilityV2ObservationSummary }>();
  for (const [id, outcome] of Object.entries(state.settledOutcomes)) {
    settledOutcomes[id] = {
      expiresAt: outcome.expiresAt,
      ...(outcome.observation === undefined ? {} : { observation: { ...outcome.observation } }),
    };
  }
  return { version: 2, revision: state.revision, scopes, dispatches, settledOutcomes };
}

function validation(state: unknown, config: unknown, now: unknown): { state: ReliabilityV2State; config: ReliabilityV2Config; now: number } | undefined {
  if (!isConfig(config) || !validState(state, config) || !timestamp(now)) return undefined;
  return { state, config, now };
}

function releaseExpiredReceiptLeases(state: ReliabilityV2State, receipt: ReliabilityV2DispatchReceipt, now: number): void {
  for (const scopeReceipt of receipt.scopes) {
    if (scopeReceipt.leaseId === undefined || scopeReceipt.expiresAt === undefined || scopeReceipt.maxExpiresAt === undefined) continue;
    const current = mapValue(state.scopes, scopeReceipt.scopeKey);
    const lease = current?.lease;
    const matchesReceipt = lease
      && lease.expiresAt <= now
      && lease.ownerToken === receipt.ownerToken
      && lease.dispatchId === receipt.dispatchId
      && lease.outcomeId === receipt.outcomeId
      && lease.leaseId === scopeReceipt.leaseId
      && lease.generation === scopeReceipt.generation
      && lease.generation === current.generation
      && lease.expiresAt === scopeReceipt.expiresAt
      && lease.maxExpiresAt === scopeReceipt.maxExpiresAt;
    if (matchesReceipt) {
      const { lease: _lease, ...withoutLease } = current;
      state.scopes[scopeReceipt.scopeKey] = withoutLease;
    }
  }
}

function prune(state: ReliabilityV2State, now: number): boolean {
  let changed = false;
  for (const [id, receipt] of Object.entries(state.dispatches)) {
    if (receipt.proofUntil < now) {
      releaseExpiredReceiptLeases(state, receipt, now);
      delete state.dispatches[id];
      changed = true;
    }
  }
  for (const [id, outcome] of Object.entries(state.settledOutcomes)) {
    if (outcome.expiresAt < now) {
      delete state.settledOutcomes[id];
      changed = true;
    }
  }
  return changed;
}

function commit(state: ReliabilityV2State): ReliabilityV2State | undefined {
  const revision = increment(state.revision);
  if (revision === undefined) return undefined;
  state.revision = revision;
  return state;
}

function noChange(status: ReliabilityV2ResultStatus, reason?: string, state?: ReliabilityV2State): ReliabilityV2Result {
  return { status, ...(reason ? { reason } : {}), state: state ?? emptyReliabilityV2State() };
}

function ownDispatch(
  state: ReliabilityV2State,
  ownerToken: unknown,
  dispatchId: unknown,
  outcomeId: unknown,
): ReliabilityV2DispatchReceipt | undefined {
  if (!opaqueId(ownerToken) || !opaqueId(dispatchId) || !opaqueId(outcomeId)) return undefined;
  const receipt = mapValue(state.dispatches, dispatchId);
  if (!receipt || receipt.ownerToken !== ownerToken || receipt.outcomeId !== outcomeId) return undefined;
  return receipt;
}

function leaseReferences(receipt: ReliabilityV2DispatchReceipt): ReliabilityV2LeaseReference[] {
  return receipt.scopes.flatMap((scope) => scope.leaseId === undefined ? [] : [{
    scopeKey: scope.scopeKey,
    generation: scope.generation,
    leaseId: scope.leaseId,
    expiresAt: scope.expiresAt!,
    maxExpiresAt: scope.maxExpiresAt!,
  }]);
}

function sameReferences(actual: readonly ReliabilityV2LeaseReference[], expected: readonly ReliabilityV2LeaseReference[]): boolean {
  if (actual.length !== expected.length) return false;
  const byKey = new Map(actual.map((reference) => [reference.scopeKey, reference]));
  if (byKey.size !== actual.length) return false;
  return expected.every((reference) => {
    const found = byKey.get(reference.scopeKey);
    return !!found
      && found.generation === reference.generation
      && found.leaseId === reference.leaseId
      && found.expiresAt === reference.expiresAt
      && found.maxExpiresAt === reference.maxExpiresAt;
  });
}

function liveOwnedLease(
  scope: ReliabilityV2Scope | undefined,
  reference: ReliabilityV2LeaseReference,
  receipt: ReliabilityV2DispatchReceipt,
  now: number,
): boolean {
  const lease = scope?.lease;
  return !!lease
    && lease.expiresAt > now
    && lease.generation === reference.generation
    && lease.generation === scope?.generation
    && lease.leaseId === reference.leaseId
    && lease.expiresAt === reference.expiresAt
    && lease.maxExpiresAt === reference.maxExpiresAt
    && lease.ownerToken === receipt.ownerToken
    && lease.dispatchId === receipt.dispatchId
    && lease.outcomeId === receipt.outcomeId;
}

function requestRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): DataRecord | undefined {
  const record = plainRecord(value);
  return record && hasOnlyKeys(record, required, optional) ? record : undefined;
}

function cleanupCandidate(state: ReliabilityV2State, now: number): ReliabilityV2State {
  const next = cloneState(state);
  prune(next, now);
  return next;
}

/** Atomically creates an immutable receipt for every model scope and leases half-open scopes. */
export function admitReliabilityV2Dispatch(
  stateValue: unknown,
  requestValue: unknown,
  configValue: unknown,
): ReliabilityV2Result {
  const request = requestRecord(requestValue, ["ownerToken", "dispatchId", "outcomeId", "modelKeys", "now"]);
  const config = isConfig(configValue) ? configValue : undefined;
  const now = request ? ownValue(request, "now") : undefined;
  const checked = config && validation(stateValue, config, now);
  if (!request || !checked) return noChange("invalid", "invalid_state_config_or_request");
  const ownerToken = ownValue(request, "ownerToken");
  const dispatchId = ownValue(request, "dispatchId");
  const outcomeId = ownValue(request, "outcomeId");
  const models = safeArray(ownValue(request, "modelKeys"));
  if (!opaqueId(ownerToken) || !opaqueId(dispatchId) || !opaqueId(outcomeId) || !models || models.length === 0 || !models.every(modelKey)) {
    return noChange("invalid", "invalid_admission_identity_or_models", checked.state);
  }
  const keys = models.map((key) => modelScopeKey(key));
  if (new Set(keys).size !== keys.length) return noChange("invalid", "duplicate_model_scope", checked.state);

  const next = cleanupCandidate(checked.state, checked.now);
  if (mapValue(next.dispatches, dispatchId)
    || mapValue(next.settledOutcomes, outcomeId)
    || Object.values(next.dispatches).some((receipt) => receipt.outcomeId === outcomeId)) {
    return noChange("duplicate", "dispatch_or_outcome_id_exists", checked.state);
  }
  if (Object.keys(next.dispatches).length >= checked.config.maxDispatchReceipts) return noChange("capacity", "dispatch_receipt_capacity", checked.state);

  const scopes: ReliabilityV2ScopeReceipt[] = [];
  const blockedModels: Array<{ key: string; reason: string }> = [];
  for (let index = 0; index < models.length; index += 1) {
    const key = keys[index]!;
    const current = next.scopes[key] ?? { generation: 0, failures: [] };
    if (current.openUntil !== undefined && current.openUntil > checked.now) {
      blockedModels.push({ key, reason: "open" });
      continue;
    }
    const halfOpen = current.openUntil !== undefined && current.openUntil <= checked.now;
    if (halfOpen && current.lease && current.lease.generation === current.generation && current.lease.expiresAt > checked.now) {
      blockedModels.push({ key, reason: "lease_owned" });
      continue;
    }
    const scopeReceipt: ReliabilityV2ScopeReceipt = { scopeKey: key, modelKey: models[index]!, generation: current.generation };
    if (halfOpen) {
      const maxExpiresAt = safeAdd(checked.now, checked.config.maxDispatchLifetimeMs);
      const requestedExpiry = safeAdd(checked.now, checked.config.leaseTtlMs);
      if (maxExpiresAt === undefined || requestedExpiry === undefined) return noChange("overflow", "lease_time_overflow", checked.state);
      const expiresAt = Math.min(requestedExpiry, maxExpiresAt);
      // Scope key disambiguates leases within a dispatch; reusing the opaque
      // dispatch ID avoids deriving an unbounded or caller-controlled token.
      const leaseId = dispatchId;
      const lease: ReliabilityV2Lease = {
        ownerToken, dispatchId, outcomeId, leaseId, generation: current.generation,
        expiresAt, maxExpiresAt,
      };
      next.scopes[key] = { ...current, lease };
      Object.assign(scopeReceipt, { leaseId, expiresAt, maxExpiresAt });
    } else {
      next.scopes[key] = { ...current, failures: [...current.failures] };
    }
    scopes.push(scopeReceipt);
  }
  if (blockedModels.length > 0) {
    return noChange("blocked", blockedModels.map((item) => `${item.key}:${item.reason}`).join(","), checked.state);
  }
  const maxExpiresAt = safeAdd(checked.now, checked.config.maxDispatchLifetimeMs);
  if (maxExpiresAt === undefined) return noChange("overflow", "dispatch_proof_horizon_overflow", checked.state);
  const proofUntil = maxExpiresAt;
  next.dispatches[dispatchId] = {
    ownerToken, dispatchId, outcomeId, admittedAt: checked.now, proofUntil, scopes,
  };
  const committed = commit(next);
  return committed
    ? { status: "admitted", state: committed, leases: leaseReferences(next.dispatches[dispatchId]!) }
    : noChange("overflow", "revision_overflow", checked.state);
}

function validateLeaseOperation(
  stateValue: unknown,
  requestValue: unknown,
  configValue: unknown,
  required: boolean,
): { request: DataRecord; checked: NonNullable<ReturnType<typeof validation>>; receipt: ReliabilityV2DispatchReceipt; refs: ReliabilityV2LeaseReference[] } | undefined {
  const request = requestRecord(requestValue,
    ["ownerToken", "dispatchId", "outcomeId", "leaseReferences", "now"], ["ttlMs"]);
  const config = isConfig(configValue) ? configValue : undefined;
  const checked = request && config ? validation(stateValue, config, ownValue(request, "now")) : undefined;
  if (!request || !checked) return undefined;
  const receipt = ownDispatch(checked.state, ownValue(request, "ownerToken"), ownValue(request, "dispatchId"), ownValue(request, "outcomeId"));
  const inputRefs = safeArray(ownValue(request, "leaseReferences"));
  if (!receipt || !inputRefs || !inputRefs.every(validLeaseReference)) return undefined;
  const refs = inputRefs as ReliabilityV2LeaseReference[];
  const expected = leaseReferences(receipt);
  if (!sameReferences(refs, expected) || (required && expected.length === 0)) return undefined;
  return { request, checked, receipt, refs };
}

function validLeaseReference(value: unknown): value is ReliabilityV2LeaseReference {
  const reference = plainRecord(value);
  if (!reference || !hasOnlyKeys(reference, ["scopeKey", "generation", "leaseId", "expiresAt", "maxExpiresAt"])) return false;
  const scopeKey = ownValue(reference, "scopeKey");
  return typeof scopeKey === "string"
    && scopeKey.startsWith("model:")
    && safeInteger(ownValue(reference, "generation"))
    && opaqueId(ownValue(reference, "leaseId"))
    && timestamp(ownValue(reference, "expiresAt"))
    && timestamp(ownValue(reference, "maxExpiresAt"))
    && (ownValue(reference, "expiresAt") as number) <= (ownValue(reference, "maxExpiresAt") as number);
}

/** Renews every lease in the admission receipt or renews none. */
export function renewReliabilityV2Leases(
  stateValue: unknown,
  requestValue: unknown,
  configValue: unknown,
): ReliabilityV2Result {
  const operation = validateLeaseOperation(stateValue, requestValue, configValue, true);
  if (!operation) return noChange("invalid", "invalid_lease_renewal");
  const { request, checked, receipt, refs } = operation;
  const now = checked.now;
  if (now > receipt.proofUntil) return noChange("expired", "dispatch_proof_horizon_expired", checked.state);
  if (now < receipt.admittedAt) return noChange("stale", "clock_before_admission", checked.state);
  if (refs.some((reference) => now >= reference.maxExpiresAt)) return noChange("expired", "maximum_dispatch_lifetime_expired", checked.state);
  const ttlValue = ownValue(request, "ttlMs");
  const ttlMs = ttlValue === undefined ? checked.config.leaseTtlMs : ttlValue;
  if (!safeInteger(ttlMs, 1) || ttlMs > checked.config.leaseTtlMs) return noChange("invalid", "invalid_lease_ttl", checked.state);
  for (const reference of refs) {
    const scope = checked.state.scopes[reference.scopeKey];
    if (!liveOwnedLease(scope, reference, receipt, now)) return noChange("stale", "lease_owner_or_generation_changed", checked.state);
  }
  const next = cleanupCandidate(checked.state, now);
  for (const reference of refs) {
    const scope = next.scopes[reference.scopeKey]!;
    const lease = scope.lease!;
    const requestedExpiry = safeAdd(now, ttlMs);
    if (requestedExpiry === undefined) return noChange("overflow", "lease_time_overflow", checked.state);
    const expiresAt = Math.min(requestedExpiry, lease.maxExpiresAt);
    next.scopes[reference.scopeKey] = { ...scope, lease: { ...lease, expiresAt } };
    const receiptScope = next.dispatches[receipt.dispatchId]!.scopes.find((entry) => entry.scopeKey === reference.scopeKey)!;
    receiptScope.expiresAt = expiresAt;
  }
  const committed = commit(next);
  return committed
    ? { status: "renewed", state: committed, leases: leaseReferences(next.dispatches[receipt.dispatchId]!) }
    : noChange("overflow", "revision_overflow", checked.state);
}

function validSettlement(value: unknown): value is ReliabilityV2Settlement {
  const settlement = plainRecord(value);
  if (!settlement) return false;
  const kind = ownValue(settlement, "kind");
  if (kind === "success" || kind === "cancelled") return hasOnlyKeys(settlement, ["kind"]);
  return kind === "failure" && hasOnlyKeys(settlement, ["kind"], ["observation"])
    && (ownValue(settlement, "observation") === undefined
      || !!normalizeObservationFields(ownValue(settlement, "observation"), MAX_TIMESTAMP));
}

function observationSummaryForReceipt(
  value: unknown,
  receipt: ReliabilityV2DispatchReceipt,
  now: number,
): ReliabilityV2ObservationSummary | undefined {
  if (value === undefined) return undefined;
  if (receipt.scopes.length !== 1) return undefined;
  const observation = normalizeObservationFields(value, now);
  const scope = receipt.scopes[0]!;
  if (!observation || observation.outcomeId !== receipt.outcomeId
    || observation.modelKey !== scope.modelKey
    || observation.observedAt < receipt.admittedAt
    || observation.observedAt > receipt.proofUntil) return undefined;
  return {
    modelKey: observation.modelKey,
    category: observation.category,
    categoryEvidence: observation.categoryEvidence,
    observedAt: observation.observedAt,
    ...(observation.retryAt === undefined ? {} : { retryAt: observation.retryAt }),
    source: observation.source,
  };
}

function settleDedupExpiry(receipt: ReliabilityV2DispatchReceipt, now: number, retention: number): number | undefined {
  const minimum = safeAdd(now, retention);
  if (minimum === undefined) return undefined;
  return Math.max(receipt.proofUntil, minimum);
}

function recentFailures(scope: ReliabilityV2Scope, now: number, windowMs: number): number[] {
  const cutoff = Math.max(0, now - windowMs);
  return scope.failures.filter((value) => value >= cutoff && value <= now);
}

function settledClone(
  checked: NonNullable<ReturnType<typeof validation>>,
  receipt: ReliabilityV2DispatchReceipt,
  settlement: ReliabilityV2Settlement,
  observation?: ReliabilityV2ObservationSummary,
): ReliabilityV2State | undefined {
  const next = cleanupCandidate(checked.state, checked.now);
  if (Object.keys(next.settledOutcomes).length >= checked.config.maxDedupEntries) return undefined;
  const expiry = settleDedupExpiry(receipt, checked.now, checked.config.dedupRetentionMs);
  if (expiry === undefined) return undefined;
  next.settledOutcomes[receipt.outcomeId] = {
    expiresAt: expiry,
    ...(observation === undefined ? {} : { observation }),
  };
  const nextReceipt = next.dispatches[receipt.dispatchId]!;
  nextReceipt.settledAt = checked.now;
  nextReceipt.settledKind = settlement.kind;
  return next;
}

/** Settles only scopes in the immutable admission receipt; callers cannot supply scope keys. */
export function settleReliabilityV2Dispatch(
  stateValue: unknown,
  requestValue: unknown,
  configValue: unknown,
): ReliabilityV2Result {
  const request = requestRecord(requestValue, ["ownerToken", "dispatchId", "outcomeId", "settlement", "now"]);
  const config = isConfig(configValue) ? configValue : undefined;
  const checked = request && config ? validation(stateValue, config, ownValue(request, "now")) : undefined;
  if (!request || !checked) return noChange("invalid", "invalid_settlement_request");
  const ownerToken = ownValue(request, "ownerToken");
  const dispatchId = ownValue(request, "dispatchId");
  const outcomeId = ownValue(request, "outcomeId");
  const settlement = ownValue(request, "settlement");
  if (!opaqueId(ownerToken) || !opaqueId(dispatchId) || !opaqueId(outcomeId) || !validSettlement(settlement)) {
    return noChange("invalid", "invalid_settlement_identity_or_kind", checked.state);
  }
  const receipt = ownDispatch(checked.state, ownerToken, dispatchId, outcomeId);
  if (!receipt) return noChange("stale", "admission_receipt_missing_or_owner_mismatch", checked.state);
  if (checked.now > receipt.proofUntil) return noChange("expired", "dispatch_proof_horizon_expired", checked.state);
  if (checked.now < receipt.admittedAt) return noChange("stale", "clock_before_admission", checked.state);
  const suppliedObservation = ownValue(plainRecord(settlement)!, "observation");
  const observation = observationSummaryForReceipt(suppliedObservation, receipt, checked.now);
  if (suppliedObservation !== undefined && (!observation || settlement.kind !== "failure")) {
    return noChange("invalid", "invalid_failure_observation_binding", checked.state);
  }
  const priorOutcome = mapValue(checked.state.settledOutcomes, outcomeId);
  if (priorOutcome && priorOutcome.expiresAt >= checked.now) {
    if (!sameObservationSummary(priorOutcome.observation, observation)) {
      return noChange("invalid", "duplicate_observation_mismatch", checked.state);
    }
    return noChange("duplicate", "outcome_already_settled", checked.state);
  }
  if (receipt.settledAt !== undefined) return noChange("duplicate", "dispatch_already_settled", checked.state);
  if (Object.keys(cleanupCandidate(checked.state, checked.now).settledOutcomes).length >= checked.config.maxDedupEntries) {
    return noChange("capacity", "outcome_dedup_capacity", checked.state);
  }

  if (settlement.kind === "cancelled") {
    for (const reference of leaseReferences(receipt)) {
      if (!liveOwnedLease(checked.state.scopes[reference.scopeKey], reference, receipt, checked.now)) {
        return noChange("stale", "lease_owner_or_generation_changed", checked.state);
      }
    }
  }

  let staleSuccess = false;
  if (settlement.kind === "success") {
    for (const scopeReceipt of receipt.scopes) {
      if (scopeReceipt.leaseId === undefined) continue;
      const reference: ReliabilityV2LeaseReference = {
        scopeKey: scopeReceipt.scopeKey,
        generation: scopeReceipt.generation,
        leaseId: scopeReceipt.leaseId,
        expiresAt: scopeReceipt.expiresAt!,
        maxExpiresAt: scopeReceipt.maxExpiresAt!,
      };
      if (!liveOwnedLease(checked.state.scopes[scopeReceipt.scopeKey], reference, receipt, checked.now)) {
        staleSuccess = true;
      }
    }
  }

  const next = settledClone(checked, receipt, settlement, observation);
  if (!next) return noChange("capacity", "outcome_dedup_capacity_or_time_overflow", checked.state);
  if (staleSuccess) releaseExpiredReceiptLeases(next, receipt, checked.now);
  if (settlement.kind === "failure") {
    for (const scopeReceipt of receipt.scopes) {
      const previous = next.scopes[scopeReceipt.scopeKey] ?? { generation: scopeReceipt.generation, failures: [] };
      const generation = increment(previous.generation);
      if (generation === undefined) return noChange("overflow", "scope_generation_overflow", checked.state);
      const failures = [...recentFailures(previous, checked.now, checked.config.windowMs), checked.now]
        .slice(-checked.config.failureThreshold);
      const admittedTrial = scopeReceipt.leaseId !== undefined
        && previous.lease?.leaseId === scopeReceipt.leaseId
        && previous.lease.ownerToken === receipt.ownerToken
        && previous.lease.dispatchId === receipt.dispatchId
        && previous.lease.outcomeId === receipt.outcomeId
        && previous.lease.generation === scopeReceipt.generation
        && previous.lease.expiresAt > checked.now;
      let openUntil = previous.openUntil;
      let cooldownMultiplier = previous.cooldownMultiplier;
      if (admittedTrial) {
        cooldownMultiplier = Math.min((cooldownMultiplier ?? 1) * 2, 1_000_000);
        const delay = checked.config.cooldownMs * cooldownMultiplier;
        const until = safeAdd(checked.now, delay);
        if (until === undefined) return noChange("overflow", "cooldown_time_overflow", checked.state);
        openUntil = until;
      } else if (failures.length >= checked.config.failureThreshold
        || previous.openUntil !== undefined && previous.openUntil <= checked.now) {
        const until = safeAdd(checked.now, checked.config.cooldownMs);
        if (until === undefined) return noChange("overflow", "cooldown_time_overflow", checked.state);
        openUntil = Math.max(previous.openUntil ?? 0, until);
      }
      next.scopes[scopeReceipt.scopeKey] = {
        generation,
        failures,
        ...(openUntil === undefined ? {} : { openUntil }),
        ...(cooldownMultiplier === undefined ? {} : { cooldownMultiplier }),
      };
    }
  } else if (settlement.kind === "success" && !staleSuccess) {
    for (const scopeReceipt of receipt.scopes) {
      if (scopeReceipt.leaseId === undefined) continue;
      const previous = next.scopes[scopeReceipt.scopeKey]!;
      const generation = increment(previous.generation);
      if (generation === undefined) return noChange("overflow", "scope_generation_overflow", checked.state);
      next.scopes[scopeReceipt.scopeKey] = { generation, failures: [] };
    }
  } else if (settlement.kind === "cancelled") {
    for (const scopeReceipt of receipt.scopes) {
      if (scopeReceipt.leaseId === undefined) continue;
      const { lease: _lease, ...withoutLease } = next.scopes[scopeReceipt.scopeKey]!;
      next.scopes[scopeReceipt.scopeKey] = withoutLease;
    }
  }

  const committed = commit(next);
  if (!committed) return noChange("overflow", "revision_overflow", checked.state);
  return {
    status: staleSuccess ? "stale" : "settled",
    ...(staleSuccess ? { reason: "success_did_not_own_current_generation" } : {}),
    state: committed,
  };
}

/** Releases all exact, unexpired leases owned by the receipt; it records cancellation dedup. */
export function abandonReliabilityV2Dispatch(
  stateValue: unknown,
  requestValue: unknown,
  configValue: unknown,
): ReliabilityV2Result {
  const operation = validateLeaseOperation(stateValue, requestValue, configValue, false);
  if (!operation) return noChange("invalid", "invalid_abandon_request");
  const { checked, receipt, refs } = operation;
  if (checked.now > receipt.proofUntil) return noChange("expired", "dispatch_proof_horizon_expired", checked.state);
  if (receipt.settledAt !== undefined) return noChange("duplicate", "dispatch_already_settled", checked.state);
  for (const reference of refs) {
    if (!liveOwnedLease(checked.state.scopes[reference.scopeKey], reference, receipt, checked.now)) {
      return noChange("stale", "lease_owner_or_generation_changed", checked.state);
    }
  }
  const cancelled = settleReliabilityV2Dispatch(checked.state, {
    ownerToken: receipt.ownerToken,
    dispatchId: receipt.dispatchId,
    outcomeId: receipt.outcomeId,
    settlement: { kind: "cancelled" },
    now: checked.now,
  }, checked.config);
  if (cancelled.status !== "settled") return cancelled;
  return { ...cancelled, status: "abandoned" };
}
