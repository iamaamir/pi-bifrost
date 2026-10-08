export type AffinityTargetOrigin =
  | "automatic"
  | "explicit_tier"
  | "explicit_model"
  | "pinned"
  | "off"
  | "direct"
  | "continuation"
  | "retry";

export type AffinityMode = "off" | "observe" | "retain-within-tier";
export type AffinitySelection = "strategy" | "retained_anchor" | "no_anchor" | "anchor_not_eligible" | "not_applicable";

export interface AffinityAnchor {
  readonly modelKey: string;
  readonly provider: string;
  readonly lastSuccessfulDispatchAt: number;
}

export interface AffinityObservationInput {
  /** Only "automatic" user routing receives an affinity observation. */
  readonly targetOrigin: string;
  /** The final eligible pool for the actually selected target tier, after fallback and hard filters. */
  readonly eligibleModelKeys: readonly string[];
  readonly baseStrategyWinner?: string;
  readonly anchor?: AffinityAnchor;
  /** Snapshot time; the caller must refresh/revalidate before any later dispatch. */
  readonly snapshotAsOf: number;
  /** Provider identity is reported only when the caller explicitly asks for this advisory fact. */
  readonly includeSameProviderAdvisory?: boolean;
}

export type AffinityObservation =
  | {
    readonly version: 1;
    readonly status: "not_applicable";
    readonly snapshotAsOf: number;
  }
  | {
    readonly version: 1;
    readonly status: "locality_unknown" | "current_eligible" | "switch_required" | "no_route";
    readonly snapshotAsOf: number;
    readonly anchor?: {
      readonly modelKey: string;
      readonly provider: string;
      readonly lastSuccessfulDispatchAt: number;
      readonly ageMs: number;
    };
    readonly baseStrategyWinner?: string;
    readonly baseStrategyComparison: "no_anchor" | "no_selection" | "selected_anchor" | "selected_other";
    /** Same-provider candidate evidence only; it does not claim cache reuse or savings. */
    readonly sameProviderCandidateAvailable?: boolean;
  };

export type AffinityRouteObservation = AffinityObservation & {
  readonly mode: Exclude<AffinityMode, "off">;
  readonly selection: AffinitySelection;
  readonly strategyWinner?: string;
  readonly selectedModel?: string;
  readonly selectedTier?: string;
};

const MAX_MODEL_KEY_LENGTH = 512;
const MAX_PROVIDER_LENGTH = 128;
const MAX_POOL_SIZE = 512;
const MAX_EPOCH = 8.64e15;
const NON_AUTOMATIC_ORIGINS = new Set<AffinityTargetOrigin>([
  "explicit_tier",
  "explicit_model",
  "pinned",
  "off",
  "direct",
  "continuation",
  "retry",
]);

function validEpoch(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_EPOCH;
}

function parseModelKey(value: unknown): { key: string; provider: string } | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MODEL_KEY_LENGTH || value.trim() !== value) {
    return undefined;
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = value.slice(0, separator);
  if (provider.length > MAX_PROVIDER_LENGTH || provider.includes("/")
    || /[\u0000-\u0020\u007f]/u.test(value)) {
    return undefined;
  }
  return { key: value, provider };
}

function invalidInput(): never {
  throw new Error("Invalid affinity observation input.");
}

function validateAutomaticInput(input: AffinityObservationInput): {
  asOf: number;
  eligible: readonly { key: string; provider: string }[];
  baseWinner?: string;
  anchor?: { key: string; provider: string; at: number };
  includeSameProvider: boolean;
} {
  if (!Array.isArray(input.eligibleModelKeys) || input.eligibleModelKeys.length > MAX_POOL_SIZE
    || input.includeSameProviderAdvisory !== undefined && typeof input.includeSameProviderAdvisory !== "boolean") {
    return invalidInput();
  }

  const eligible = input.eligibleModelKeys.map((value) => {
    const parsed = parseModelKey(value);
    if (!parsed) return invalidInput();
    return parsed;
  });
  if (new Set(eligible.map(({ key }) => key)).size !== eligible.length) return invalidInput();

  let baseWinner: string | undefined;
  if (input.baseStrategyWinner !== undefined) {
    const parsed = parseModelKey(input.baseStrategyWinner);
    if (!parsed || !eligible.some(({ key }) => key === parsed.key)) return invalidInput();
    baseWinner = parsed.key;
  }

  let anchor: { key: string; provider: string; at: number } | undefined;
  if (input.anchor !== undefined) {
    const value = input.anchor as AffinityAnchor;
    const parsed = parseModelKey(value?.modelKey);
    if (!parsed || typeof value.provider !== "string" || value.provider !== parsed.provider
      || value.provider.length > MAX_PROVIDER_LENGTH || !validEpoch(value.lastSuccessfulDispatchAt)
      || value.lastSuccessfulDispatchAt > input.snapshotAsOf) {
      return invalidInput();
    }
    anchor = { key: parsed.key, provider: parsed.provider, at: value.lastSuccessfulDispatchAt };
  }

  return {
    asOf: input.snapshotAsOf,
    eligible,
    ...(baseWinner !== undefined ? { baseWinner } : {}),
    ...(anchor ? { anchor } : {}),
    includeSameProvider: input.includeSameProviderAdvisory === true,
  };
}

/** Derive advisory facts from a caller-owned successful-dispatch anchor and final eligible pool. */
export function observeAffinity(input: AffinityObservationInput): AffinityObservation {
  if (!input || typeof input !== "object" || !validEpoch(input.snapshotAsOf)) return invalidInput();
  const asOf = input.snapshotAsOf;
  const origin = input.targetOrigin;
  if (origin !== "automatic" && !NON_AUTOMATIC_ORIGINS.has(origin as AffinityTargetOrigin)) {
    return Object.freeze({ version: 1, status: "not_applicable", snapshotAsOf: asOf });
  }
  if (origin !== "automatic") {
    return Object.freeze({ version: 1, status: "not_applicable", snapshotAsOf: asOf });
  }
  const snapshot = validateAutomaticInput(input);

  const anchor = snapshot.anchor;
  const baseStrategyComparison = !anchor
    ? "no_anchor"
    : snapshot.baseWinner === undefined
      ? "no_selection"
      : snapshot.baseWinner === anchor.key
        ? "selected_anchor"
        : "selected_other";
  if (!anchor) {
    return Object.freeze({
      version: 1,
      status: "locality_unknown",
      snapshotAsOf: snapshot.asOf,
      baseStrategyComparison,
    });
  }

  const currentEligible = snapshot.eligible.some(({ key }) => key === anchor.key);
  const status = snapshot.baseWinner === undefined
    ? "no_route"
    : currentEligible
      ? "current_eligible"
      : "switch_required";
  const sameProviderCandidateAvailable = snapshot.eligible.some(({ provider }) => provider === anchor.provider);
  return Object.freeze({
    version: 1,
    status,
    snapshotAsOf: snapshot.asOf,
    anchor: Object.freeze({
      modelKey: anchor.key,
      provider: anchor.provider,
      lastSuccessfulDispatchAt: anchor.at,
      ageMs: snapshot.asOf - anchor.at,
    }),
    ...(snapshot.baseWinner !== undefined ? { baseStrategyWinner: snapshot.baseWinner } : {}),
    baseStrategyComparison,
    ...(snapshot.includeSameProvider ? { sameProviderCandidateAvailable } : {}),
  });
}
