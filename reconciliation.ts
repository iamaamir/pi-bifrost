/** Pure proposal builder for explicitly owned generated model memberships. */

export type DiscoveryStatus = "complete" | "partial" | "stale" | "auth_failed";

export interface ReconciliationInventory {
  readonly sourceId: string;
  readonly revision: string;
  readonly status: DiscoveryStatus;
  /** False disables this generated source. Removals still require complete inventory. */
  readonly enabled: boolean;
  readonly modelsByTier: Readonly<Record<string, readonly string[]>>;
}

/**
 * Per-provider generated membership derived for one reconciliation pass.
 * This view is never persisted; the stored payload is `ReconciliationOwnershipSnapshot`.
 */
export interface ReconciliationOwnershipView {
  readonly sources: Readonly<Record<string, {
    readonly generated: Readonly<Record<string, readonly string[]>>;
  }>>;
}

export type OwnershipScope = "project" | "workspace" | "user";

/**
 * Stored ownership payload (v2). A tier is Bifrost-managed only while the
 * configured pool exactly equals its ordered `models` snapshot.
 *
 * A tier modified in any way (add, remove, reorder, empty, delete) loses its
 * snapshot and retains a user marker. `deleted` records deliberate removal so
 * Keep and Merge cannot recreate the tier; an explicit Bifrost-defaults reset
 * may restore it.
 */
export type ReconciliationOwnershipTier =
  | { readonly state: "generated"; readonly models: readonly string[] }
  | { readonly state: "user" | "deleted" };

export type ConfiguredTierPool = string | readonly string[];

export interface ReconciliationOwnershipSnapshot {
  readonly version: 2;
  readonly scope: OwnershipScope;
  readonly tiers: Readonly<Record<string, ReconciliationOwnershipTier>>;
}

/** Which side owns a tier right now, judged against the configured pool. */
export type TierOwnership = "managed" | "user" | "deleted" | "absent";

export interface ReconciliationInput {
  readonly configDigest: string;
  /** Null means no ownership sidecar exists yet. */
  readonly ownershipRevision: string | null;
  readonly ownership?: ReconciliationOwnershipView;
  /** Configured patterns remain opaque and are never adopted as owned membership. */
  readonly configuredModels: Readonly<Record<string, string | readonly string[]>>;
  readonly inventory: ReconciliationInventory;
}

export type ReconciliationWarningCode =
  | "inventory_incomplete"
  | "removal_suppressed"
  | "manual_entry_collision"
  | "ownership_uninitialized"
  | "tier_user_managed";

export interface ReconciliationChange {
  readonly kind: "add" | "remove";
  readonly disposition: "apply" | "advisory";
  readonly tier: string;
  readonly modelKey: string;
}

export interface ReconciliationProposal {
  readonly version: 1;
  readonly status: "ready" | "advisory" | "invalid";
  readonly sourceId?: string;
  readonly sourceRevision?: string;
  readonly expectedConfigDigest?: string;
  readonly expectedOwnershipRevision?: string | null;
  readonly changes: readonly ReconciliationChange[];
  readonly warnings: readonly ReconciliationWarningCode[];
}

const MAX_TEXT = 256;
const MAX_TIERS = 100;
const MAX_MODELS_PER_TIER = 5_000;
const MAX_SOURCES = 1_000;
const MAX_OWNED_MEMBERSHIPS = 50_000;
const OPAQUE_TOKEN = /^[A-Za-z0-9._:-]+$/u;

function opaqueToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && OPAQUE_TOKEN.test(value);
}

function validTier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validModelKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1 && !value.slice(0, separator).includes("/");
}

