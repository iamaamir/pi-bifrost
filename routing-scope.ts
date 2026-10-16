// ── Provider routing scope ──────────────────────────────────────
// Hard provider allowlists for Bifrost-controlled routing.
//
// A restriction is an eligibility filter only. It is never a
// classification strategy, a model-selection strategy, or an
// economic preference, and it never dispatches anything on its own.
//
// Absent restriction  → that level adds no constraint.
// Present restriction → exact provider-id allowlist; `[]` means deny-all.
//
// Configuration layers compose with intersection, so a later source can
// only narrow a hard restriction. It can never widen one.

export interface RoutingScopeTier {
  providers: string[];
}

/** User-facing `routingScope` configuration shape. */
export interface RoutingScope {
  /** Global provider allowlist. Omitted means no additional global restriction. */
  providers?: string[];
  /** Per-tier provider allowlists keyed by configured tier name. */
  tiers?: Record<string, RoutingScopeTier>;
}

/** Which restriction rejected a candidate. */
export type RoutingScopeOrigin = "global" | "tier";

export interface RoutingScopeDecision {
  readonly allowed: boolean;
  readonly origin?: RoutingScopeOrigin;
}

/** Tier to apply on top of a compiled scope for one pool evaluation. */
export interface RoutingScopeContext {
  /** Tier whose pool is being evaluated, which may be a fallback tier. */
  readonly tier?: string;
}

/** Set-based view of a routing scope, prepared once per resolution. */
export interface CompiledRoutingScope {
  readonly global?: ReadonlySet<string>;
  readonly tiers: ReadonlyMap<string, ReadonlySet<string>>;
}

const ALLOWED: RoutingScopeDecision = Object.freeze({ allowed: true });
const EMPTY_PROVIDERS: ReadonlySet<string> = Object.freeze(new Set<string>());

function providerList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Compile a configured scope for exact provider-id membership checks.
 * Returns undefined when no restriction applies, so callers keep the
 * existing fast path when `routingScope` is absent.
 */
export function compileRoutingScope(
  scope: RoutingScope | undefined,
): CompiledRoutingScope | undefined {
  if (!scope) return undefined;
  const tiers = new Map<string, ReadonlySet<string>>();
  const rawTiers = scope.tiers;
  if (rawTiers && typeof rawTiers === "object" && !Array.isArray(rawTiers)) {
    for (const [tier, entry] of Object.entries(rawTiers)) {
      if (!entry || typeof entry !== "object") continue;
      tiers.set(tier, toProviderSet(entry.providers));
    }
  }
  const global = scope.providers === undefined ? undefined : toProviderSet(scope.providers);
  if (global === undefined && tiers.size === 0) return undefined;
  return Object.freeze({ ...(global !== undefined ? { global } : {}), tiers });
}

/** A present but malformed allowlist stays fail-closed. */
function toProviderSet(value: unknown): ReadonlySet<string> {
  const list = providerList(value);
  if (list === undefined || list.length === 0) return EMPTY_PROVIDERS;
  return new Set(list);
}

/**
 * Exact provider-id eligibility under a compiled scope.
 *
 * A provider must satisfy the global scope and the scope of the tier
 * whose pool is being evaluated. Each pool carries its own tier scope,
 * so a fallback pool is never constrained by the tier that failed.
 * Matching is exact: no case folding, substring, or author inference.
 */
export function checkProviderScope(
  scope: CompiledRoutingScope | undefined,
  provider: string,
  context: RoutingScopeContext = {},
): RoutingScopeDecision {
  if (!scope) return ALLOWED;
  if (scope.global !== undefined && !scope.global.has(provider)) {
    return { allowed: false, origin: "global" };
  }
  const { tier } = context;
  if (tier !== undefined) {
    const tierScope = scope.tiers.get(tier);
    if (tierScope !== undefined && !tierScope.has(provider)) {
      return { allowed: false, origin: "tier" };
    }
  }
  return ALLOWED;
}

