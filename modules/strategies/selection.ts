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

/**
 * The canonical order of the built-in strategy names. This array is the single
 * definition: the union below is derived from it, so a name cannot exist in one
 * place and not the other.
 */
const STRATEGY_NAMES = [
  "first",
  "cheapest",
  "cheapest_input",
  "cheapest_output",
  "largest_context",
  "random",
  "best_value",
  "fastest",
] as const;

export type RoutingStrategy = (typeof STRATEGY_NAMES)[number];

/** The single ordered definition of the built-in strategies. */
export const ALL_STRATEGIES: readonly RoutingStrategy[] = STRATEGY_NAMES;

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

/**
 * First element with the lowest score. The running minimum starts at
 * `+Infinity` and a score only wins when it is strictly below that minimum, so
 * the observable rules for non-finite scores follow from the comparison:
 *
 * - `-Infinity` always wins (the earliest such element);
 * - `NaN` never wins, because every comparison against it is false;
 * - `+Infinity` (including an overflowed cost sum) never wins;
 * - a finite score wins over `NaN` and `+Infinity` wherever they appear.
 *
 * Ties keep the earliest element — matches stable-sort[0] tie-breaking. When no
 * score is below `+Infinity` the result is undefined. Unlike sort, the score
 * function is not invoked for a single candidate. */
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
 * scoring or drawing. Otherwise the scan keeps the first candidate whose score
 * is strictly below the running minimum, which starts at `+Infinity`: a finite
 * score wins over `NaN` and `+Infinity` (including an overflowing cost sum),
 * `NaN` never wins, and `-Infinity` always wins. If every score is `NaN` or
 * `+Infinity` (including 0/0 for best_value) nothing is below the running
 * minimum and the result is undefined rather than an invented candidate;
 * otherwise it is a member of the supplied pool. Callers supply validated
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
