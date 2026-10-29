import { schemaVersionAtLeast } from "./schema-version.ts";
import { getCircuitState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";
import { isGenerativeModel } from "./virtual-model.ts";
import { evaluateReserves, type EconomicSnapshot, type ReserveEvaluation, type ReservePolicy } from "./economic-signals.ts";
import { projectBillingPreference, type BillingPreferenceProjection } from "./economic-preferences.ts";
import { observeAffinity, type AffinityAnchor, type AffinityMode, type AffinityRouteObservation, type PiAffinityModeSource } from "./affinity.ts";
import { performance } from "node:perf_hooks";
import { checkProviderScope, compileRoutingScope, type CompiledRoutingScope, type RoutingScope, type RoutingScopeOrigin } from "./routing-scope.ts";

export type RoutingStrategy =
  | "first"
  | "cheapest"
  | "cheapest_input"
  | "cheapest_output"
  | "largest_context"
  | "random"
  | "fastest";

export interface RouteRule {
  pattern: string;
  model: string;
}

/**
 * Provider-neutral structural model used by the routing policy. Hosts adapt
 * their model objects to this shape; extra host fields are allowed and
 * preserved through generic inference for host callers.
 */
export interface RoutingModelBase {
  /** Host transport discriminator; hosts may use it to exclude special entries. */
  readonly api?: string;
  readonly type?: string;
  readonly provider: string;
  readonly id: string;
  readonly cost: { input: number; output: number };
  readonly contextWindow: number;
}

export interface RoutingModelRegistry<M extends RoutingModelBase = RoutingModelBase> {
  find(provider: string, modelId: string): M | undefined;
  getAvailable(): M[];
}

export interface RoutingHostContext<M extends RoutingModelBase = RoutingModelBase> {
  modelRegistry: RoutingModelRegistry<M>;
}

export function modelKey(model: RoutingModelBase | undefined): string {
  if (!model) return "none";
  return `${model.provider}/${model.id}`;
}

/** Sum of input + output token costs per 1M tokens. Does not include cache read/write costs. */
export function modelCost(model: RoutingModelBase): number {
  return model.cost.input + model.cost.output;
}

/** Input token cost only. */
export function modelInputCost(model: RoutingModelBase): number {
  return model.cost.input;
}

/** Output token cost only. */
export function modelOutputCost(model: RoutingModelBase): number {
  return model.cost.output;
}

/** Context window size. */
export function modelContextSize(model: RoutingModelBase): number {
  return model.contextWindow;
}

export function findOneModel<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  pattern: string,
): M | undefined {
  if (!pattern) return undefined;

  if (pattern.includes("/")) {
    const [provider, ...idParts] = pattern.split("/");
    const id = idParts.join("/");
    const model = ctx.modelRegistry.find(provider, id);
    return isGenerativeModel(model) ? model : undefined;
  }

  const lower = pattern.toLowerCase();
  const available = ctx.modelRegistry.getAvailable();
  return available.find((m) => isGenerativeModel(m) && modelLowerMatches(m, lower));
}

/** Lowercased id/provider for a model, computed once per model object.
 * Invariant: id/provider are immutable per object identity — registry
 * refresh produces new objects (same assumption as cache.ts entry memo). */
interface ModelLowerMeta {
  readonly lowerId: string;
  readonly lowerProvider: string;
}

const modelLowerCache = new WeakMap<RoutingModelBase, ModelLowerMeta>();

function modelLowerMeta(m: RoutingModelBase): ModelLowerMeta {
  let meta = modelLowerCache.get(m);
  if (!meta) {
    meta = { lowerId: m.id.toLowerCase(), lowerProvider: m.provider.toLowerCase() };
    modelLowerCache.set(m, meta);
  }
  return meta;
}

function modelLowerMatches(m: RoutingModelBase, lower: string): boolean {
  const meta = modelLowerMeta(m);
  return meta.lowerId.includes(lower) || meta.lowerProvider.includes(lower);
}

export type CandidateDiscoveryExclusion = {
  readonly model: string;
  readonly reason: "virtual_model" | "classifier_model";
};

export type UnresolvedCandidatePattern = {
  readonly pattern: string;
  readonly reason: "model_unavailable" | "pattern_unavailable";
};

