import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getCircuitState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";
import { isVirtualModel } from "./virtual-model.ts";
import { evaluateReserves, type EconomicSnapshot, type ReserveEvaluation, type ReservePolicy } from "./economic-signals.ts";
import { projectBillingPreference, type BillingPreferenceProjection } from "./economic-preferences.ts";
import { observeAffinity, type AffinityAnchor, type AffinityMode, type AffinityRouteObservation, type PiAffinityModeSource } from "./affinity.ts";

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

export function modelKey(model: Model<Api> | undefined): string {
  if (!model) return "none";
  return `${model.provider}/${model.id}`;
}

/** Sum of input + output token costs per 1M tokens. Does not include cache read/write costs. */
export function modelCost(model: Model<Api>): number {
  return model.cost.input + model.cost.output;
}

/** Input token cost only. */
export function modelInputCost(model: Model<Api>): number {
  return model.cost.input;
}

/** Output token cost only. */
export function modelOutputCost(model: Model<Api>): number {
  return model.cost.output;
}

/** Context window size. */
export function modelContextSize(model: Model<Api>): number {
  return model.contextWindow;
}

export function findOneModel(
  ctx: ExtensionContext,
  pattern: string,
): Model<Api> | undefined {
  if (!pattern) return undefined;

  if (pattern.includes("/")) {
    const [provider, ...idParts] = pattern.split("/");
    const id = idParts.join("/");
    const model = ctx.modelRegistry.find(provider, id);
    return isVirtualModel(model) ? undefined : model;
  }

  const lower = pattern.toLowerCase();
  const available = ctx.modelRegistry.getAvailable();
  return available.find((m) => !isVirtualModel(m) && modelLowerMatches(m, lower));
}

/** Lowercased id/provider for a model, computed once per model object.
 * Invariant: id/provider are immutable per object identity — registry
 * refresh produces new objects (same assumption as cache.ts entry memo). */
interface ModelLowerMeta {
  readonly lowerId: string;
  readonly lowerProvider: string;
}

const modelLowerCache = new WeakMap<Model<Api>, ModelLowerMeta>();

function modelLowerMeta(m: Model<Api>): ModelLowerMeta {
  let meta = modelLowerCache.get(m);
  if (!meta) {
    meta = { lowerId: m.id.toLowerCase(), lowerProvider: m.provider.toLowerCase() };
    modelLowerCache.set(m, meta);
  }
  return meta;
}

function modelLowerMatches(m: Model<Api>, lower: string): boolean {
  const meta = modelLowerMeta(m);
  return meta.lowerId.includes(lower) || meta.lowerProvider.includes(lower);
}

export function findCandidates(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
): Model<Api>[] {
  if (!pattern) return [];

  const candidates: Model<Api>[] = [];
  const seen = new Set<string>();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  // Resolve once — avoid N getAvailable() calls for N substring patterns.
  const available = ctx.modelRegistry.getAvailable();

  for (const p of patterns) {
    if (p.includes("/")) {
      const model = findOneModel(ctx, p);
      if (model) {
        const key = modelKey(model);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(model);
        }
      }
    } else {
      const lower = p.toLowerCase();
      for (const m of available) {
        // Match test first — modelKey/dedup only run for actual matches.
        if (isVirtualModel(m) || !modelLowerMatches(m, lower)) continue;
        const key = modelKey(m);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(m);
        }
      }
    }
  }

  return candidates;
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

export function selectModel(
  candidates: Model<Api>[],
  strategy: RoutingStrategy,
  random: () => number = Math.random,
): Model<Api> | undefined {
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
    case "random":
      return candidates[Math.floor(random() * candidates.length)];
    default:
      // "first", "fastest" — list order is assumed meaningful.
      return candidates[0];
  }
}

export function resolveModel(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
): Model<Api> | undefined {
  return selectModel(findCandidates(ctx, pattern), strategy);
}

export interface SkippedCandidate {
  key: string;
  reason: "open_circuit" | "trial_active";
  openUntil?: number;
}