/**
 * Compose two configuration-layer scopes by intersection.
 * An omitted restriction adds nothing; an explicit empty one denies all.
 */
export function mergeRoutingScope(
  base: RoutingScope | undefined,
  override: RoutingScope | undefined,
): RoutingScope | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const merged: RoutingScope = {};
  const providers = intersectAllowlist(base.providers, override.providers);
  if (providers !== undefined) merged.providers = providers;
  const tiers = mergeScopeTiers(base.tiers, override.tiers);
  if (tiers !== undefined) merged.tiers = tiers;
  return merged;
}

/**
 * Contradictions introduced by composing two layers: two nonempty
 * allowlists at the same level that share no provider. An intentionally
 * empty allowlist is deny-all, not a contradiction.
 */
export function mergeRoutingScopeConflicts(
  base: RoutingScope | undefined,
  override: RoutingScope | undefined,
): string[] {
  if (!base || !override) return [];
  const conflicts: string[] = [];
  if (disjointNonEmpty(base.providers, override.providers)) {
    conflicts.push("routingScope.providers conflicts with a lower configuration layer; the provider allowlists do not intersect.");
  }
  const overrideTiers = override.tiers;
  if (overrideTiers && typeof overrideTiers === "object") {
    for (const tier of Object.keys(overrideTiers)) {
      const baseEntry = base.tiers?.[tier];
      const overrideEntry = overrideTiers[tier];
      if (disjointNonEmpty(baseEntry?.providers, overrideEntry?.providers)) {
        conflicts.push(`routingScope.tiers.${tier}.providers conflicts with a lower configuration layer; the provider allowlists do not intersect.`);
      }
    }
  }
  return conflicts;
}

/**
 * Contradictions inside one resolved scope: a nonempty global allowlist
 * and a nonempty tier allowlist that share no provider. Tier scope can
 * only narrow the global scope, so an empty intersection is a mistake.
 */
export function routingScopeConflicts(scope: RoutingScope | undefined): string[] {
  if (!scope) return [];
  const global = providerList(scope.providers);
  if (global === undefined || global.length === 0) return [];
  const globalSet = new Set(global);
  const conflicts: string[] = [];
  const tiers = scope.tiers;
  if (!tiers || typeof tiers !== "object") return conflicts;
  for (const [tier, entry] of Object.entries(tiers)) {
    const tierProviders = providerList(entry?.providers);
    if (tierProviders === undefined || tierProviders.length === 0) continue;
    if (!tierProviders.some((provider) => globalSet.has(provider))) {
      conflicts.push(`routingScope.providers and routingScope.tiers.${tier}.providers do not intersect; no provider is allowed for tier "${tier}".`);
    }
  }
  return conflicts;
}

function intersectAllowlist(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): string[] | undefined {
  if (base === undefined) return override === undefined ? undefined : [...override];
  if (override === undefined) return [...base];
  const overrideSet = new Set(override);
  return base.filter((provider) => overrideSet.has(provider));
}

function mergeScopeTiers(
  base: Record<string, RoutingScopeTier> | undefined,
  override: Record<string, RoutingScopeTier> | undefined,
): Record<string, RoutingScopeTier> | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: Record<string, RoutingScopeTier> = {};
  for (const tier of new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})])) {
    const baseEntry = base?.[tier];
    const overrideEntry = override?.[tier];
    if (baseEntry === undefined || overrideEntry === undefined) {
      merged[tier] = baseEntry ?? overrideEntry!;
      continue;
    }
    const providers = intersectAllowlist(baseEntry.providers, overrideEntry.providers);
    merged[tier] = providers === undefined ? { ...baseEntry } : { providers };
  }
  return merged;
}

function disjointNonEmpty(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): boolean {
  if (!Array.isArray(base) || base.length === 0) return false;
  if (!Array.isArray(override) || override.length === 0) return false;
  const overrideSet = new Set(override);
  return !base.some((provider) => overrideSet.has(provider));
}