function findCandidatePool<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  pattern: string | string[] | undefined,
): {
  readonly candidates: M[];
  readonly exclusions: readonly CandidateDiscoveryExclusion[];
  readonly unresolved: readonly UnresolvedCandidatePattern[];
} {
  if (!pattern) return { candidates: [], exclusions: [], unresolved: [] };

  const candidates: M[] = [];
  const exclusions: CandidateDiscoveryExclusion[] = [];
  const unresolved: UnresolvedCandidatePattern[] = [];
  const seen = new Set<string>();
  const seenExclusions = new Set<string>();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  // Resolve once — avoid N getAvailable() calls for N substring patterns.
  const available = ctx.modelRegistry.getAvailable();
  const recordModel = (model: M): void => {
    const key = modelKey(model);
    if (isGenerativeModel(model)) {
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(model);
      }
      return;
    }
    if (!seenExclusions.has(key)) {
      seenExclusions.add(key);
      exclusions.push({ model: key, reason: model.type === "classifier" ? "classifier_model" : "virtual_model" });
    }
  };

  for (const p of patterns) {
    if (p.includes("/")) {
      const [provider, ...idParts] = p.split("/");
      const model = ctx.modelRegistry.find(provider!, idParts.join("/"));
      if (model) recordModel(model);
      else unresolved.push({ pattern: p, reason: "model_unavailable" });
      continue;
    }
    const lower = p.toLowerCase();
    let matched = false;
    for (const model of available) {
      if (!modelLowerMatches(model, lower)) continue;
      matched = true;
      recordModel(model);
    }
    if (!matched) unresolved.push({ pattern: p, reason: "pattern_unavailable" });
  }

  return { candidates, exclusions, unresolved };
}

export function findCandidates<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  pattern: string | string[] | undefined,
): M[] {
  return findCandidatePool(ctx, pattern).candidates;
}

/** First element achieving the minimum score — matches stable-sort[0] tie-breaking.
 * Precondition: scores are finite numbers (Model cost/contextWindow are typed finite).
 * Unlike sort, the score function is not invoked for a single candidate. */