export interface HealthyModelResolution {
  selected: Model<Api> | undefined;
  candidates: Model<Api>[];
  healthyCandidates: Model<Api>[];
  /** Strategy pool after advisory/opt-in billing preference; never an exclusion list. */
  selectionCandidates?: Model<Api>[];
  billingPreference?: BillingPreferenceProjection;
  skipped: SkippedCandidate[];
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

function selectFromHealthyPool(
  healthyCandidates: Model<Api>[],
  strategy: RoutingStrategy,
  random: () => number,
  economic: (EconomicRouteContext & { readonly evaluatedTier: string }) | undefined,
): Pick<HealthyModelResolution, "selected" | "selectionCandidates" | "billingPreference"> {
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

export interface RoutedModelResolution {
  requestedTier: string;
  selectedTier?: string;
  selected: Model<Api> | undefined;
  strategy: RoutingStrategy;
  skipped: SkippedCandidate[];
  fallbackReason?: "requested_tier_unhealthy" | "requested_tier_unavailable" | "requested_tier_excluded" | "all_tiers_exhausted";
  primary: HealthyModelResolution;
  fallback?: HealthyModelResolution;
  /** Ordered pools attempted when an explicit tierPolicies boundary is active. */
  attemptedTiers?: readonly RoutedTierAttempt[];
  explicitBoundary?: boolean;
  affinityObservation?: AffinityRouteObservation;
}

export interface RoutedTierAttempt {
  tier: string;
  strategy: RoutingStrategy;
  pattern: string | string[] | undefined;
  resolution: HealthyModelResolution;
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
}

export interface ConfiguredTierResolution {
  options: TierResolutionOptions;
  resolution: RoutedModelResolution;
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
export function resolveConfiguredTier(
  ctx: ExtensionContext,
  tier: string,
  config: TierResolutionConfig,
  reliabilityState?: ReliabilityState,
  reliabilityConfig?: ReliabilityConfig,
  now?: number,
  economic?: Omit<EconomicRouteContext, "now" | "requestedTier">,
  random?: () => number,
  affinity?: AffinityRoutingContext,
): ConfiguredTierResolution {
  const options = buildTierResolutionOptions(tier, config);
  const routeNow = now ?? Date.now();
  const economicContext = economic ? { ...economic, requestedTier: tier, now: routeNow } : undefined;
  const policy = config.schemaVersion === 2 ? config.tierPolicies?.[tier] : undefined;
  const resolution = policy && Array.isArray(policy.fallbackTiers)
    ? resolveWithExplicitTierBoundary(ctx, options, policy.fallbackTiers, config, reliabilityState, reliabilityConfig, routeNow, economicContext, random)
    : resolveModelWithFallback(ctx, { ...options, reliabilityState, reliabilityConfig, now: routeNow, economic: economicContext, random });
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

export function resolveHealthyModel(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
  economic?: EconomicRouteContext & { readonly evaluatedTier: string },
  random: () => number = Math.random,
): HealthyModelResolution {
  const configuredCandidates = findCandidates(ctx, pattern);
  const economicEvaluations = economic?.policy.admission.length
    ? configuredCandidates.map((candidate): EconomicCandidateEvaluation => {
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
    ? configuredCandidates.filter((candidate) => !rejected.has(modelKey(candidate)))
    : configuredCandidates;
  if (!reliabilityState || reliabilityConfig?.enabled === false) {
    const selection = selectFromHealthyPool(candidates, strategy, random, economic);
    return {
      ...selection,
      candidates: configuredCandidates,
      healthyCandidates: candidates,
      skipped: [],
      ...(economicEvaluations ? { economic: economicEvaluations } : {}),
    };
  }

  const healthyCandidates: Model<Api>[] = [];
  const skipped: SkippedCandidate[] = [];
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
    ...(economicEvaluations ? { economic: economicEvaluations } : {}),
  };
}

export function resolveModelWithFallback(
  ctx: ExtensionContext,
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
  },
): RoutedModelResolution {
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

  const unavailable = (pool: HealthyModelResolution): boolean => pool.candidates.length === 0;
  const reserveExcluded = (pool: HealthyModelResolution): boolean =>
    pool.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true;
  const requestedUnavailable = unavailable(primary);
  const requestedExcluded = reserveExcluded(primary);
  let fallbackReason: RoutedModelResolution["fallbackReason"] = requestedUnavailable
    ? "requested_tier_unavailable"
    : requestedExcluded
      ? "requested_tier_excluded"
      : (primary.skipped.length > 0 ? "requested_tier_unhealthy" : undefined);

  // Compute final reason after evaluating fallback
  const resolveFinalReason = (fb: HealthyModelResolution): RoutedModelResolution["fallbackReason"] => {
    if (fb.selected) return fallbackReason;
    if (requestedUnavailable && unavailable(fb)) return "requested_tier_unavailable";
    if (fb.skipped.length > 0 || primary.skipped.length > 0) return "all_tiers_exhausted";
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
  );

  return {
    requestedTier: options.requestedTier,
    selectedTier: fallback.selected ? options.defaultTier : undefined,
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

function resolveWithExplicitTierBoundary(
  ctx: ExtensionContext,
  options: TierResolutionOptions,
  fallbackTiers: readonly string[],
  config: TierResolutionConfig,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
  economic?: EconomicRouteContext,
  random?: () => number,
): RoutedModelResolution {
  const tierOptions = [options.requestedTier, ...fallbackTiers].map((tier) => ({
    tier,
    pattern: config.models?.[tier] ?? tier,
    strategy: getStrategy(config.categoryStrategies, config.strategy, tier),
  }));
  const attemptedTiers: RoutedTierAttempt[] = [];
  for (const { tier, pattern, strategy } of tierOptions) {
    const resolution = resolveHealthyModel(ctx, pattern, strategy, reliabilityState, reliabilityConfig, now,
      economic ? { ...economic, evaluatedTier: tier } : undefined, random);
    attemptedTiers.push({ tier, strategy, pattern, resolution });
    if (resolution.selected) break;
  }
  const selectedAttempt = attemptedTiers.find(({ resolution }) => resolution.selected);
  const primary = attemptedTiers[0].resolution;
  const primaryReserveExcluded = primary.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true;
  const anyReserveExcluded = attemptedTiers.some(({ resolution }) =>
    resolution.economic?.some(({ evaluation }) => evaluation.mode === "policy" && evaluation.disposition === "rejected") === true);
  const allPoolsUnavailable = attemptedTiers.every(({ resolution }) => resolution.candidates.length === 0 && resolution.skipped.length === 0);
  const anySkipped = attemptedTiers.some(({ resolution }) => resolution.skipped.length > 0);
  const fallbackReason: RoutedModelResolution["fallbackReason"] = selectedAttempt
      ? selectedAttempt.tier === options.requestedTier
        ? undefined
        : primary.candidates.length === 0
          ? "requested_tier_unavailable"
          : primary.skipped.length > 0
            ? "requested_tier_unhealthy"
            : primaryReserveExcluded
              ? "requested_tier_excluded"
              : undefined
    : attemptedTiers.length === 1 && primary.skipped.length > 0
      ? "requested_tier_unhealthy"
      : allPoolsUnavailable
        ? "requested_tier_unavailable"
        : anySkipped
          ? "all_tiers_exhausted"
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

/** Compile rules ahead of time; invalid patterns are logged once and dropped. */
export function compileRules(rules: readonly RouteRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    try {
      compiled.push({ re: new RegExp(rule.pattern, "i"), model: rule.model });
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
export function guessTier(model: Model<Api>): "frontier" | "general" | "quick" | undefined {
  const cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
  if (cost > FRONTIER_COST_THRESHOLD) return "frontier";
  if (cost < QUICK_COST_THRESHOLD) return "quick";
  return "general";
}
