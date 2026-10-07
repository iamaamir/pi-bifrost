export type EconomicScope =
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "provider"; readonly provider: string }
  | { readonly kind: "account"; readonly provider: string; readonly accountRef: string; readonly epoch: string };

export type AllowanceUnit = "requests" | "tokens" | "credits" | "ratio" | "currency";
export type EconomicAuthority = "authoritative" | "declared" | "estimated";
export type BillingMode = "subscription" | "metered" | "free" | "unknown";
export type UnknownHandling = "block" | "ignore";

export interface EconomicSource {
  readonly id: string;
  readonly scopeRef: string;
  /** Authority is declared by the registered source, never by its observations. */
  readonly authority: EconomicAuthority;
}

export interface AllowanceWindow {
  readonly id: string;
  readonly period: {
    readonly id: string;
    /** Adapter-normalized monotonic period order for this source/window. */
    readonly sequence: number;
  };
  readonly unit: AllowanceUnit;
  readonly currency?: string;
  readonly remaining: number;
  readonly limit?: number;
  readonly resetsAt?: number;
}

export interface EconomicSignal {
  readonly sourceId: string;
  readonly scopeRef: string;
  readonly billing: BillingMode;
  readonly observedAt: number;
  readonly expiresAt: number;
  /** Monotonic within this source/scope observation; compared for same periods. */
  readonly revision: number;
  readonly windows: readonly AllowanceWindow[];
}

export interface EconomicWindowWatermark {
  readonly sourceId: string;
  readonly scopeRef: string;
  readonly windowId: string;
  readonly periodId: string;
  readonly periodSequence: number;
  readonly revision: number;
}

export interface EconomicSnapshot {
  readonly revision: number;
  readonly signals: readonly EconomicSignal[];
  /** Retains per-window period order even if a later observation omits that window. */
  readonly watermarks: readonly EconomicWindowWatermark[];
}

export interface ReserveRule {
  readonly id: string;
  readonly scopeRef: string;
  readonly windowId: string;
  readonly reserveRatio: number;
  readonly unknown: UnknownHandling;
}

export interface ReservePolicy {
  readonly mode: "observe" | "policy";
  readonly scopes: Readonly<Record<string, EconomicScope>>;
  readonly sources: readonly EconomicSource[];
  /** Explicit source precedence, keyed only by the local scope alias. */
  readonly sourceOrder?: Readonly<Record<string, readonly string[]>>;
  readonly admission: readonly ReserveRule[];
  readonly tierOverrides?: Readonly<Record<string, Readonly<Record<string, Partial<Pick<ReserveRule, "reserveRatio" | "unknown">>>>>>;
}

export interface EconomicHostCapabilities {
  readonly accountDispatch: boolean;
}

export interface EconomicDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly repair: string;
  readonly sourceId?: string;
  readonly scopeRef?: string;
  readonly windowId?: string;
  readonly ruleId?: string;
}

export interface EconomicValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly EconomicDiagnostic[];
}

export interface PublishObservationResult {
  readonly accepted: boolean;
  readonly code: "observation_accepted" | "observation_duplicate" | "observation_stale" | "observation_period_conflict" | "observation_revision_conflict" | "observation_invalid" | "snapshot_full";
  readonly snapshot: EconomicSnapshot;
  readonly diagnostics: readonly EconomicDiagnostic[];
}

export interface DispatchScope {
  readonly model: string;
  readonly provider: string;
  readonly accountBinding?: { readonly accountRef: string; readonly epoch: string };
}

export interface EvaluateReservesInput {
  readonly snapshot: EconomicSnapshot;
  readonly policy: ReservePolicy;
  readonly candidate: DispatchScope;
  readonly requestedTier: string;
  readonly evaluatedTier: string;
  readonly hostCapabilities: EconomicHostCapabilities;
  readonly now: number;
}

export type ReserveRuleStatus = "pass" | "reject" | "unknown";
export type ReserveRuleReason = "above_reserve" | "reserve_reached" | "missing_fact" | "stale_fact" | "invalid_fact" | "source_conflict" | "period_conflict" | "unsupported_scope" | "scope.invalid" | "context.invalid";

export interface ReserveRuleResult {
  readonly ruleId: string;
  readonly scopeRef: string;
  readonly windowId: string;
  readonly status: ReserveRuleStatus;
  readonly reason: ReserveRuleReason;
  readonly unknownHandling: UnknownHandling;
  readonly sourceId?: string;
  readonly periodId?: string;
  readonly remainingRatio?: number;
}

export interface ReserveEvaluation {
  readonly mode: ReservePolicy["mode"];
  readonly disposition: "observed" | "admitted" | "rejected" | "unknown_ignored" | "no_rules";
  readonly wouldReject: boolean;
  readonly results: readonly ReserveRuleResult[];
}