function minBy<T>(items: readonly T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const item of items) {
    const s = score(item);
    if (s < bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Pick one candidate for the configured strategy.
 *
 * Total for every strategy: an empty list yields undefined and every other
 * input, including rng values outside [0, 1) and NaN, yields a candidate.
 */
export function selectModel<M extends RoutingModelBase>(
  candidates: M[],
  strategy: RoutingStrategy,
  random: () => number = Math.random,
): M | undefined {
  if (candidates.length === 0) return undefined;
  // Single candidate — return without scoring, matching the old sort's
  // behavior of never invoking the comparator (cost-less models stay safe).
  if (candidates.length === 1) return candidates[0];

  switch (strategy) {
    case "cheapest":
      return minBy(candidates, modelCost);
    case "cheapest_input":
      return minBy(candidates, modelInputCost);
    case "cheapest_output":
      return minBy(candidates, modelOutputCost);
    case "largest_context":
      // Descending sort picks the first maximum under stable tie-breaking.
      return minBy(candidates, (m) => -modelContextSize(m));
    case "random": {
      // The rng seam is injectable, so selection must stay total for whatever
      // it returns: any value outside [0, 1) (including NaN) picks the last
      // candidate instead of indexing past the array into undefined.
      const pick = random();
      if (!(pick >= 0 && pick < 1)) {
        return candidates[candidates.length - 1];
      }
      return candidates[Math.floor(pick * candidates.length)];
    }
    default:
      // "first", "fastest" — list order is assumed meaningful.
      return candidates[0];
  }
}

export function resolveModel<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
): M | undefined {
  return selectModel(findCandidates(ctx, pattern), strategy);
}

export interface SkippedCandidate {
  key: string;
  reason: "open_circuit" | "trial_active" | "provider_not_allowed";
  openUntil?: number;
  /** Which hard provider restriction rejected this candidate. */
  scope?: RoutingScopeOrigin;
}

export interface HealthyModelResolution<M extends RoutingModelBase = RoutingModelBase> {
  selected: M | undefined;
  candidates: M[];
  healthyCandidates: M[];
  /** Strategy pool after advisory/opt-in billing preference; never an exclusion list. */
  selectionCandidates?: M[];
  billingPreference?: BillingPreferenceProjection;
  skipped: SkippedCandidate[];
  discoveryExclusions: readonly CandidateDiscoveryExclusion[];
  unresolvedPatterns: readonly UnresolvedCandidatePattern[];
  economic?: readonly EconomicCandidateEvaluation[];
}

export interface EconomicCandidateEvaluation {
  readonly key: string;
  readonly evaluation: ReserveEvaluation;
}

export interface EconomicRouteContext {
  readonly snapshot: EconomicSnapshot;
  readonly policy: ReservePolicy;
  readonly requestedTier: string;
  readonly now: number;
  /** Direct model/utility requests retain host semantics and bypass soft preference. */
  readonly preferenceBypassed?: boolean;
}

function selectFromHealthyPool<M extends RoutingModelBase>(
  healthyCandidates: M[],
  strategy: RoutingStrategy,
  random: () => number,
  economic: (EconomicRouteContext & { readonly evaluatedTier: string }) | undefined,
): Pick<HealthyModelResolution<M>, "selected" | "selectionCandidates" | "billingPreference"> {
  if (!economic?.policy.preference || economic.preferenceBypassed) {
    return { selected: selectModel(healthyCandidates, strategy, random), selectionCandidates: healthyCandidates };
  }
  const projection = projectBillingPreference({
    candidates: healthyCandidates.map((candidate) => ({ model: modelKey(candidate), provider: candidate.provider })),
    preferredClass: economic.policy.preference.billingClass,
    snapshot: economic.snapshot,
    policy: economic.policy,
    now: economic.now,
    hostCapabilities: { accountDispatch: false },
  });
  const usePreferredPool = projection.mode === "policy" && projection.preferredCount > 0;
  const selectionKeys = new Set(projection.selectionModelKeys);
  const selectionCandidates = usePreferredPool
    ? healthyCandidates.filter((candidate) => selectionKeys.has(modelKey(candidate)))
    : healthyCandidates;
  return {
    selected: selectModel(selectionCandidates, strategy, random),
    selectionCandidates,
    billingPreference: projection,
  };
}

export interface RoutedModelResolution<M extends RoutingModelBase = RoutingModelBase> {
  requestedTier: string;
  selectedTier?: string;
  fallbackTier?: string;
  selected: M | undefined;
  strategy: RoutingStrategy;
  skipped: SkippedCandidate[];
  fallbackReason?: "requested_tier_unhealthy" | "requested_tier_unavailable" | "requested_tier_excluded" | "requested_tier_provider_excluded" | "all_tiers_exhausted";
  primary: HealthyModelResolution<M>;
  fallback?: HealthyModelResolution<M>;
  /** Ordered pools attempted when an explicit tierPolicies boundary is active. */
  attemptedTiers?: readonly RoutedTierAttempt<M>[];
  explicitBoundary?: boolean;
  affinityObservation?: AffinityRouteObservation;
}

export interface RoutedTierAttempt<M extends RoutingModelBase = RoutingModelBase> {
  tier: string;
  strategy: RoutingStrategy;
  pattern: string | string[] | undefined;
  resolution: HealthyModelResolution<M>;
}

export interface TierResolutionOptions {
  requestedTier: string;
  requestedPattern: string | string[] | undefined;
  requestedStrategy: RoutingStrategy;
  defaultTier?: string;
  defaultPattern?: string | string[] | undefined;
  defaultStrategy?: RoutingStrategy;
}

export interface AffinityRoutingContext {
  /** Caller-supplied origin; intrinsic route origins take precedence. */
  readonly targetOrigin?: string;
  readonly intrinsicOrigin?: string;
  readonly anchor?: AffinityAnchor;
  /** Pi adapter effective mode. Pure resolver callers continue to use config.affinity only. */
  readonly effectiveMode?: AffinityMode;
  readonly modeSource?: PiAffinityModeSource;
}

export interface TierResolutionConfig {
  schemaVersion?: number;
  tierPolicies?: Record<string, { fallbackTiers?: string[] }>;
  models?: Record<string, string | string[]>;
  default?: string;
  strategy?: RoutingStrategy;
  categoryStrategies?: Record<string, RoutingStrategy>;
  affinity?: { mode: AffinityMode; providerAdvisory?: boolean };
  /** Hard provider allowlists; absent preserves legacy behavior. */
  routingScope?: RoutingScope;
}

/** Hard provider scope applied to one pool evaluation. */
export interface RouteScopeContext {
  readonly scope: CompiledRoutingScope;
  /** Tier whose pool is being evaluated, which may be a fallback tier. */
  readonly evaluatedTier: string;
}

export interface ConfiguredTierResolution<M extends RoutingModelBase = RoutingModelBase> {
  options: TierResolutionOptions;
  resolution: RoutedModelResolution<M>;
}

/** Compose configured tier pools and strategies identically for preview and runtime routes. */
export function buildTierResolutionOptions(
  tier: string,
  config: {
    models?: Record<string, string | string[]>;
    categoryStrategies?: Record<string, RoutingStrategy>;
    strategy?: RoutingStrategy;
    default?: string;
  },
): TierResolutionOptions {
  const requestedStrategy = getStrategy(config.categoryStrategies, config.strategy, tier);
  const defaultTier = config.default;
  return {
    requestedTier: tier,
    requestedPattern: config.models?.[tier] ?? tier,
    requestedStrategy,
    ...(defaultTier !== undefined ? { defaultTier } : {}),
    ...(defaultTier
      ? { defaultPattern: config.models?.[defaultTier] ?? defaultTier }
      : {}),
    defaultStrategy: defaultTier
      ? getStrategy(config.categoryStrategies, config.strategy, defaultTier)
      : requestedStrategy,
  };
}

/** Resolve a configured tier and return the exact options used for explanation. */
export function resolveConfiguredTier<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  tier: string,
  config: TierResolutionConfig,
  reliabilityState?: ReliabilityState,
  reliabilityConfig?: ReliabilityConfig,
  now?: number,
  economic?: Omit<EconomicRouteContext, "now" | "requestedTier">,
  random?: () => number,
  affinity?: AffinityRoutingContext,
): ConfiguredTierResolution<M> {
  const options = buildTierResolutionOptions(tier, config);
  const routeNow = now ?? Date.now();
  const economicContext = economic ? { ...economic, requestedTier: tier, now: routeNow } : undefined;
  const scope = compileRoutingScope(config.routingScope);
  const policy = schemaVersionAtLeast(config.schemaVersion, 2) ? config.tierPolicies?.[tier] : undefined;
  const resolution = policy && Array.isArray(policy.fallbackTiers)
    ? resolveWithExplicitTierBoundary(ctx, options, policy.fallbackTiers, config, reliabilityState, reliabilityConfig, routeNow, economicContext, random, scope)
    : resolveModelWithFallback(ctx, { ...options, reliabilityState, reliabilityConfig, now: routeNow, economic: economicContext, random, scope });
  const affinityMode = config.affinity?.mode ?? affinity?.effectiveMode;
  if (affinityMode !== undefined && affinity !== undefined) {
    if (affinityMode === "off") {
      if (!affinity.modeSource) return { options, resolution };
      resolution.affinityObservation = Object.freeze({
        version: 1,
        status: "not_applicable",
        snapshotAsOf: routeNow,
        mode: "off",
        ...(affinity.modeSource ? { modeSource: affinity.modeSource } : {}),
        selection: "not_applicable",
      });
      return { options, resolution };
    }
    const attemptedTarget = resolution.attemptedTiers?.find((attempt) => attempt.resolution.selected)
      ?? resolution.attemptedTiers?.at(-1);
    const targetPool = attemptedTarget?.resolution
      ?? (resolution.selected && resolution.selectedTier === resolution.requestedTier
        ? resolution.primary
        : resolution.fallback ?? resolution.primary);
    const targetOrigin = affinity?.intrinsicOrigin ?? affinity?.targetOrigin ?? "automatic";
    const selectionCandidates = targetPool.selectionCandidates ?? targetPool.healthyCandidates;
    const strategyWinner = resolution.selected ? modelKey(resolution.selected) : undefined;
    let observation: ReturnType<typeof observeAffinity>;
    try {
      observation = observeAffinity({
        targetOrigin,
        eligibleModelKeys: selectionCandidates.map(modelKey),
        ...(strategyWinner ? { baseStrategyWinner: strategyWinner } : {}),
        ...(affinity?.anchor ? { anchor: affinity.anchor } : {}),
        snapshotAsOf: routeNow,
        ...(config.affinity?.providerAdvisory ? { includeSameProviderAdvisory: true } : {}),
      });
    } catch {
      observation = Object.freeze({ version: 1, status: "not_applicable", snapshotAsOf: routeNow });
    }
    let selection: AffinityRouteObservation["selection"] = observation.status === "not_applicable" ? "not_applicable"
      : !affinity.anchor ? "no_anchor" as const : "strategy" as const;
    if (affinityMode === "retain-within-tier" && observation.status !== "not_applicable" && affinity.anchor) {
      const retainedModel = selectionCandidates.find((candidate) => modelKey(candidate) === affinity.anchor!.modelKey);
      if (!retainedModel) {
        selection = "anchor_not_eligible";
      } else if (resolution.selected && strategyWinner !== affinity.anchor.modelKey) {
        resolution.selected = retainedModel;
        targetPool.selected = retainedModel;
        selection = "retained_anchor";
      }
    }
    resolution.affinityObservation = Object.freeze({
      ...observation,
      mode: affinityMode,
      ...(affinity.modeSource ? { modeSource: affinity.modeSource } : {}),
      selection,
      ...(strategyWinner ? { strategyWinner } : {}),
      ...(resolution.selected ? { selectedModel: modelKey(resolution.selected) } : {}),
      ...(resolution.selectedTier ? { selectedTier: resolution.selectedTier } : {}),
    });
  }
  return { options, resolution };
}

