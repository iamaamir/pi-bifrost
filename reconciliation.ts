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

export interface ReconciliationOwnershipSource {
  readonly generated: Readonly<Record<string, readonly string[]>>;
  readonly tombstones: Readonly<Record<string, readonly string[]>>;
}

export interface ReconciliationOwnershipSnapshot {
  readonly version: 1;
  readonly sources: Readonly<Record<string, ReconciliationOwnershipSource>>;
}

export interface ReconciliationInput {
  readonly configDigest: string;
  /** Null means no ownership sidecar exists yet. */
  readonly ownershipRevision: string | null;
  readonly ownership?: ReconciliationOwnershipSnapshot;
  /** Configured patterns remain opaque and are never adopted as owned membership. */
  readonly configuredModels: Readonly<Record<string, string | readonly string[]>>;
  readonly inventory: ReconciliationInventory;
}

export type ReconciliationWarningCode =
  | "inventory_incomplete"
  | "removal_suppressed"
  | "manual_entry_collision"
  | "user_removal_tombstoned"
  | "ownership_uninitialized";

export interface ReconciliationChange {
  readonly kind: "add" | "remove";
  readonly disposition: "apply" | "advisory";
  readonly tier: string;
  readonly modelKey: string;
}

export interface ReconciliationOwnershipChange {
  readonly kind: "claim" | "unclaim" | "tombstone";
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
  readonly ownershipChanges: readonly ReconciliationOwnershipChange[];
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

function invalidProposal(): ReconciliationProposal {
  return Object.freeze({
    version: 1,
    status: "invalid",
    changes: Object.freeze([]),
    ownershipChanges: Object.freeze([]),
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
  snapshot: ReconciliationOwnershipSnapshot | undefined,
  sourceId: string,
): { generated: Map<string, Set<string>>; tombstones: Map<string, Set<string>> } | undefined {
  if (!snapshot) return { generated: new Map(), tombstones: new Map() };
  if (snapshot.version !== 1 || !snapshot.sources || typeof snapshot.sources !== "object" || Array.isArray(snapshot.sources)) return undefined;
  const sourceIds = Object.keys(snapshot.sources);
  if (sourceIds.length > MAX_SOURCES) return undefined;
  const claims = new Map<string, string>();
  let totalMemberships = 0;
  let current: { generated: Map<string, Set<string>>; tombstones: Map<string, Set<string>> } | undefined;
  for (const ownerId of sourceIds) {
    if (!opaqueToken(ownerId)) return undefined;
    const source = snapshot.sources[ownerId];
    if (!source || typeof source !== "object") return undefined;
    const generated = validateModelTiers(source.generated, false);
    const tombstones = validateModelTiers(source.tombstones, false);
    if (!generated || !tombstones) return undefined;
    for (const [tier, models] of generated) {
      for (const modelKey of models) {
        totalMemberships++;
        const key = `${tier}\u0000${modelKey}`;
        const priorOwner = claims.get(key);
        if (priorOwner !== undefined && priorOwner !== ownerId) return undefined;
        claims.set(key, ownerId);
      }
    }
    totalMemberships += [...tombstones.values()].reduce((count, models) => count + models.size, 0);
    if (totalMemberships > MAX_OWNED_MEMBERSHIPS) return undefined;
    if (ownerId === sourceId) current = { generated, tombstones };
  }
  return current ?? { generated: new Map(), tombstones: new Map() };
}

function freezeProposal(
  status: ReconciliationProposal["status"],
  input: ReconciliationInput,
  changes: ReconciliationChange[],
  ownershipChanges: ReconciliationOwnershipChange[],
  warnings: Set<ReconciliationWarningCode>,
): ReconciliationProposal {
  const frozenChanges = Object.freeze(changes.map((change) => Object.freeze({ ...change })));
  const frozenOwnershipChanges = Object.freeze(ownershipChanges.map((change) => Object.freeze({ ...change })));
  return Object.freeze({
    version: 1,
    status,
    sourceId: input.inventory.sourceId,
    sourceRevision: input.inventory.revision,
    expectedConfigDigest: input.configDigest,
    expectedOwnershipRevision: input.ownershipRevision,
    changes: frozenChanges,
    ownershipChanges: frozenOwnershipChanges,
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
  const ownershipChanges: ReconciliationOwnershipChange[] = [];
  const warnings = new Set<ReconciliationWarningCode>();
  const addedOrKept = new Set<string>();
  const tombstoned = new Set<string>();
  const tuple = (tier: string, model: string) => `${tier}\u0000${model}`;

  // A missing owned entry is already a user edit. Preserve it as a tombstone
  // regardless of current inventory completeness or source enablement.
  for (const [tier, models] of owned.generated) {
    const configuredTier = configured.get(tier) ?? new Set<string>();
    for (const modelKey of models) {
      if (configuredTier.has(modelKey)) continue;
      tombstoned.add(tuple(tier, modelKey));
      ownershipChanges.push({ kind: "unclaim", tier, modelKey });
      ownershipChanges.push({ kind: "tombstone", tier, modelKey });
      warnings.add("user_removal_tombstoned");
    }
  }

  if (!input.ownership || !own(input.ownership.sources, inventory.sourceId)) {
    warnings.add("ownership_uninitialized");
  }
  if (!complete) warnings.add("inventory_incomplete");

  // Propose exact additions from this source only. Existing unowned config values remain manual.
  if (inventory.enabled) {
    for (const [tier, models] of desired) {
      const configuredTier = configured.get(tier) ?? new Set<string>();
      const generatedTier = owned.generated.get(tier) ?? new Set<string>();
      const tombstoneTier = owned.tombstones.get(tier) ?? new Set<string>();
      for (const modelKey of models) {
        const key = tuple(tier, modelKey);
        if (generatedTier.has(modelKey)) {
          if (configuredTier.has(modelKey)) addedOrKept.add(key);
          continue;
        }
        if (tombstoneTier.has(modelKey) || tombstoned.has(key)) continue;
        if (configuredTier.has(modelKey)) {
          warnings.add("manual_entry_collision");
          continue;
        }
        changes.push({ kind: "add", disposition: complete ? "apply" : "advisory", tier, modelKey });
        if (complete) ownershipChanges.push({ kind: "claim", tier, modelKey });
      }
    }
  }

  // Only a complete inventory can establish that previously generated membership is obsolete.
  for (const [tier, models] of owned.generated) {
    const configuredTier = configured.get(tier) ?? new Set<string>();
    const desiredTier = inventory.enabled ? desired.get(tier) ?? new Set<string>() : new Set<string>();
    for (const modelKey of models) {
      if (addedOrKept.has(tuple(tier, modelKey))) continue;
      if (tombstoned.has(tuple(tier, modelKey))) continue;
      if (!configuredTier.has(modelKey)) continue; // Already removed by a human; do not rewrite it.
      if (!complete) {
        warnings.add("removal_suppressed");
        continue;
      }
      if (desiredTier.has(modelKey)) continue;
      changes.push({ kind: "remove", disposition: "apply", tier, modelKey });
      ownershipChanges.push({ kind: "unclaim", tier, modelKey });
    }
  }

  return freezeProposal(complete ? "ready" : "advisory", input, changes, ownershipChanges, warnings);
}