const MAX_SOURCES = 16;
const MAX_SIGNALS = 256;
const MAX_WINDOWS_PER_SIGNAL = 16;
const MAX_WATERMARKS = MAX_SIGNALS * MAX_WINDOWS_PER_SIGNAL;
const MAX_ADMISSION_RULES = 128;
const MAX_SCOPE_ALIASES = 64;
const MAX_ID = 128;
const MAX_PROVIDER_MODEL_ID = 256;
const MAX_CURRENCY_CODE = 3;
const MAX_DATE_EPOCH = 8.64e15;
const REPAIR_POLICY = "Check the local economic source, scope, and admission policy.";
const REPAIR_OBSERVATION = "Discard this observation and request a fresh, correctly ordered source snapshot.";

const authorityRank: Record<EconomicAuthority, number> = {
  authoritative: 3,
  declared: 2,
  estimated: 1,
};

export function emptyEconomicSnapshot(): EconomicSnapshot {
  return { revision: 0, signals: [], watermarks: [] };
}

function diagnostic(
  code: string,
  severity: EconomicDiagnostic["severity"] = "error",
  detail: Partial<Pick<EconomicDiagnostic, "sourceId" | "scopeRef" | "windowId" | "ruleId">> = {},
  repair = REPAIR_POLICY,
): EconomicDiagnostic {
  const safeDetail: { sourceId?: string; scopeRef?: string; windowId?: string; ruleId?: string } = {};
  if (safeDiagnosticId(detail.sourceId, MAX_SCOPE_ALIASES)) safeDetail.sourceId = detail.sourceId;
  if (safeDiagnosticId(detail.scopeRef, MAX_SCOPE_ALIASES)) safeDetail.scopeRef = detail.scopeRef;
  if (safeDiagnosticId(detail.windowId)) safeDetail.windowId = detail.windowId;
  if (safeDiagnosticId(detail.ruleId)) safeDetail.ruleId = detail.ruleId;
  return { code, severity, repair, ...safeDetail };
}

function boundedId(value: unknown, max = MAX_ID): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function safeDiagnosticId(value: unknown, max = MAX_ID): value is string {
  return boundedId(value, max) && /^[A-Za-z0-9._:/-]+$/.test(value);
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function safeResultId(value: unknown): string {
  return safeDiagnosticId(value) ? value : "invalid";
}

function validDispatchScope(value: unknown): value is DispatchScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as DispatchScope;
  if (!canonicalModelId(candidate.model) || !boundedId(candidate.provider, MAX_ID)
    || candidate.model.slice(0, candidate.model.indexOf("/")) !== candidate.provider) return false;
  if (candidate.accountBinding === undefined) return true;
  const binding = candidate.accountBinding;
  return Boolean(binding && typeof binding === "object" && !Array.isArray(binding)
    && boundedId(binding.accountRef) && boundedId(binding.epoch));
}

function invalidEvaluation(
  mode: ReservePolicy["mode"],
  policy?: ReservePolicy,
  reason: ReserveRuleReason = "context.invalid",
): ReserveEvaluation {
  const results = (Array.isArray(policy?.admission) ? policy.admission : []).filter((rule) => rule && typeof rule === "object").map((rule): ReserveRuleResult => ({
    ruleId: safeResultId(rule.id),
    scopeRef: safeResultId(rule.scopeRef),
    windowId: safeResultId(rule.windowId),
    status: "unknown",
    reason,
    unknownHandling: rule.unknown === "ignore" ? "ignore" : "block",
  }));
  return { mode, disposition: mode === "observe" ? "observed" : "rejected", wouldReject: true, results };
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= MAX_DATE_EPOCH;
}