export function resolveHealthyModel<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
  economic?: EconomicRouteContext & { readonly evaluatedTier: string },
  random: () => number = Math.random,
  scope?: RouteScopeContext,
): HealthyModelResolution<M> {
  const pool = findCandidatePool(ctx, pattern);
  const configuredCandidates = pool.candidates;
  // Hard provider scope runs first: an excluded provider never reaches
  // economic admission, reliability, affinity, or strategy selection.
  const scopeSkipped: SkippedCandidate[] = [];
  const permittedCandidates = scope
    ? configuredCandidates.filter((candidate) => {
      const decision = checkProviderScope(scope.scope, candidate.provider, {
        tier: scope.evaluatedTier,
      });
      if (decision.allowed) return true;
      scopeSkipped.push({ key: modelKey(candidate), reason: "provider_not_allowed", scope: decision.origin });
      return false;
    })
    : configuredCandidates;
  const economicEvaluations = economic?.policy.admission.length
    ? permittedCandidates.map((candidate): EconomicCandidateEvaluation => {
      const key = modelKey(candidate);
      return {
        key,
        evaluation: evaluateReserves({
          snapshot: economic.snapshot,
          policy: economic.policy,
          candidate: { model: key, provider: candidate.provider },
          requestedTier: economic.requestedTier,
          evaluatedTier: economic.evaluatedTier,
          hostCapabilities: { accountDispatch: false },
          now: economic.now,
        }),
      };
    })
    : undefined;
  const rejected = new Set(economicEvaluations
    ?.filter(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected")
    .map(({ key }) => key) ?? []);
  const candidates = rejected.size > 0
    ? permittedCandidates.filter((candidate) => !rejected.has(modelKey(candidate)))
    : permittedCandidates;
  if (!reliabilityState || reliabilityConfig?.enabled === false) {
    const selection = selectFromHealthyPool(candidates, strategy, random, economic);
    return {
      ...selection,
      candidates: configuredCandidates,
      healthyCandidates: candidates,
      skipped: scopeSkipped,
      discoveryExclusions: pool.exclusions,
      unresolvedPatterns: pool.unresolved,
      ...(economicEvaluations ? { economic: economicEvaluations } : {}),
    };
  }

  const healthyCandidates: M[] = [];
  const skipped: SkippedCandidate[] = [...scopeSkipped];
  for (const candidate of candidates) {
    const circuit = getCircuitState(reliabilityState, modelKey(candidate), now, reliabilityConfig);
    if (circuit.open || circuit.trialActive) {
      skipped.push({
        key: modelKey(candidate),
        reason: circuit.open ? "open_circuit" : "trial_active",
        openUntil: circuit.openUntil,
      });
      continue;
    }
    healthyCandidates.push(candidate);
  }

  const selection = selectFromHealthyPool(healthyCandidates, strategy, random, economic);
  return {
    ...selection,
    candidates: configuredCandidates,
    healthyCandidates,
    skipped,
    discoveryExclusions: pool.exclusions,
    unresolvedPatterns: pool.unresolved,
    ...(economicEvaluations ? { economic: economicEvaluations } : {}),
  };
}

/** Reliability exclusions only; provider scope rejections are reported separately. */
function unreliableSkipped(pool: HealthyModelResolution): number {
  return pool.skipped.filter((candidate) => candidate.reason !== "provider_not_allowed").length;
}

function scopeRejected(pool: HealthyModelResolution): boolean {
  return pool.skipped.some((candidate) => candidate.reason === "provider_not_allowed");
}

/** Distinguish reliability, provider-scope, and reserve exclusions for one pool. */
function tierExclusionReason(
  pool: HealthyModelResolution,
  reserveExcludedPool: boolean,
): RoutedModelResolution["fallbackReason"] {
  if (unreliableSkipped(pool) > 0) return "requested_tier_unhealthy";
  if (scopeRejected(pool)) return "requested_tier_provider_excluded";
  if (reserveExcludedPool) return "requested_tier_excluded";
  return undefined;
}

export function resolveModelWithFallback<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  options: {
    requestedTier: string;
    requestedPattern: string | string[] | undefined;
    requestedStrategy: RoutingStrategy;
    defaultTier?: string;
    defaultPattern?: string | string[] | undefined;
    defaultStrategy?: RoutingStrategy;
    reliabilityState?: ReliabilityState;
    reliabilityConfig?: ReliabilityConfig;
    now?: number;
    economic?: EconomicRouteContext;
    random?: () => number;
    scope?: CompiledRoutingScope;
  },
): RoutedModelResolution<M> {
  const now = options.now ?? Date.now();
  const primary = resolveHealthyModel(
    ctx,
    options.requestedPattern,
    options.requestedStrategy,
    options.reliabilityState,
    options.reliabilityConfig,
    now,
    options.economic ? { ...options.economic, evaluatedTier: options.requestedTier } : undefined,
    options.random,
    options.scope
      ? { scope: options.scope, evaluatedTier: options.requestedTier }
      : undefined,
  );
  if (primary.selected) {
    return {
      requestedTier: options.requestedTier,
      selectedTier: options.requestedTier,
      selected: primary.selected,
      strategy: options.requestedStrategy,
      skipped: primary.skipped,
      primary,
    };
  }

  const unavailable = (pool: HealthyModelResolution<M>): boolean => pool.candidates.length === 0;
  const reserveExcluded = (pool: HealthyModelResolution<M>): boolean =>
    pool.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true;
  const requestedUnavailable = unavailable(primary);
  const requestedExcluded = reserveExcluded(primary);
  const requestedUnreliable = unreliableSkipped(primary);
  const requestedScopeRejected = scopeRejected(primary);
  let fallbackReason: RoutedModelResolution["fallbackReason"] = requestedUnavailable
    ? "requested_tier_unavailable"
    : requestedUnreliable > 0
      ? "requested_tier_unhealthy"
      : requestedScopeRejected
        ? "requested_tier_provider_excluded"
        : requestedExcluded
          ? "requested_tier_excluded"
          : undefined;

  // Compute final reason after evaluating fallback
  const resolveFinalReason = (fb: HealthyModelResolution<M>): RoutedModelResolution<M>["fallbackReason"] => {
    if (fb.selected) return fallbackReason;
    if (requestedUnavailable && primary.skipped.length === 0 && !requestedExcluded && unavailable(fb)) {
      return "requested_tier_unavailable";
    }
    if (unreliableSkipped(fb) > 0 || requestedUnreliable > 0) return "all_tiers_exhausted";
    if (scopeRejected(fb) || requestedScopeRejected) return "requested_tier_provider_excluded";
    if (reserveExcluded(primary) || reserveExcluded(fb)) return "requested_tier_excluded";
    return fallbackReason;
  };

  if (!options.defaultTier || options.defaultTier === options.requestedTier) {
    return {
      requestedTier: options.requestedTier,
      selected: undefined,
      strategy: options.requestedStrategy,
      skipped: primary.skipped,
      fallbackReason,
      primary,
    };
  }

  const fallback = resolveHealthyModel(
    ctx,
    options.defaultPattern,
    options.defaultStrategy ?? options.requestedStrategy,
    options.reliabilityState,
    options.reliabilityConfig,
    now,
    options.economic ? { ...options.economic, evaluatedTier: options.defaultTier } : undefined,
    options.random,
    options.scope
      ? { scope: options.scope, evaluatedTier: options.defaultTier }
      : undefined,
  );

  return {
    requestedTier: options.requestedTier,
    selectedTier: fallback.selected ? options.defaultTier : undefined,
    ...(options.defaultTier ? { fallbackTier: options.defaultTier } : {}),
    selected: fallback.selected,
    strategy: fallback.selected
      ? (options.defaultStrategy ?? options.requestedStrategy)
      : options.requestedStrategy,
    skipped: [...primary.skipped, ...fallback.skipped],
    fallbackReason: resolveFinalReason(fallback),
    primary,
    fallback,
  };
}

