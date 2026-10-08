import {
  validateEconomicPolicy,
  validateEconomicSnapshot,
  type BillingMode,
  type DispatchScope,
  type EconomicAuthority,
  type EconomicHostCapabilities,
  type EconomicSignal,
  type EconomicSnapshot,
  type EconomicScope,
  type ReservePolicy,
} from "./economic-signals.ts";

export type PreferredBillingClass = Exclude<BillingMode, "unknown">;
export type BillingPreferenceFreshness =
  | "fresh"
  | "stale"
  | "missing"
  | "conflict"
  | "unsupported_scope"
  | "invalid_context";
export type BillingPreferenceEffect = "preferred" | "baseline" | "would_prefer" | "neutral";

export interface BillingPreferenceInput {
  readonly candidates: readonly DispatchScope[];
  readonly preferredClass?: PreferredBillingClass;
  readonly snapshot: EconomicSnapshot;
  readonly policy: ReservePolicy;
  readonly now: number;
  readonly hostCapabilities?: EconomicHostCapabilities;
}

export interface BillingPreferenceTrace {
  readonly model: string;
  readonly billingClass: BillingMode;
  readonly sourceAliases: readonly string[];
  readonly authorities: readonly EconomicAuthority[];
  readonly freshness: BillingPreferenceFreshness;
  readonly effect: BillingPreferenceEffect;
}

/** Content-free projection; callers map model keys back to their own final pool. */
export interface BillingPreferenceProjection {
  readonly mode: "observe" | "policy";
  readonly preferredClass?: PreferredBillingClass;
  readonly eligibleModelKeys: readonly string[];
  readonly preferredModelKeys: readonly string[];
  readonly selectionModelKeys: readonly string[];
  readonly traces: readonly BillingPreferenceTrace[];
  readonly eligibleCount: number;
  readonly preferredCount: number;
  readonly selectionCount: number;
}

interface ScopeFact {
  readonly billingClass: BillingMode;
  readonly sourceAliases: readonly string[];
  readonly authorities: readonly EconomicAuthority[];
  readonly freshness: BillingPreferenceFreshness;
}

interface ScopeResolution {
  readonly signal?: EconomicSignal;
  readonly freshness: BillingPreferenceFreshness;
}

const AUTHORITY_RANK: Readonly<Record<EconomicAuthority, number>> = {
  authoritative: 3,
  declared: 2,
  estimated: 1,
};
const MAX_EPOCH = 8.64e15;

function safeIdentifier(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function safeModelKey(candidate: DispatchScope): string | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const { model, provider } = candidate;
  if (!safeIdentifier(model, 256) || !safeIdentifier(provider, 128) || provider.includes("/")) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1 || model.slice(0, separator) !== provider) return undefined;
  return model;
}

function candidateScopeValid(candidate: DispatchScope, key: string): boolean {
  if (key !== candidate.model) return false;
  if (candidate.accountBinding === undefined) return true;
  const binding = candidate.accountBinding;
  return Boolean(binding && typeof binding === "object" && !Array.isArray(binding)
    && typeof binding.accountRef === "string" && binding.accountRef.length > 0 && binding.accountRef.length <= 128
    && typeof binding.epoch === "string" && binding.epoch.length > 0 && binding.epoch.length <= 128);
}

function scopeMatch(
  scope: EconomicScope,
  candidate: DispatchScope,
  capabilities: EconomicHostCapabilities,
): boolean | "unsupported" {
  if (scope.kind === "model") return scope.model === candidate.model && scope.model.slice(0, scope.model.indexOf("/")) === candidate.provider;
  if (scope.kind === "provider") return scope.provider === candidate.provider;
  if (scope.provider !== candidate.provider) return false;
  if (!capabilities.accountDispatch || !candidate.accountBinding) return "unsupported";
  return scope.accountRef === candidate.accountBinding.accountRef && scope.epoch === candidate.accountBinding.epoch;
}

function isFresh(signal: EconomicSignal, now: number): boolean {
  return now >= signal.observedAt && now < signal.expiresAt;
}

function resolvedSignal(
  signals: readonly EconomicSignal[],
  authorities: ReadonlyMap<string, EconomicAuthority>,
  sourceOrder: readonly string[] | undefined,
): ScopeResolution {
  if (signals.length === 0) return { freshness: "missing" };
  if (sourceOrder !== undefined) {
    for (const sourceId of sourceOrder) {
      const selected = signals.find((signal) => signal.sourceId === sourceId && signal.billing !== "unknown");
      if (selected) return { signal: selected, freshness: "fresh" };
    }
    return { freshness: "fresh" };
  }

  const highest = Math.max(...signals.map((signal) => AUTHORITY_RANK[authorities.get(signal.sourceId) ?? "estimated"]));
  const top = signals.filter((signal) => AUTHORITY_RANK[authorities.get(signal.sourceId) ?? "estimated"] === highest);
  const first = top[0];
  if (!first) return { freshness: "missing" };
  const unresolved = top.find((signal) => signal.billing === "unknown");
  if (unresolved) return { signal: unresolved, freshness: "fresh" };
  if (top.some((signal) => signal.billing !== first.billing)) return { freshness: "conflict" };
  return { signal: first, freshness: "fresh" };
}