function own(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function samePool(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Which side owns this tier right now, judged against the configured pool. */
export function tierOwnership(
  snapshot: ReconciliationOwnershipSnapshot | undefined,
  tier: string,
  pool: ConfiguredTierPool | undefined,
): TierOwnership {
  const entry = snapshot && own(snapshot.tiers, tier) ? snapshot.tiers[tier] : undefined;
  if (pool === undefined) return entry ? "deleted" : "absent";
  if (!entry || entry.state !== "generated" || typeof pool === "string") return "user";
  return samePool(entry.models, pool) ? "managed" : "user";
}

function ownedEntryMembershipCount(tier: string, rawEntry: unknown): number {
  if (!validTier(tier) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return -1;
  const entry = rawEntry as Record<string, unknown>;
  if (entry.state !== "generated" && entry.state !== "deleted" && entry.state !== "user") return -1;
  const entryKeys = Object.keys(entry);
  if (entry.state !== "generated") return entryKeys.length === 1 ? 0 : -1;
  if (entryKeys.length !== 2 || !own(entry, "models")) return -1;
  if (!Array.isArray(entry.models) || entry.models.length > MAX_MODELS_PER_TIER) return -1;
  for (const modelKey of entry.models) if (!validModelKey(modelKey) || modelKey.includes("*")) return -1;
  if (new Set(entry.models).size !== entry.models.length) return -1;
  return entry.models.length;
}

/** Validates a stored v2 payload. Legacy v1 bytes are handled by the store, not here. */
export function parseOwnershipSnapshot(value: unknown): ReconciliationOwnershipSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !["version", "scope", "tiers"].every((key) => own(record, key))) return undefined;
  if (record.version !== 2 || !["project", "workspace", "user"].includes(record.scope as string)) return undefined;
  if (!record.tiers || typeof record.tiers !== "object" || Array.isArray(record.tiers)) return undefined;
  const tiers = Object.entries(record.tiers as Record<string, unknown>);
  if (tiers.length > MAX_TIERS) return undefined;
  let total = 0;
  for (const [tier, rawEntry] of tiers) {
    const count = ownedEntryMembershipCount(tier, rawEntry);
    if (count < 0) return undefined;
    total += count;
    if (total > MAX_OWNED_MEMBERSHIPS) return undefined;
  }
  return value as ReconciliationOwnershipSnapshot;
}

/**
 * Recomputes the stored snapshot after a write. `managedTiers` are the tiers
 * this pass may own; every other tier retains generation only while unchanged.
 * User markers survive edits so later deletion cannot look like a new tier.
 */
export function deriveOwnershipSnapshot(input: {
  readonly scope: OwnershipScope;
  readonly previous: ReconciliationOwnershipSnapshot | undefined;
  readonly before: Readonly<Record<string, ConfiguredTierPool>>;
  readonly after: Readonly<Record<string, ConfiguredTierPool>>;
  readonly managedTiers: ReadonlySet<string>;
}): ReconciliationOwnershipSnapshot {
  const tiers: Record<string, ReconciliationOwnershipTier> = {};
  const setTier = (tier: string, value: ReconciliationOwnershipTier) => {
    Object.defineProperty(tiers, tier, { value, enumerable: true, configurable: true, writable: true });
  };
  const previous = input.previous?.scope === input.scope ? input.previous : undefined;
  const names = new Set([...Object.keys(previous?.tiers ?? {}), ...Object.keys(input.before), ...Object.keys(input.after)]);
  for (const tier of names) {
    const before = own(input.before, tier) ? input.before[tier] : undefined;
    const after = own(input.after, tier) ? input.after[tier] : undefined;
    if (after === undefined) {
      setTier(tier, { state: "deleted" });
    } else if (typeof after !== "string" && (input.managedTiers.has(tier)
      || tierOwnership(previous, tier, before) === "managed"
        && typeof before !== "string" && before !== undefined && samePool(before, after))) {
      setTier(tier, { state: "generated", models: [...after] });
    } else {
      setTier(tier, { state: "user" });
    }
  }
  return Object.freeze({
    version: 2,
    scope: input.scope,
    tiers: Object.freeze(tiers),
  });
}

/**
 * Provider-scoped generated membership derived from the whole-tier snapshot.
 * Returns undefined when the tier is not trustworthy, so callers protect it.
 */
export function providerMembershipView(
  snapshot: ReconciliationOwnershipSnapshot,
  tier: string,
  provider: string,
  sourceId: string,
): ReconciliationOwnershipView | undefined {
  if (!own(snapshot.tiers, tier)) return undefined;
  const entry = snapshot.tiers[tier];
  if (!entry || entry.state !== "generated") return undefined;
  const prefix = `${provider}/`;
  return {
    sources: {
      [sourceId]: {
        generated: { [tier]: (entry.models ?? []).filter((key) => key.startsWith(prefix)) },
      },
    },
  };
}

function invalidProposal(): ReconciliationProposal {
  return Object.freeze({
    version: 1,
    status: "invalid",
    changes: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function validateModelTiers(value: unknown, allowPatterns: boolean): Map<string, Set<string>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tiers = Object.entries(value);
  if (tiers.length > MAX_TIERS) return undefined;
  const output = new Map<string, Set<string>>();
  for (const [tier, rawModels] of tiers) {
    if (!validTier(tier)) return undefined;
    const models = Array.isArray(rawModels) ? rawModels : allowPatterns && typeof rawModels === "string" ? [rawModels] : undefined;
    if (!models || models.length > MAX_MODELS_PER_TIER) return undefined;
    const entries = new Set<string>();
    for (const model of models) {
      if (typeof model !== "string" || model.length === 0 || model.length > 512
        || model.trim() !== model || /[\u0000-\u001f\u007f]/u.test(model)
        || !allowPatterns && !validModelKey(model)) return undefined;
      entries.add(model);
    }
    output.set(tier, entries);
  }
  return output;
}

function sourceOwnership(
  view: ReconciliationOwnershipView | undefined,
  sourceId: string,
): { generated: Map<string, Set<string>> } | undefined {
  if (!view) return { generated: new Map() };
  if (!view.sources || typeof view.sources !== "object" || Array.isArray(view.sources)) return undefined;
  const sourceIds = Object.keys(view.sources);
  if (sourceIds.length > MAX_SOURCES) return undefined;
  const claims = new Map<string, string>();
  let totalMemberships = 0;
  let current: { generated: Map<string, Set<string>> } | undefined;
  for (const ownerId of sourceIds) {
    if (!opaqueToken(ownerId)) return undefined;
    const source = view.sources[ownerId];
    if (!source || typeof source !== "object") return undefined;
    const generated = validateModelTiers(source.generated, false);
    if (!generated) return undefined;
    for (const [tier, models] of generated) {
      for (const modelKey of models) {
        totalMemberships++;
        const key = `${tier}\u0000${modelKey}`;
        const priorOwner = claims.get(key);
        if (priorOwner !== undefined && priorOwner !== ownerId) return undefined;
        claims.set(key, ownerId);
      }
    }
    if (totalMemberships > MAX_OWNED_MEMBERSHIPS) return undefined;
    if (ownerId === sourceId) current = { generated };
  }
  return current ?? { generated: new Map() };
}

function freezeProposal(
  status: ReconciliationProposal["status"],
  input: ReconciliationInput,
  changes: ReconciliationChange[],
  warnings: Set<ReconciliationWarningCode>,
): ReconciliationProposal {
  const frozenChanges = Object.freeze(changes.map((change) => Object.freeze({ ...change })));
  return Object.freeze({
    version: 1,
    status,
    sourceId: input.inventory.sourceId,
    sourceRevision: input.inventory.revision,
    expectedConfigDigest: input.configDigest,
    expectedOwnershipRevision: input.ownershipRevision,
    changes: frozenChanges,
    warnings: Object.freeze([...warnings].sort()),
  });
}

/** Computes a content-free, explicit proposal. It performs no discovery, selection, RNG, or writes. */
export function proposeReconciliation(input: ReconciliationInput): ReconciliationProposal {
  if (!input || typeof input !== "object") return invalidProposal();
  const inventory = input.inventory;
  if (!inventory || typeof inventory !== "object"
    || !opaqueToken(input.configDigest)
    || input.ownershipRevision !== null && !opaqueToken(input.ownershipRevision)
    || !opaqueToken(inventory.sourceId)
    || !opaqueToken(inventory.revision)
    || !["complete", "partial", "stale", "auth_failed"].includes(inventory.status)
    || typeof inventory.enabled !== "boolean") return invalidProposal();

  const configured = validateModelTiers(input.configuredModels, true);
  const desired = validateModelTiers(inventory.modelsByTier, false);
  const owned = sourceOwnership(input.ownership, inventory.sourceId);
  if (!configured || !desired || !owned) return invalidProposal();

  const complete = inventory.status === "complete";
  const changes: ReconciliationChange[] = [];
  const warnings = new Set<ReconciliationWarningCode>();
  const addedOrKept = new Set<string>();
  const tuple = (tier: string, model: string) => `${tier}\u0000${model}`;

  if (!input.ownership || !own(input.ownership.sources, inventory.sourceId)) {
    warnings.add("ownership_uninitialized");
  }
  if (!complete) warnings.add("inventory_incomplete");

  // Propose exact additions from this source only. Existing unowned config values remain manual.
  if (inventory.enabled) {
    for (const [tier, models] of desired) {
      const configuredTier = configured.get(tier) ?? new Set<string>();
      const generatedTier = owned.generated.get(tier) ?? new Set<string>();
      for (const modelKey of models) {
        const key = tuple(tier, modelKey);
        if (generatedTier.has(modelKey)) {
          if (configuredTier.has(modelKey)) addedOrKept.add(key);
          continue;
        }
        if (configuredTier.has(modelKey)) {
          warnings.add("manual_entry_collision");
          continue;
        }
        changes.push({ kind: "add", disposition: complete ? "apply" : "advisory", tier, modelKey });
      }
    }
  }

  // Only a complete inventory can establish that previously generated membership is obsolete.
  for (const [tier, models] of owned.generated) {
    const configuredTier = configured.get(tier) ?? new Set<string>();
    const desiredTier = inventory.enabled ? desired.get(tier) ?? new Set<string>() : new Set<string>();
    for (const modelKey of models) {
      if (addedOrKept.has(tuple(tier, modelKey))) continue;
      if (!configuredTier.has(modelKey)) continue; // Already removed by a human; do not rewrite it.
      if (!complete) {
        warnings.add("removal_suppressed");
        continue;
      }
      if (desiredTier.has(modelKey)) continue;
      changes.push({ kind: "remove", disposition: "apply", tier, modelKey });
    }
  }

  return freezeProposal(complete ? "ready" : "advisory", input, changes, warnings);
}