function resolveWithExplicitTierBoundary<M extends RoutingModelBase>(
  ctx: RoutingHostContext<M>,
  options: TierResolutionOptions,
  fallbackTiers: readonly string[],
  config: TierResolutionConfig,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
  economic?: EconomicRouteContext,
  random?: () => number,
  scope?: CompiledRoutingScope,
): RoutedModelResolution<M> {
  const tierOptions = [options.requestedTier, ...fallbackTiers].map((tier) => ({
    tier,
    pattern: config.models?.[tier] ?? tier,
    strategy: getStrategy(config.categoryStrategies, config.strategy, tier),
  }));
  const attemptedTiers: RoutedTierAttempt<M>[] = [];
  for (const { tier, pattern, strategy } of tierOptions) {
    const resolution = resolveHealthyModel(ctx, pattern, strategy, reliabilityState, reliabilityConfig, now,
      economic ? { ...economic, evaluatedTier: tier } : undefined, random,
      scope ? { scope, evaluatedTier: tier } : undefined);
    attemptedTiers.push({ tier, strategy, pattern, resolution });
    if (resolution.selected) break;
  }
  const selectedAttempt = attemptedTiers.find(({ resolution }) => resolution.selected);
  const primary = attemptedTiers[0].resolution;
  const primaryReserveExcluded = primary.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true;
  const anyReserveExcluded = attemptedTiers.some(({ resolution }) =>
    resolution.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true);
  const allPoolsUnavailable = attemptedTiers.every(({ resolution }) => resolution.candidates.length === 0 && resolution.skipped.length === 0);
  const anyUnreliable = attemptedTiers.some(({ resolution }) => unreliableSkipped(resolution) > 0);
  const anyScopeRejected = attemptedTiers.some(({ resolution }) => scopeRejected(resolution));
  const primaryExclusion = tierExclusionReason(primary, primaryReserveExcluded);
  const fallbackReason: RoutedModelResolution["fallbackReason"] = selectedAttempt
      ? selectedAttempt.tier === options.requestedTier
        ? undefined
        : primary.candidates.length === 0
          ? "requested_tier_unavailable"
          : primaryExclusion
    : attemptedTiers.length === 1 && primary.skipped.length > 0
      ? primaryExclusion ?? "requested_tier_unhealthy"
    : allPoolsUnavailable
      ? "requested_tier_unavailable"
      : anyUnreliable
        ? "all_tiers_exhausted"
        : anyScopeRejected
          ? "requested_tier_provider_excluded"
          : anyReserveExcluded
            ? "requested_tier_excluded"
            : undefined;
  return {
    requestedTier: options.requestedTier,
    selectedTier: selectedAttempt?.tier,
    selected: selectedAttempt?.resolution.selected,
    strategy: selectedAttempt?.strategy ?? options.requestedStrategy,
    skipped: attemptedTiers.flatMap(({ resolution }) => resolution.skipped),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    primary,
    ...(attemptedTiers[1] ? { fallback: attemptedTiers[1].resolution } : {}),
    attemptedTiers,
    explicitBoundary: true,
  };
}

