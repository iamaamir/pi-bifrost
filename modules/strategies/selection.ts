/**
 * Built-in model-selection strategies.
 *
 * This capability owns the closed set of built-in strategy names, their single
 * canonical order, the documented cost/context metrics and the final pick over
 * an ordered candidate pool. It deliberately owns nothing else: candidate
 * discovery, tiers, provider eligibility, sign-in, reserves, billing
 * preference, reliability, affinity, fallback, routing rules and dispatch stay
 * with their existing owners.
 *
 * Inputs are host-neutral structural values, so the capability is directly
 * executable without initializing a host runtime, and it performs no I/O,
 * allocation of candidates, reordering or dispatch.
 */

export type RoutingStrategy =
  | "first"
  | "cheapest"
  | "cheapest_input"
  | "cheapest_output"
  | "largest_context"
  | "random"
  | "best_value"
  | "fastest";

/** The single ordered definition of the built-in strategies. */
export const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  "first",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "best_value",
  "fastest",
];

/**
 * The minimal shape a selection candidate must expose. Hosts keep their own
 * richer model objects; generic inference preserves identity and extra fields.
 */
export interface StrategyCandidate {
  readonly cost: { input: number; output: number };
  readonly contextWindow: number;
}

/** Sum of input + output token costs per 1M tokens. Does not include cache read/write costs. */
export function modelCost(model: StrategyCandidate): number {
  return model.cost.input + model.cost.output;
}

/** Input token cost only. */
export function modelInputCost(model: StrategyCandidate): number {
  return model.cost.input;
}

/** Output token cost only. */
export function modelOutputCost(model: StrategyCandidate): number {
  return model.cost.output;
}

/** Context window size. */
export function modelContextSize(model: StrategyCandidate): number {
  return model.contextWindow;
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
 * Empty input yields undefined, and a single candidate is returned without
 * scoring or drawing. Beyond that the result is a member of the supplied pool
 * when the metric scores are finite; non-finite scores (NaN, Infinity, an
 * overflowing cost sum, or 0/0 for best_value) leave no comparable minimum and
 * yield undefined rather than an invented candidate. Callers supply validated
 * finite metrics; missing cost objects are a caller error and throw.
 */
export function selectModel<M extends StrategyCandidate>(
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

    case "best_value":
      // Maximize context per dollar: minimize cost per context token.
      return minBy(candidates, (m) => modelCost(m) / m.contextWindow);
    default:
      // "first", "fastest" — list order is assumed meaningful.
      return candidates[0];
  }
}