function canonicalModelId(value: unknown): value is string {
  if (!boundedId(value, MAX_PROVIDER_MODEL_ID)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1
    && boundedId(value.slice(0, separator), MAX_ID)
    && boundedId(value.slice(separator + 1), MAX_PROVIDER_MODEL_ID);
}

function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function validScope(scope: EconomicScope): boolean {
  if (!scope || typeof scope !== "object") return false;
  if (scope.kind === "model") return canonicalModelId(scope.model);
  if (scope.kind === "provider") return boundedId(scope.provider, MAX_ID);
  return scope.kind === "account"
    && boundedId(scope.provider, MAX_ID)
    && boundedId(scope.accountRef, MAX_ID)
    && boundedId(scope.epoch, MAX_ID);
}

function validRuleShape(rule: ReserveRule): boolean {
  return boundedId(rule.id, MAX_ID)
    && boundedId(rule.scopeRef, MAX_SCOPE_ALIASES)
    && boundedId(rule.windowId, MAX_ID)
    && Number.isFinite(rule.reserveRatio)
    && rule.reserveRatio >= 0
    && rule.reserveRatio <= 1
    && (rule.unknown === "block" || rule.unknown === "ignore");
}

export function validateEconomicPolicy(
  policy: ReservePolicy,
  hostCapabilities: EconomicHostCapabilities = { accountDispatch: false },
): EconomicValidationResult {
  const diagnostics: EconomicDiagnostic[] = [];
  if (!policy || (policy.mode !== "observe" && policy.mode !== "policy")) {
    diagnostics.push(diagnostic("policy.invalid_mode"));
    return { valid: false, diagnostics };
  }
  const scopes = policy.scopes && typeof policy.scopes === "object" && !Array.isArray(policy.scopes) ? policy.scopes : {};
  const scopeRefs = Object.keys(scopes);
  if (scopeRefs.length > MAX_SCOPE_ALIASES) diagnostics.push(diagnostic("policy.scope_limit"));
  if (!policy.scopes || typeof policy.scopes !== "object" || Array.isArray(policy.scopes)) diagnostics.push(diagnostic("policy.invalid_scopes"));
  for (const [scopeRef, scope] of Object.entries(scopes)) {
    if (!boundedId(scopeRef, MAX_SCOPE_ALIASES) || !validScope(scope)) diagnostics.push(diagnostic("scope.invalid", "error", { scopeRef }));
    if (scope?.kind === "account" && !hostCapabilities.accountDispatch) {
      diagnostics.push(diagnostic("policy.unsupported_account_scope", "error", { scopeRef }));
    }
  }
  if (!Array.isArray(policy.sources) || policy.sources.length > MAX_SOURCES) diagnostics.push(diagnostic("policy.source_limit"));
  const sourcesById = new Map<string, EconomicSource>();
  for (const source of Array.isArray(policy.sources) ? policy.sources : []) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      diagnostics.push(diagnostic("policy.invalid_source"));
      continue;
    }
    if (!boundedId(source.id, MAX_SCOPE_ALIASES) || !boundedId(source.scopeRef, MAX_SCOPE_ALIASES)
      || !Object.hasOwn(scopes, source.scopeRef)
      || !Object.hasOwn(authorityRank, source.authority)
      || sourcesById.has(source.id)) {
      diagnostics.push(diagnostic("policy.invalid_source", "error", { sourceId: source.id, scopeRef: source.scopeRef }));
      continue;
    }
    sourcesById.set(source.id, source);
  }
  if (!Array.isArray(policy.admission) || policy.admission.length > MAX_ADMISSION_RULES) diagnostics.push(diagnostic("policy.rule_limit"));
  const rulesById = new Map<string, ReserveRule>();
  for (const rule of Array.isArray(policy.admission) ? policy.admission : []) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      diagnostics.push(diagnostic("policy.invalid_rule"));
      continue;
    }
    if (!validRuleShape(rule) || !Object.hasOwn(scopes, rule.scopeRef) || rulesById.has(rule.id)) {
      diagnostics.push(diagnostic("policy.invalid_rule", "error", { scopeRef: rule.scopeRef, ruleId: rule.id }));
      continue;
    }
    rulesById.set(rule.id, rule);
  }
  if (policy.mode === "policy" && (policy.admission?.length ?? 0) === 0) {
    diagnostics.push(diagnostic("policy.empty_admission"));
  }
  const sourceOrder = policy.sourceOrder && typeof policy.sourceOrder === "object" && !Array.isArray(policy.sourceOrder) ? policy.sourceOrder : {};
  if (policy.sourceOrder !== undefined && (!policy.sourceOrder || typeof policy.sourceOrder !== "object" || Array.isArray(policy.sourceOrder))) diagnostics.push(diagnostic("policy.invalid_source_order"));
  for (const [scopeRef, order] of Object.entries(sourceOrder)) {
    if (!Object.hasOwn(scopes, scopeRef) || !Array.isArray(order) || order.length > MAX_SOURCES) {
      diagnostics.push(diagnostic("policy.invalid_source_order", "error", { scopeRef }));
      continue;
    }
    const seen = new Set<string>();
    for (const sourceId of order) {
      const source = sourcesById.get(sourceId);
      if (!source || source.scopeRef !== scopeRef || seen.has(sourceId)) {
        diagnostics.push(diagnostic("policy.invalid_source_order", "error", { sourceId, scopeRef }));
      }
      seen.add(sourceId);
    }
  }
  const tierOverrides = policy.tierOverrides && typeof policy.tierOverrides === "object" && !Array.isArray(policy.tierOverrides) ? policy.tierOverrides : {};
  if (policy.tierOverrides !== undefined && (!policy.tierOverrides || typeof policy.tierOverrides !== "object" || Array.isArray(policy.tierOverrides))) diagnostics.push(diagnostic("policy.invalid_tier_override"));
  for (const [tier, overrides] of Object.entries(tierOverrides)) {
    if (!boundedId(tier, MAX_ID)) diagnostics.push(diagnostic("policy.invalid_tier_override"));
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      diagnostics.push(diagnostic("policy.invalid_tier_override"));
      continue;
    }
    for (const [ruleId, override] of Object.entries(overrides)) {
      if (!override || typeof override !== "object" || Array.isArray(override)) {
        diagnostics.push(diagnostic("policy.invalid_tier_override", "error", { ruleId }));
        continue;
      }
      if (!rulesById.has(ruleId)
        || (override.reserveRatio !== undefined && (!Number.isFinite(override.reserveRatio) || override.reserveRatio < 0 || override.reserveRatio > 1))
        || (override.unknown !== undefined && override.unknown !== "block" && override.unknown !== "ignore")
        || Object.keys(override).some((key) => key !== "reserveRatio" && key !== "unknown")) {
        diagnostics.push(diagnostic("policy.invalid_tier_override", "error", { ruleId }));
      }
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateWindow(window: AllowanceWindow, detail: { sourceId: string; scopeRef: string }): EconomicDiagnostic[] {
  const diagnostics: EconomicDiagnostic[] = [];
  const windowDetail = { ...detail, windowId: window?.id };
  if (!boundedId(window?.id)) diagnostics.push(diagnostic("observation.invalid_window_id", "error", windowDetail, REPAIR_OBSERVATION));
  if (!boundedId(window?.period?.id) || !safeRevision(window?.period?.sequence)) {
    diagnostics.push(diagnostic("observation.invalid_period", "error", windowDetail, REPAIR_OBSERVATION));
  }
  if (!["requests", "tokens", "credits", "ratio", "currency"].includes(window?.unit)) {
    diagnostics.push(diagnostic("observation.invalid_unit", "error", windowDetail, REPAIR_OBSERVATION));
  }
  if (!finiteNonnegative(window?.remaining)) diagnostics.push(diagnostic("observation.invalid_remaining", "error", windowDetail, REPAIR_OBSERVATION));
  if (window?.limit !== undefined && (!Number.isFinite(window.limit) || window.limit <= 0 || window.remaining > window.limit)) {
    diagnostics.push(diagnostic("observation.invalid_limit", "error", windowDetail, REPAIR_OBSERVATION));
  }
  if (window?.unit === "ratio" && (window.remaining > 1 || window.limit !== undefined)) {
    diagnostics.push(diagnostic("observation.invalid_ratio", "error", windowDetail, REPAIR_OBSERVATION));
  }
  if (window?.unit === "currency") {
    if (!boundedId(window.currency, MAX_CURRENCY_CODE) || !/^[A-Z]{3}$/.test(window.currency)) {
      diagnostics.push(diagnostic("observation.invalid_currency", "error", windowDetail, REPAIR_OBSERVATION));
    }
  } else if (window?.currency !== undefined) {
    diagnostics.push(diagnostic("observation.incompatible_currency", "error", windowDetail, REPAIR_OBSERVATION));
  }
  if (window?.resetsAt !== undefined && !safeEpoch(window.resetsAt)) {
    diagnostics.push(diagnostic("observation.invalid_reset", "error", windowDetail, REPAIR_OBSERVATION));
  }
  return diagnostics;
}

function validateSignal(signal: EconomicSignal, policy: ReservePolicy): EconomicDiagnostic[] {
  const diagnostics: EconomicDiagnostic[] = [];
  const detail = { sourceId: signal?.sourceId, scopeRef: signal?.scopeRef };
  const sources = Array.isArray(policy?.sources) ? policy.sources : [];
  const source = sources.find((entry) => entry?.id === signal?.sourceId);
  if (!source || source.scopeRef !== signal?.scopeRef || !Object.hasOwn(policy.scopes ?? {}, signal?.scopeRef)) {
    diagnostics.push(diagnostic("observation.unknown_source", "error", detail, REPAIR_OBSERVATION));
  }
  if (!boundedId(signal?.sourceId, MAX_SCOPE_ALIASES) || !boundedId(signal?.scopeRef, MAX_SCOPE_ALIASES)) {
    diagnostics.push(diagnostic("observation.invalid_binding", "error", detail, REPAIR_OBSERVATION));
  }
  if (!(["subscription", "metered", "free", "unknown"] as const).includes(signal?.billing)) {
    diagnostics.push(diagnostic("observation.invalid_billing", "error", detail, REPAIR_OBSERVATION));
  }
  if (!safeEpoch(signal?.observedAt) || !safeEpoch(signal?.expiresAt) || signal.expiresAt <= signal.observedAt) {
    diagnostics.push(diagnostic("observation.invalid_freshness", "error", detail, REPAIR_OBSERVATION));
  }
  if (!safeRevision(signal?.revision)) diagnostics.push(diagnostic("observation.invalid_revision", "error", detail, REPAIR_OBSERVATION));
  if (!Array.isArray(signal?.windows) || signal.windows.length > MAX_WINDOWS_PER_SIGNAL) {
    diagnostics.push(diagnostic("observation.window_limit", "error", detail, REPAIR_OBSERVATION));
  } else {
    const seen = new Set<string>();
    for (const window of signal.windows) {
      diagnostics.push(...validateWindow(window, { sourceId: signal.sourceId, scopeRef: signal.scopeRef }));
      if (window && typeof window === "object" && boundedId(window.id)) {
        if (seen.has(window.id)) diagnostics.push(diagnostic("observation.duplicate_window", "error", { ...detail, windowId: window.id }, REPAIR_OBSERVATION));
        seen.add(window.id);
      }
    }
  }
  return diagnostics;
}

function watermarkKey(value: Pick<EconomicWindowWatermark, "sourceId" | "scopeRef" | "windowId">): string {
  return JSON.stringify([value.sourceId, value.scopeRef, value.windowId]);
}

function validateSnapshotShape(snapshot: EconomicSnapshot, policy: ReservePolicy): EconomicDiagnostic[] {
  const diagnostics: EconomicDiagnostic[] = [];
  if (!policy || typeof policy !== "object") return [diagnostic("snapshot.invalid_policy")];
  if (!safeRevision(snapshot?.revision)) diagnostics.push(diagnostic("snapshot.invalid_revision"));
  if (!Array.isArray(snapshot?.signals) || snapshot.signals.length > MAX_SIGNALS) diagnostics.push(diagnostic("snapshot.signal_limit"));
  if (!Array.isArray(snapshot?.watermarks) || snapshot.watermarks.length > MAX_WATERMARKS) diagnostics.push(diagnostic("snapshot.watermark_limit"));
  const signalKeys = new Set<string>();
  for (const signal of Array.isArray(snapshot?.signals) ? snapshot.signals : []) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      diagnostics.push(diagnostic("snapshot.invalid_signal"));
      continue;
    }
    diagnostics.push(...validateSignal(signal, policy));
    const key = JSON.stringify([signal.sourceId, signal.scopeRef]);
    if (signalKeys.has(key)) diagnostics.push(diagnostic("snapshot.duplicate_signal", "error", { sourceId: signal.sourceId, scopeRef: signal.scopeRef }));
    signalKeys.add(key);
  }
  const watermarkKeys = new Set<string>();
  for (const watermark of Array.isArray(snapshot?.watermarks) ? snapshot.watermarks : []) {
    if (!watermark || typeof watermark !== "object" || Array.isArray(watermark)) {
      diagnostics.push(diagnostic("snapshot.invalid_watermark"));
      continue;
    }
    const key = watermarkKey(watermark);
    if (!safeRevision(watermark.periodSequence) || !safeRevision(watermark.revision)
      || !boundedId(watermark.sourceId, MAX_SCOPE_ALIASES)
      || !boundedId(watermark.scopeRef, MAX_SCOPE_ALIASES)
      || !boundedId(watermark.windowId)
      || !boundedId(watermark.periodId)
      || !(Array.isArray(policy.sources) ? policy.sources : []).some((source) => source?.id === watermark.sourceId && source?.scopeRef === watermark.scopeRef)) {
      diagnostics.push(diagnostic("snapshot.invalid_watermark", "error", { sourceId: watermark.sourceId, scopeRef: watermark.scopeRef, windowId: watermark.windowId }));
    }
    if (watermarkKeys.has(key)) diagnostics.push(diagnostic("snapshot.duplicate_watermark", "error", { sourceId: watermark.sourceId, scopeRef: watermark.scopeRef, windowId: watermark.windowId }));
    watermarkKeys.add(key);
  }
  for (const signal of Array.isArray(snapshot?.signals) ? snapshot.signals : []) {
    if (!signal || typeof signal !== "object" || !Array.isArray(signal.windows)) continue;
    for (const window of signal.windows) {
      if (!window || typeof window !== "object" || !boundedId(window.id)) continue;
      const watermark = (snapshot.watermarks ?? []).find((item) => watermarkKey(item) === watermarkKey({ sourceId: signal.sourceId, scopeRef: signal.scopeRef, windowId: window.id }));
      if (!watermark || watermark.periodId !== window.period.id || watermark.periodSequence !== window.period.sequence || watermark.revision < signal.revision) {
        diagnostics.push(diagnostic("snapshot.watermark_missing", "error", { sourceId: signal.sourceId, scopeRef: signal.scopeRef, windowId: window.id }));
      }
    }
  }
  return diagnostics;
}

