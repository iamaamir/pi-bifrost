import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getCircuitState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";

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
    return ctx.modelRegistry.find(provider, id);
  }

  const lower = pattern.toLowerCase();
  const available = ctx.modelRegistry.getAvailable();
  return available.find(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      m.provider.toLowerCase().includes(lower),
  );
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
        if (
          !seen.has(modelKey(m)) &&
          (m.id.toLowerCase().includes(lower) ||
            m.provider.toLowerCase().includes(lower))
        ) {
          seen.add(modelKey(m));
          candidates.push(m);
        }
      }
    }
  }

  return candidates;
}

export function selectModel(
  candidates: Model<Api>[],
  strategy: RoutingStrategy,
): Model<Api> | undefined {
  if (candidates.length === 0) return undefined;

  switch (strategy) {
    case "cheapest":
      return [...candidates].sort((a, b) => modelCost(a) - modelCost(b))[0];
    case "cheapest_input":
      return [...candidates].sort((a, b) => modelInputCost(a) - modelInputCost(b))[0];
    case "cheapest_output":
      return [...candidates].sort((a, b) => modelOutputCost(a) - modelOutputCost(b))[0];
    case "largest_context":
      return [...candidates].sort((a, b) => modelContextSize(b) - modelContextSize(a))[0];
    case "random":
      return candidates[Math.floor(Math.random() * candidates.length)];
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
  reason: "open_circuit";
  openUntil?: number;
}

export interface HealthyModelResolution {
  selected: Model<Api> | undefined;
  candidates: Model<Api>[];
  healthyCandidates: Model<Api>[];
  skipped: SkippedCandidate[];
}

export interface RoutedModelResolution {
  requestedTier: string;
  selectedTier?: string;
  selected: Model<Api> | undefined;
  strategy: RoutingStrategy;
  skipped: SkippedCandidate[];
  fallbackReason?: "requested_tier_unhealthy" | "requested_tier_unavailable";
  primary: HealthyModelResolution;
  fallback?: HealthyModelResolution;
}

export function resolveHealthyModel(
  ctx: ExtensionContext,
  pattern: string | string[] | undefined,
  strategy: RoutingStrategy,
  reliabilityState: ReliabilityState | undefined,
  reliabilityConfig: ReliabilityConfig | undefined,
  now = Date.now(),
): HealthyModelResolution {
  const candidates = findCandidates(ctx, pattern);
  if (!reliabilityState || reliabilityConfig?.enabled === false) {
    return {
      selected: selectModel(candidates, strategy),
      candidates,
      healthyCandidates: candidates,
      skipped: [],
    };
  }

  const healthyCandidates: Model<Api>[] = [];
  const skipped: SkippedCandidate[] = [];
  for (const candidate of candidates) {
    const circuit = getCircuitState(reliabilityState, modelKey(candidate), now, reliabilityConfig);
    if (circuit.open) {
      skipped.push({ key: modelKey(candidate), reason: "open_circuit", openUntil: circuit.openUntil });
      continue;
    }
    healthyCandidates.push(candidate);
  }

  return {
    selected: selectModel(healthyCandidates, strategy),
    candidates,
    healthyCandidates,
    skipped,
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

  const requestedUnavailable = primary.candidates.length === 0;
  const fallbackReason = requestedUnavailable
    ? "requested_tier_unavailable"
    : (primary.skipped.length > 0 ? "requested_tier_unhealthy" : undefined);

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
  );

  return {
    requestedTier: options.requestedTier,
    selectedTier: fallback.selected ? options.defaultTier : undefined,
    selected: fallback.selected,
    strategy: fallback.selected
      ? (options.defaultStrategy ?? options.requestedStrategy)
      : options.requestedStrategy,
    skipped: [...primary.skipped, ...fallback.skipped],
    fallbackReason,
    primary,
    fallback,
  };
}

export function getStrategy(
  categoryStrategies: Record<string, RoutingStrategy> | undefined,
  fallbackStrategy: RoutingStrategy | undefined,
  category: string,
): RoutingStrategy {
  return categoryStrategies?.[category] ?? fallbackStrategy ?? "first";
}

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

// ── Tier heuristics ───────────────────────────────────────────

/**
 * Cost thresholds for tier assignment during `/bifrost init`.
 * Models with cost above FRONTIER are suggested as frontier;
 * below ECONOMICAL as economical. Everything else is uncategorized
 * and the user assigns manually. No name-based guessing — naming
 * conventions change; cost is the stable signal.
 */
const FRONTIER_COST_THRESHOLD = 5; // $/1M tokens (input + output)
const ECONOMICAL_COST_THRESHOLD = 1;

/** Assign a model to a tier based solely on token cost. */
export function guessTier(model: Model<Api>): "frontier" | "economical" | undefined {
  const cost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
  if (cost > FRONTIER_COST_THRESHOLD) return "frontier";
  if (cost < ECONOMICAL_COST_THRESHOLD) return "economical";
  return undefined;
}