function statusFact(freshness: BillingPreferenceFreshness): ScopeFact {
  return { billingClass: "unknown", sourceAliases: [], authorities: [], freshness };
}

function resolveScopeFact(
  scopeRef: string,
  candidate: DispatchScope,
  input: BillingPreferenceInput,
  capabilities: EconomicHostCapabilities,
): ScopeFact {
  const scope = Object.hasOwn(input.policy.scopes, scopeRef) ? input.policy.scopes[scopeRef] : undefined;
  if (!scope) return statusFact("invalid_context");
  const matches = scopeMatch(scope, candidate, capabilities);
  if (matches === false) return statusFact("missing");
  if (matches === "unsupported") return statusFact("unsupported_scope");

  const sources = input.policy.sources.filter((source) => source.scopeRef === scopeRef);
  const sourceIds = new Set(sources.map((source) => source.id));
  const signals = input.snapshot.signals.filter((signal) => signal.scopeRef === scopeRef && sourceIds.has(signal.sourceId));
  const allSignals = signals;
  const freshSignals = allSignals.filter((signal) => isFresh(signal, input.now));
  if (allSignals.length === 0) return statusFact("missing");
  const authorities = new Map(sources.map((source) => [source.id, source.authority]));
  if (freshSignals.length === 0) {
    const stale = allSignals[0];
    return {
      billingClass: stale?.billing ?? "unknown",
      sourceAliases: stale ? [stale.sourceId] : [],
      authorities: stale ? [authorities.get(stale.sourceId) ?? "estimated"] : [],
      freshness: "stale",
    };
  }
  const sourceOrder = input.policy.sourceOrder && Object.hasOwn(input.policy.sourceOrder, scopeRef)
    ? input.policy.sourceOrder[scopeRef]
    : undefined;
  const resolution = resolvedSignal(freshSignals, authorities, sourceOrder);
  if (resolution.freshness !== "fresh" || !resolution.signal) {
    return {
      ...statusFact(resolution.freshness),
      sourceAliases: resolution.signal ? [resolution.signal.sourceId] : [],
      authorities: resolution.signal ? [authorities.get(resolution.signal.sourceId) ?? "estimated"] : [],
    };
  }
  return {
    billingClass: resolution.signal.billing,
    sourceAliases: [resolution.signal.sourceId],
    authorities: [authorities.get(resolution.signal.sourceId) ?? "estimated"],
    freshness: "fresh",
  };
}

function combineScopeFacts(facts: readonly ScopeFact[]): ScopeFact {
  if (facts.length === 0) return statusFact("missing");
  const unresolved = facts.find((fact) => fact.freshness !== "fresh");
  if (unresolved) {
    return {
      ...statusFact(unresolved.freshness),
      sourceAliases: facts.flatMap((fact) => fact.sourceAliases),
      authorities: facts.flatMap((fact) => fact.authorities),
    };
  }
  if (facts.some((fact) => fact.billingClass === "unknown")) {
    return {
      ...statusFact("fresh"),
      sourceAliases: facts.flatMap((fact) => fact.sourceAliases),
      authorities: facts.flatMap((fact) => fact.authorities),
    };
  }
  const [first, ...rest] = facts;
  if (rest.some((fact) => fact.billingClass !== first.billingClass)) {
    return {
      ...statusFact("conflict"),
      sourceAliases: facts.flatMap((fact) => fact.sourceAliases),
      authorities: facts.flatMap((fact) => fact.authorities),
    };
  }
  return {
    billingClass: first.billingClass,
    sourceAliases: facts.flatMap((fact) => fact.sourceAliases),
    authorities: facts.flatMap((fact) => fact.authorities),
    freshness: "fresh",
  };
}

function candidateFact(candidate: DispatchScope, input: BillingPreferenceInput, capabilities: EconomicHostCapabilities): ScopeFact {
  const facts: ScopeFact[] = [];
  for (const scopeRef of Object.keys(input.policy.scopes)) {
    const scope = input.policy.scopes[scopeRef];
    const matches = scopeMatch(scope, candidate, capabilities);
    if (matches === false) continue;
    facts.push(matches === "unsupported" ? statusFact("unsupported_scope") : resolveScopeFact(scopeRef, candidate, input, capabilities));
  }
  return combineScopeFacts(facts);
}