export function validateEconomicSnapshot(
  snapshot: EconomicSnapshot,
  policy: ReservePolicy,
  now: number,
): EconomicValidationResult {
  const policyResult = validateEconomicPolicy(policy, { accountDispatch: true });
  if (!policyResult.valid) return policyResult;
  const diagnostics = [...policyResult.diagnostics, ...validateSnapshotShape(snapshot, policy)];
  if (!safeEpoch(now)) diagnostics.push(diagnostic("snapshot.invalid_clock"));
  return { valid: diagnostics.length === 0, diagnostics };
}

export function publishEconomicObservation(
  snapshot: EconomicSnapshot,
  policy: ReservePolicy,
  observation: EconomicSignal,
): PublishObservationResult {
  const validation = validateEconomicPolicy(policy, { accountDispatch: true });
  if (!validation.valid) return { accepted: false, code: "observation_invalid", snapshot, diagnostics: validation.diagnostics };
  const shapeDiagnostics = validateSnapshotShape(snapshot, policy);
  const observationDiagnostics = validateSignal(observation, policy);
  const initialDiagnostics = [...validation.diagnostics, ...shapeDiagnostics, ...observationDiagnostics];
  if (initialDiagnostics.length > 0) {
    return { accepted: false, code: "observation_invalid", snapshot, diagnostics: initialDiagnostics };
  }
  const priorSignal = snapshot.signals.find((signal) => signal.sourceId === observation.sourceId && signal.scopeRef === observation.scopeRef);
  if (priorSignal) {
    if (observation.revision < priorSignal.revision || observation.observedAt < priorSignal.observedAt) {
      return { accepted: false, code: "observation_stale", snapshot, diagnostics: [diagnostic("observation.stale_signal", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef }, REPAIR_OBSERVATION)] };
    }
    if (observation.revision === priorSignal.revision) {
      const duplicate = priorSignal.billing === observation.billing
        && priorSignal.observedAt === observation.observedAt
        && priorSignal.expiresAt === observation.expiresAt
        && stableValue(priorSignal.windows) === stableValue(observation.windows);
      return {
        accepted: false,
        code: duplicate ? "observation_duplicate" : "observation_revision_conflict",
        snapshot,
        diagnostics: [diagnostic(duplicate ? "observation.duplicate" : "observation.equal_revision_conflict", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef }, REPAIR_OBSERVATION)],
      };
    }
  }
  const existingWatermarks = new Map(snapshot.watermarks.map((watermark) => [watermarkKey(watermark), watermark]));
  for (const window of observation.windows) {
    const key = watermarkKey({ sourceId: observation.sourceId, scopeRef: observation.scopeRef, windowId: window.id });
    const previous = existingWatermarks.get(key);
    if (!previous) continue;
    if (window.period.sequence < previous.periodSequence) {
      return { accepted: false, code: "observation_stale", snapshot, diagnostics: [diagnostic("observation.stale_period", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef, windowId: window.id }, REPAIR_OBSERVATION)] };
    }
    if (window.period.sequence === previous.periodSequence && window.period.id !== previous.periodId) {
      return { accepted: false, code: "observation_period_conflict", snapshot, diagnostics: [diagnostic("observation.period_conflict", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef, windowId: window.id }, REPAIR_OBSERVATION)] };
    }
    if (window.period.sequence === previous.periodSequence) {
      if (observation.revision < previous.revision) {
        return { accepted: false, code: "observation_stale", snapshot, diagnostics: [diagnostic("observation.stale_revision", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef, windowId: window.id }, REPAIR_OBSERVATION)] };
      }
    }
  }

  const signalKey = JSON.stringify([observation.sourceId, observation.scopeRef]);
  const signals = snapshot.signals.filter((signal) => JSON.stringify([signal.sourceId, signal.scopeRef]) !== signalKey);
  if (signals.length >= MAX_SIGNALS) {
    return { accepted: false, code: "snapshot_full", snapshot, diagnostics: [diagnostic("snapshot.signal_limit", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef })] };
  }
  const watermarks = snapshot.watermarks.filter((watermark) => !(watermark.sourceId === observation.sourceId && watermark.scopeRef === observation.scopeRef && observation.windows.some((window) => window.id === watermark.windowId)));
  for (const window of observation.windows) {
    watermarks.push({
      sourceId: observation.sourceId,
      scopeRef: observation.scopeRef,
      windowId: window.id,
      periodId: window.period.id,
      periodSequence: window.period.sequence,
      revision: observation.revision,
    });
  }
  if (watermarks.length > MAX_WATERMARKS) {
    return { accepted: false, code: "snapshot_full", snapshot, diagnostics: [diagnostic("snapshot.watermark_limit", "warning", { sourceId: observation.sourceId, scopeRef: observation.scopeRef })] };
  }
  const next: EconomicSnapshot = deepFreeze({
    revision: snapshot.revision + 1,
    signals: [...signals.map(cloneSignal), cloneSignal(observation)],
    watermarks: watermarks.map((watermark) => ({ ...watermark })),
  });
  return { accepted: true, code: "observation_accepted", snapshot: next, diagnostics: [] };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneSignal(signal: EconomicSignal): EconomicSignal {
  return {
    ...signal,
    windows: signal.windows.map((window) => ({ ...window, period: { ...window.period } })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function scopeMatches(scope: EconomicScope, candidate: DispatchScope, capabilities: EconomicHostCapabilities): boolean | "unsupported" {
  if (scope.kind === "model") return scope.model === candidate.model && scope.model.slice(0, scope.model.indexOf("/")) === candidate.provider;
  if (scope.kind === "provider") return scope.provider === candidate.provider;
  if (scope.provider !== candidate.provider) return false;
  if (!capabilities.accountDispatch) return "unsupported";
  const binding = candidate.accountBinding;
  if (!binding) return "unsupported";
  return scope.accountRef === binding.accountRef && scope.epoch === binding.epoch;
}

function windowFresh(signal: EconomicSignal, window: AllowanceWindow, now: number): boolean {
  if (!safeEpoch(now) || now < signal.observedAt || now >= signal.expiresAt) return false;
  return window.resetsAt === undefined || now < window.resetsAt;
}

function unitCompatible(a: AllowanceWindow, b: AllowanceWindow): boolean {
  return a.unit === b.unit && a.currency === b.currency && a.limit === b.limit;
}

function sameComparableFact(a: AllowanceWindow, b: AllowanceWindow): boolean {
  return a.period.id === b.period.id
    && a.period.sequence === b.period.sequence
    && unitCompatible(a, b)
    && a.remaining === b.remaining
    && a.resetsAt === b.resetsAt;
}

type SelectedWindow = { signal: EconomicSignal; window: AllowanceWindow; reason?: ReserveRuleReason };

function selectWindowFact(
  snapshot: EconomicSnapshot,
  policy: ReservePolicy,
  scopeRef: string,
  windowId: string,
  now: number,
): SelectedWindow | ReserveRuleReason {
  const signals = snapshot.signals.filter((signal) => signal.scopeRef === scopeRef && signal.windows.some((window) => window.id === windowId));
  if (signals.length === 0) return "missing_fact";
  const sources = new Map(policy.sources.map((source) => [source.id, source]));
  const fresh = signals.filter((signal) => {
    const window = signal.windows.find((item) => item.id === windowId);
    return Boolean(window && windowFresh(signal, window, now));
  });
  if (fresh.length === 0) return signals.some((signal) => signal.windows.some((window) => window.id === windowId && window.resetsAt !== undefined && now >= window.resetsAt))
    ? "stale_fact"
    : "stale_fact";
  const usable = fresh.flatMap((signal) => {
    const window = signal.windows.find((item) => item.id === windowId);
    const source = sources.get(signal.sourceId);
    return window && source ? [{ signal, window, authority: source.authority }] : [];
  });
  if (usable.length === 0) return "invalid_fact";
  const configuredOrder = ownValue(policy.sourceOrder, scopeRef);
  if (configuredOrder) {
    for (const sourceId of configuredOrder) {
      const chosen = usable.find((entry) => entry.signal.sourceId === sourceId);
      if (chosen) return chosen;
    }
    return "missing_fact";
  }
  const highest = Math.max(...usable.map((entry) => authorityRank[entry.authority]));
  const top = usable.filter((entry) => authorityRank[entry.authority] === highest);
  const [chosen, ...rest] = top;
  if (rest.some((entry) => !sameComparableFact(chosen.window, entry.window))) {
    return chosen.window.period.id !== rest[0]?.window.period.id || chosen.window.period.sequence !== rest[0]?.window.period.sequence
      ? "period_conflict"
      : "source_conflict";
  }
  return chosen;
}

function applyTierOverride(rule: ReserveRule, tier: string, policy: ReservePolicy): ReserveRule {
  const tierOverrides = ownValue(policy.tierOverrides, tier);
  const override = ownValue(tierOverrides, rule.id);
  return override ? { ...rule, ...override } : rule;
}

function effectiveRules(input: EvaluateReservesInput): ReserveRule[] {
  const matched = input.policy.admission.filter((rule) => {
    const scope = ownValue(input.policy.scopes, rule.scopeRef);
    const match = scope && scopeMatches(scope, input.candidate, input.hostCapabilities);
    return match === true || match === "unsupported";
  });
  return matched.map((base) => {
    const requested = applyTierOverride(base, input.requestedTier, input.policy);
    const evaluated = applyTierOverride(base, input.evaluatedTier, input.policy);
    const reserveRatio = Math.max(requested.reserveRatio, evaluated.reserveRatio);
    const unknown: UnknownHandling = requested.unknown === "block" || evaluated.unknown === "block" ? "block" : "ignore";
    return { ...base, reserveRatio, unknown };
  });
}

function evaluateRule(
  rule: ReserveRule,
  input: EvaluateReservesInput,
): ReserveRuleResult {
  const scope = ownValue(input.policy.scopes, rule.scopeRef);
  if (!scope) return { ruleId: rule.id, scopeRef: rule.scopeRef, windowId: rule.windowId, status: "unknown", reason: "invalid_fact", unknownHandling: rule.unknown };
  const matched = scopeMatches(scope, input.candidate, input.hostCapabilities);
  if (matched === "unsupported") return { ruleId: rule.id, scopeRef: rule.scopeRef, windowId: rule.windowId, status: "unknown", reason: "unsupported_scope", unknownHandling: rule.unknown };
  if (!matched) return { ruleId: rule.id, scopeRef: rule.scopeRef, windowId: rule.windowId, status: "pass", reason: "above_reserve", unknownHandling: rule.unknown };
  const selected = selectWindowFact(input.snapshot, input.policy, rule.scopeRef, rule.windowId, input.now);
  if (typeof selected === "string") {
    return { ruleId: rule.id, scopeRef: rule.scopeRef, windowId: rule.windowId, status: "unknown", reason: selected, unknownHandling: rule.unknown };
  }
  const { signal, window } = selected;
  const remainingRatio = window.unit === "ratio"
    ? window.remaining
    : window.limit !== undefined && window.limit > 0 ? window.remaining / window.limit : undefined;
  if (remainingRatio === undefined || !Number.isFinite(remainingRatio)) {
    return { ruleId: rule.id, scopeRef: rule.scopeRef, windowId: rule.windowId, status: "unknown", reason: "invalid_fact", unknownHandling: rule.unknown, sourceId: signal.sourceId, periodId: window.period.id };
  }
  const status = remainingRatio <= rule.reserveRatio ? "reject" : "pass";
  return {
    ruleId: rule.id,
    scopeRef: rule.scopeRef,
    windowId: rule.windowId,
    status,
    reason: status === "reject" ? "reserve_reached" : "above_reserve",
    unknownHandling: rule.unknown,
    sourceId: signal.sourceId,
    periodId: window.period.id,
    remainingRatio,
  };
}

/** Pure reserve evaluation; observation mode never changes route admission. */
export function evaluateReserves(input: EvaluateReservesInput): ReserveEvaluation {
  if (!input || typeof input !== "object" || !input.policy || typeof input.policy !== "object" || !input.snapshot) {
    const mode = input?.policy?.mode === "observe" ? "observe" : "policy";
    return invalidEvaluation(mode, input?.policy);
  }
  const mode = input.policy.mode === "observe" ? "observe" : "policy";
  if (!validDispatchScope(input.candidate)
    || !input.hostCapabilities || typeof input.hostCapabilities !== "object"
    || typeof input.hostCapabilities.accountDispatch !== "boolean"
    || !boundedId(input.requestedTier) || !boundedId(input.evaluatedTier)) return invalidEvaluation(mode, input.policy);
  // An account scope can be a valid declared policy while this host cannot
  // dispatch it. Preserve that as an explicit per-rule unknown result below.
  const policyValidation = validateEconomicPolicy(input.policy, { accountDispatch: true });
  const snapshotValidation = validateSnapshotShape(input.snapshot, input.policy);
  if (policyValidation.diagnostics.length > 0 || snapshotValidation.length > 0 || !safeEpoch(input.now)) {
    const failed = (Array.isArray(input.policy.admission) ? input.policy.admission : []).filter((rule) => rule && typeof rule === "object").map((rule): ReserveRuleResult => ({
      ruleId: safeResultId(rule.id),
      scopeRef: safeResultId(rule.scopeRef),
      windowId: safeResultId(rule.windowId),
      status: "unknown",
      reason: input.policy.scopes && typeof input.policy.scopes === "object"
        && !Array.isArray(input.policy.scopes)
        && Object.hasOwn(input.policy.scopes, rule.scopeRef)
        && !validScope(ownValue(input.policy.scopes, rule.scopeRef) as EconomicScope)
        ? "scope.invalid" : "context.invalid",
      unknownHandling: rule.unknown === "ignore" ? "ignore" : "block",
    }));
    const wouldReject = input.policy.mode === "policy" || failed.some((rule) => rule.unknownHandling === "block");
    return {
      mode: input.policy.mode,
      disposition: input.policy.mode === "observe" ? "observed" : wouldReject ? "rejected" : "unknown_ignored",
      wouldReject,
      results: failed,
    };
  }
  const rules = effectiveRules(input);
  const results = rules.map((rule) => evaluateRule(rule, input));
  const rejected = results.some((result) => result.status === "reject" || (result.status === "unknown" && result.unknownHandling === "block"));
  const ignoredUnknown = results.some((result) => result.status === "unknown" && result.unknownHandling === "ignore");
  const disposition: ReserveEvaluation["disposition"] = input.policy.mode === "observe"
    ? "observed"
    : results.length === 0 ? "no_rules"
      : rejected ? "rejected"
        : ignoredUnknown ? "unknown_ignored" : "admitted";
  return {
    mode: input.policy.mode,
    disposition,
    wouldReject: rejected,
    results,
  };
}