export function getStrategy(
  categoryStrategies: Record<string, RoutingStrategy> | undefined,
  fallbackStrategy: RoutingStrategy | undefined,
  category: string,
): RoutingStrategy {
  return categoryStrategies?.[category] ?? fallbackStrategy ?? "first";
}

/**
 * Match rules in order, constructing a RegExp per rule per call.
 * @deprecated Production uses `compileRules` + `classifyCompiled`.
 * Kept as the reference implementation for parity tests.
 */
export function classify(text: string, rules: readonly RouteRule[]): string | undefined {
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "i");
      if (patternExceedsBacktrackingBudget(rule.pattern, re)) continue;
      if (re.test(text)) return rule.model;
    } catch (err) {
      console.error(`[bifrost] invalid regex "${rule.pattern}": ${err}`);
    }
  }
  return undefined;
}

/** A route rule with its pattern compiled once. */
export interface CompiledRule {
  readonly re: RegExp;
  readonly model: string;
}

// Rule patterns can arrive from any configuration source, but every match runs
// synchronously on the host event loop, so a pattern that genuinely backtracks
// without bound must be rejected at compile time. Two defenses, cheapest first:
// 1. A structural scan rejects the known superlinear families without running
//    the regular expression at all — quantified groups with unbounded bounds
//    whose body carries another variable quantifier, or ambiguous alternation
//    splits (a branch that is a prefix of another branch, or an empty branch).
//    Execution-free rejection cannot be dodged by anchoring an explosion at
//    the longest probe subject through a lookaround; the scan itself is
//    character work and stays microseconds.
// 2. Canary probes with a small wall-clock budget remain as the backstop for
//    families the structural scan does not name. The check is per canary, and
//    a canary must over-run the budget twice, once on re-measure, before its
//    rule is rejected: one sample can include a scheduler stall, slow
//    matching repeats. Benign rules stay in microseconds on every rung, so
//    they are never rejected.
// Residual limit: the scanner is textual and heuristic (branch overlap is
// compared literally), so a family that hides its shape from the scan and
// stays quiet on canaries ≤ the measured trip points still passes. That
// residual is documented, not silently wide: the scan covers the audit's
// named families (nested quantifier, repeated group, branch overlap).
const BACKTRACKING_BUDGET_MS = 10;
const BACKTRACKING_CANARIES = [
  "a".repeat(10) + "b",
  "a".repeat(14) + "b",
  "a".repeat(18) + "b",
  "a".repeat(20) + "b",
  "a".repeat(22) + "b",
  "a".repeat(24) + "b",
  "ab".repeat(11) + "c",
  "1".repeat(21) + "x",
  "a".repeat(28) + "b",
  "a".repeat(32) + "b",
];