function freezeProjection(value: BillingPreferenceProjection): BillingPreferenceProjection {
  for (const trace of value.traces) {
    Object.freeze(trace.sourceAliases);
    Object.freeze(trace.authorities);
    Object.freeze(trace);
  }
  Object.freeze(value.traces);
  Object.freeze(value.eligibleModelKeys);
  Object.freeze(value.preferredModelKeys);
  Object.freeze(value.selectionModelKeys);
  return Object.freeze(value);
}

function invalidProjection(input: BillingPreferenceInput): BillingPreferenceProjection {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  const keys = candidates.map((candidate) => safeModelKey(candidate)).filter((key): key is string => key !== undefined);
  return freezeProjection({
    mode: input?.policy?.mode === "observe" ? "observe" : "policy",
    ...(input?.preferredClass === "subscription" || input?.preferredClass === "metered" || input?.preferredClass === "free"
      ? { preferredClass: input.preferredClass } : {}),
    eligibleModelKeys: [...keys],
    preferredModelKeys: [],
    selectionModelKeys: [...keys],
    traces: keys.map((model) => ({
      model,
      billingClass: "unknown",
      sourceAliases: [],
      authorities: [],
      freshness: "invalid_context",
      effect: "neutral",
    })),
    eligibleCount: keys.length,
    preferredCount: 0,
    selectionCount: keys.length,
  });
}

/**
 * Projects an optional billing-class preference over an already-final eligible pool.
 * Observe mode reports would-prefer keys but preserves membership and order exactly.
 */
export function projectBillingPreference(input: BillingPreferenceInput): BillingPreferenceProjection {
  if (!input || typeof input !== "object" || !Array.isArray(input.candidates)
    || !input.snapshot || !input.policy || !Number.isSafeInteger(input.now) || input.now < 0 || input.now > MAX_EPOCH
    || (input.preferredClass !== undefined && !["subscription", "metered", "free"].includes(input.preferredClass))) {
    return invalidProjection(input);
  }

  const keys = input.candidates.map((candidate) => safeModelKey(candidate));
  if (keys.some((key) => key === undefined)
    || new Set(keys).size !== keys.length
    || input.candidates.some((candidate, index) => !candidateScopeValid(candidate, keys[index] ?? ""))) {
    return invalidProjection(input);
  }
  const eligibleModelKeys = keys as string[];
  const mode = input.policy.mode === "observe" ? "observe" : "policy";
  if (input.preferredClass === undefined) {
    return freezeProjection({
      mode,
      eligibleModelKeys: [...eligibleModelKeys],
      preferredModelKeys: [],
      selectionModelKeys: [...eligibleModelKeys],
      traces: [],
      eligibleCount: eligibleModelKeys.length,
      preferredCount: 0,
      selectionCount: eligibleModelKeys.length,
    });
  }

  const capabilities = input.hostCapabilities ?? { accountDispatch: false };
  const structuralPolicy = validateEconomicPolicy(input.policy, { accountDispatch: true });
  const snapshotValidation = structuralPolicy.valid
    ? validateEconomicSnapshot(input.snapshot, input.policy, input.now)
    : structuralPolicy;
  if (!structuralPolicy.valid || !snapshotValidation.valid || typeof capabilities.accountDispatch !== "boolean") {
    return invalidProjection(input);
  }

  const facts = input.candidates.map((candidate) => candidateFact(candidate, input, capabilities));
  const preferredModelKeys = eligibleModelKeys.filter((_, index) => facts[index]?.freshness === "fresh"
    && facts[index]?.billingClass === input.preferredClass);
  const selectionModelKeys = mode === "policy" && preferredModelKeys.length > 0
    ? [...preferredModelKeys]
    : [...eligibleModelKeys];
  const traces = eligibleModelKeys.map((model, index): BillingPreferenceTrace => {
    const fact = facts[index] ?? statusFact("invalid_context");
    const isPreferred = fact.freshness === "fresh" && fact.billingClass === input.preferredClass;
    return {
      model,
      billingClass: fact.billingClass,
      sourceAliases: [...new Set(fact.sourceAliases)],
      authorities: [...new Set(fact.authorities)],
      freshness: fact.freshness,
      effect: isPreferred ? (mode === "observe" ? "would_prefer" : "preferred")
        : mode === "observe" ? "neutral" : "baseline",
    };
  });
  return freezeProjection({
    mode,
    preferredClass: input.preferredClass,
    eligibleModelKeys: [...eligibleModelKeys],
    preferredModelKeys,
    selectionModelKeys,
    traces,
    eligibleCount: eligibleModelKeys.length,
    preferredCount: preferredModelKeys.length,
    selectionCount: selectionModelKeys.length,
  });
}