interface BacktrackingFrame {
  /** Positions of one alternation branch, pattern-start to `|` or group end. */
  branches: string[];
  branchStart: number;
  /** The body carries a variable quantifier somewhere inside it. */
  bodyVarQuant: boolean;
}

type QuantifierKind = "none" | "fixed" | "bounded" | "unbounded";

/** Classify the quantifier starting at `position` without executing anything. */
function classifyQuantifier(pattern: string, position: number): QuantifierKind {
  const ch = pattern[position];
  if (ch === "*" || ch === "+") return "unbounded";
  if (ch === "?") return "bounded";
  if (ch !== "{") return "none";
  const close = pattern.indexOf("}", position + 1);
  if (close === -1) return "none";
  const body = pattern.slice(position + 1, close);
  if (!/^\d+(?:,\d*)?$/.test(body)) return "none";
  if (!body.includes(",")) return "fixed";
  const [min, max] = body.split(",");
  if (max === "") return "unbounded";
  return Number(min) === Number(max) ? "fixed" : "bounded";
}

/**
 * First character of a group's body, after its opening syntax.
 *
 * The `?` that introduces `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`,
 * `(?>`, or inline flags is group syntax, not an optional quantifier, and it is
 * not part of the branch text used for overlap detection. Returns undefined for
 * constructs this textual scan does not model, which keeps the scan permissive.
 */
function groupBodyStart(pattern: string, open: number): number | undefined {
  const next = open + 1;
  if (pattern[next] !== "?") return next;
  for (const prefix of ["?:", "?=", "?!", "?>"] as const) {
    if (pattern.startsWith(prefix, next)) return next + 2;
  }
  for (const prefix of ["?<=", "?<!"] as const) {
    if (pattern.startsWith(prefix, next)) return next + 3;
  }
  if (pattern.startsWith("?<", next)) {
    const close = pattern.indexOf(">", next + 2);
    return close === -1 ? undefined : close + 1;
  }
  // Inline flags: (?i:...) or (?im-s:...).
  const colon = pattern.indexOf(":", next + 1);
  return colon !== -1 && /^[a-zA-Z-]*$/.test(pattern.slice(next + 1, colon))
    ? colon + 1
    : undefined;
}

/**
 * Textual detection of superlinear shapes; no regular expression executes.
 * True for a group repeated without a finishing bound whose body carries a
 * variable quantifier, or whose alternation splits a subject ambiguously
 * (a branch that is a prefix of another branch, or an empty branch), regardless
 * of anchors and lookarounds written in front of the group. Bounded repetition
 * and fixed-length tokens keep this false, so fixed-brace rules survive.
 */
function patternHasSuperlinearShape(pattern: string): boolean {
  const frames: BacktrackingFrame[] = [];
  let escape = false;
  let inClass = false;
  const overlaps = (frame: BacktrackingFrame): boolean => frame.branches.some(
    (branch, k) => branch === ""
      || frame.branches.some((other, j) => j !== k && other.startsWith(branch)),
  );
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "(") {
      if (pattern.startsWith("(?#", i)) {
        const end = pattern.indexOf(")", i + 3);
        if (end === -1) return false;
        i = end;
        continue;
      }
      const bodyStart = groupBodyStart(pattern, i);
      if (bodyStart === undefined) return false;
      frames.push({ branches: [], branchStart: bodyStart, bodyVarQuant: false });
      i = bodyStart - 1;
      continue;
    }
    if (ch === "|" && frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      frame.branches.push(pattern.slice(frame.branchStart, i));
      frame.branchStart = i + 1;
      continue;
    }
    if (ch === ")" && frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      frame.branches.push(pattern.slice(frame.branchStart, i));
      if (classifyQuantifier(pattern, i + 1) === "unbounded"
        && (frame.bodyVarQuant || (frame.branches.length > 1 && overlaps(frame)))) {
        return true;
      }
      frames.pop();
      if (frames.length > 0) frames[frames.length - 1]!.bodyVarQuant ||= frame.bodyVarQuant;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      const kind = classifyQuantifier(pattern, i);
      if (kind === "bounded" || kind === "unbounded") {
        if (frames.length > 0) frames[frames.length - 1]!.bodyVarQuant = true;
      }
      if (ch === "{") {
        const close = pattern.indexOf("}", i + 1);
        if (close !== -1) i = close;
      }
    }
  }
  return false;
}

/**
 * True when a rule pattern must be dropped: either the structural scan names a
 * superlinear shape without executing anything, or a canary probe over-runs the
 * budget twice (once to measure, once to rule out a scheduler stall).
 */
function patternExceedsBacktrackingBudget(pattern: string, re: RegExp): boolean {
  if (patternHasSuperlinearShape(pattern)) {
    console.error(`[bifrost] rejecting rule pattern with unbounded backtracking: "${pattern}"`);
    return true;
  }
  try {
    for (const canary of BACKTRACKING_CANARIES) {
      const started = performance.now();
      re.test(canary);
      if (performance.now() - started <= BACKTRACKING_BUDGET_MS) continue;
      // One sample can include a scheduler stall; slow matching repeats, so
      // the same canary must over-run the budget on re-measure as well.
      const recheckStart = performance.now();
      re.test(canary);
      if (performance.now() - recheckStart > BACKTRACKING_BUDGET_MS) {
        console.error(`[bifrost] rejecting rule pattern with unbounded backtracking: "${pattern}"`);
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Compile rules ahead of time; invalid and unbounded patterns are logged once and dropped. */
export function compileRules(rules: readonly RouteRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "i");
      if (patternExceedsBacktrackingBudget(rule.pattern, re)) continue;
      compiled.push({ re, model: rule.model });
    } catch (err) {
      console.error(`[bifrost] invalid regex "${rule.pattern}": ${err}`);
    }
  }
  return compiled;
}

/** Match against precompiled rules — no per-call regex construction. */
export function classifyCompiled(text: string, rules: readonly CompiledRule[]): string | undefined {
  for (const rule of rules) {
    if (rule.re.test(text)) return rule.model;
  }
  return undefined;
}

// ── Tier heuristics ───────────────────────────────────────────

/**
 * Cost thresholds for tier assignment during `/bifrost init`.
 * Models with cost above FRONTIER are suggested as frontier;
 * below QUICK as quick; everything in between as general. Anything
 * still uncategorized the user assigns manually. No name-based
 * guessing — naming conventions change; cost is the stable signal.
 */
const FRONTIER_COST_THRESHOLD = 5; // $/1M tokens (input + output)
const QUICK_COST_THRESHOLD = 1;

/** Assign a model to a tier based solely on token cost. */
export function guessTier(model: RoutingModelBase): "frontier" | "general" | "quick" | undefined {
  const cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
  if (cost > FRONTIER_COST_THRESHOLD) return "frontier";
  if (cost < QUICK_COST_THRESHOLD) return "quick";
  return "general";
}
