import { createHash } from "node:crypto";
import {
  deriveOwnershipSnapshot,
  parseOwnershipSnapshot,
  proposeReconciliation,
  providerMembershipView,
  tierOwnership,
  type ConfiguredTierPool,
  type OwnershipScope,
  type ReconciliationChange,
  type ReconciliationInput,
  type ReconciliationOwnershipSnapshot,
  type ReconciliationProposal,
  type ReconciliationWarningCode,
} from "./reconciliation.ts";
import {
  ReconciliationStoreError,
  assertOwnershipPayload,
  assertPlainJsonObject,
  type ApplyReconciliationTransactionInput,
  type ApplyResult,
  type RecoveryResult,
  type ReconciliationStorePaths,
} from "./reconciliation-store.ts";

export type ReconciliationConfigSource = "project" | "workspace" | "user";

export type ReconciliationCommandRequest =
  | {
      readonly action: "preview";
      readonly source: ReconciliationConfigSource;
      readonly tier: string;
      readonly provider: string;
      readonly json: boolean;
      /** Explicit catalog/network refresh followed by preview; never accepted with --apply. */
      readonly refresh?: true;
    }
  | {
      readonly action: "apply";
      readonly source: ReconciliationConfigSource;
      readonly tier: string;
      readonly provider: string;
      readonly proposalDigest: string;
      readonly json: boolean;
    }
  | {
      readonly action: "recover";
      readonly source: ReconciliationConfigSource;
      readonly json: boolean;
    };

export interface ReconciliationSourceSnapshot extends ReconciliationStorePaths {
  readonly source: ReconciliationConfigSource;
  /** Exact bytes from the selected config layer; null means that file is absent. */
  readonly configBytes: Uint8Array | null;
  /** Exact ownership sidecar bytes; null means no ownership receipt exists. */
  readonly ownershipBytes: Uint8Array | null;
}

export interface ReconciliationRegistryModel {
  readonly provider: string;
  readonly id: string;
  /** The adapter marks host virtual catalog entries so only physical catalog entries are inventoried. */
  readonly virtual: boolean;
}

export interface ProviderRefreshEvidence {
  readonly status: "complete" | "partial" | "stale";
  readonly refreshedAt: number;
}

export interface ReconciliationRegistrySnapshot {
  readonly models: readonly ReconciliationRegistryModel[];
  readonly knownProviders: readonly string[];
  readonly authConfigured: boolean | undefined;
  /** Pi ModelRegistry.getError() is reduced to a boolean; raw errors are never returned or persisted. */
  readonly hasRegistryError: boolean;
  readonly forceRefresh: boolean;
  readonly refreshEvidence: ProviderRefreshEvidence | undefined;
  readonly now: number;
  readonly freshnessTtlMs: number;
}

export interface ReconciliationCommandSnapshot {
  readonly source: ReconciliationSourceSnapshot;
  readonly registry: ReconciliationRegistrySnapshot;
}

export interface ReconciliationCommandDependencies {
  /** Must validate the effective merged config with only this source's candidate bytes substituted. */
  readonly validateMergedConfig: (
    source: ReconciliationConfigSource,
    candidateSourceBytes: Uint8Array,
  ) => boolean;
  readonly apply: (input: ApplyReconciliationTransactionInput) => ApplyResult;
  readonly recover: (paths: ReconciliationStorePaths) => RecoveryResult;
}

export interface InitMembershipInventory {
  readonly provider: string;
  readonly status: ReconciliationInput["inventory"]["status"];
  readonly modelsByTier: Readonly<Record<string, readonly string[]>>;
}

export interface InitMembershipPlan {
  readonly status: "ready" | "advisory" | "blocked";
  readonly reason?: "source_missing" | "source_invalid" | "prospective_config_invalid" | "no_changes";
  readonly changes: readonly ReconciliationChange[];
  readonly warnings: readonly ReconciliationWarningCode[];
  readonly transaction?: ApplyReconciliationTransactionInput;
}

export type ReconciliationCommandReason =
  | "usage"
  | "source_missing"
  | "source_invalid"
  | "tier_not_explicit"
  | "tier_protected"
  | "provider_unknown"
  | "inventory_stale"
  | "inventory_partial"
  | "auth_unknown"
  | "auth_not_configured"
  | "prospective_config_invalid"
  | "proposal_digest_required"
  | "proposal_changed"
  | "no_changes"
  | "operator_repair_required"
  | "store_conflict"
  | "store_io_failure"
  | "recovery_conflict";

export interface ReconciliationCommandReport {
  readonly action: ReconciliationCommandRequest["action"];
  readonly source: ReconciliationConfigSource;
  readonly status: "ready" | "advisory" | "blocked" | "committed" | "completed" | "aborted" | "nothing_to_recover" | "conflict";
  readonly reason?: ReconciliationCommandReason;
  readonly provider?: string;
  readonly tier?: string;
  readonly inventoryStatus?: "complete" | "partial" | "stale" | "auth_failed";
  readonly proposalDigest?: string;
  readonly changes: readonly ReconciliationChange[];
  readonly warnings: readonly ReconciliationWarningCode[];
  readonly recovery?: RecoveryResult;
  readonly applyResult?: ApplyResult;
}

export type ParsedReconciliationCommand =
  | { readonly ok: true; readonly request: ReconciliationCommandRequest }
  | { readonly ok: false; readonly reason: "usage" };

const SHA256 = /^[a-f0-9]{64}$/u;
const VALID_TEXT = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const VALID_TIER = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const SUPPORTED_FLAGS = new Set(["--source", "--tier", "--provider", "--apply", "--proposal", "--recover", "--json", "--refresh"]);
const MAX_CONFIG_BYTES = 10_000_000;
const MAX_OWNERSHIP_BYTES = 5_000_000;
const MAX_INIT_INVENTORIES = 1_000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tokenDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validTier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && value.trim() === value && VALID_TIER.test(value);
}

function validProvider(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && VALID_TEXT.test(value) && !value.includes("/");
}

function failUsage(): ParsedReconciliationCommand {
  return Object.freeze({ ok: false, reason: "usage" });
}

/** Parse only the command's explicit, bounded CLI surface; refresh is preview-only. */
export function parseReconciliationCommandArgs(args: string): ParsedReconciliationCommand {
  if (typeof args !== "string" || args.length > 2_048) return failUsage();
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let source: ReconciliationConfigSource = "project";
  let tier: string | undefined;
  let provider: string | undefined;
  let proposalDigest: string | undefined;
  let apply = false;
  let recover = false;
  let refresh = false;
  let json = false;
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!SUPPORTED_FLAGS.has(token)) {
      return failUsage();
    }
    if (seen.has(token)) return failUsage();
    seen.add(token);
    if (token === "--apply") { apply = true; continue; }
    if (token === "--recover") { recover = true; continue; }
    if (token === "--refresh") { refresh = true; continue; }
    if (token === "--json") { json = true; continue; }
    const value = tokens[++index];
    if (!value || value.startsWith("--")) return failUsage();
    if (token === "--source") {
      if (value !== "project" && value !== "workspace" && value !== "user") return failUsage();
      source = value;
    } else if (token === "--tier") tier = value;
    else if (token === "--provider") provider = value;
    else proposalDigest = value;
  }

  if (recover) {
    if (tier !== undefined || provider !== undefined || apply || refresh || proposalDigest !== undefined) return failUsage();
    return Object.freeze({ ok: true, request: Object.freeze({ action: "recover", source, json }) });
  }
  if (!validTier(tier) || !validProvider(provider)) return failUsage();
  if (apply) {
    if (refresh) return failUsage();
    if (!tokenDigest(proposalDigest)) return failUsage();
    return Object.freeze({ ok: true, request: Object.freeze({ action: "apply", source, tier, provider, proposalDigest, json }) });
  }
  if (proposalDigest !== undefined) return failUsage();
  return Object.freeze({ ok: true, request: Object.freeze({ action: "preview", source, tier, provider, json, ...(refresh ? { refresh: true as const } : {}) }) });
}

/** Build initial ownership only from the exact ordered memberships generated by this init run. */
export function buildInitOwnershipReceipt(
  scope: OwnershipScope,
  generatedModelsByTier: Readonly<Record<string, readonly string[]>>,
  previouslyConfiguredModels: Readonly<Record<string, string | readonly string[]>> = {},
): ReconciliationOwnershipSnapshot | undefined {
  if (!isPlainRecord(generatedModelsByTier) || Object.keys(generatedModelsByTier).length > 100
    || !isPlainRecord(previouslyConfiguredModels) || Object.keys(previouslyConfiguredModels).length > 100) return undefined;
  const prior = new Set(Object.keys(previouslyConfiguredModels));
  const tiers: Record<string, { state: "generated"; models: readonly string[] }> = {};
  for (const [tier, models] of Object.entries(generatedModelsByTier)) {
    if (!validTier(tier) || !Array.isArray(models) || models.length > 5_000) return undefined;
    const seen = new Set<string>();
    for (const modelKey of models) {
      if (typeof modelKey !== "string" || modelKey.length > 512
        || /[\u0000-\u0020\u007f]/u.test(modelKey)) return undefined;
      const separator = modelKey.indexOf("/");
      if (separator <= 0 || separator === modelKey.length - 1 || modelKey.slice(0, separator).includes("/")
        || modelKey.includes("*") || modelKey.trim() !== modelKey || seen.has(modelKey)) return undefined;
      seen.add(modelKey);
    }
    // A tier holding any pre-existing model is user-managed as a whole; no snapshot.
    if (prior.has(tier)) continue;
    Object.defineProperty(tiers, tier, {
      value: { state: "generated", models: Object.freeze([...models]) },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze({ version: 2, scope, tiers: Object.freeze(tiers) } as ReconciliationOwnershipSnapshot);
}

function blocked(
  request: ReconciliationCommandRequest,
  reason: ReconciliationCommandReason,
  status: ReconciliationCommandReport["status"] = "blocked",
): ReconciliationCommandReport {
  return Object.freeze({
    action: request.action,
    source: request.source,
    status,
    reason,
    ...("provider" in request ? { provider: request.provider, tier: request.tier } : {}),
    changes: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJsonObject(bytes: Uint8Array, limit: number): Record<string, unknown> | undefined {
  if (bytes.byteLength > limit) return undefined;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  try {
    const value: unknown = JSON.parse(text);
    return isPlainRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function canonicalSourceId(provider: string, tier: string): string {
  return `pi-models-v1-${sha256(Buffer.from(JSON.stringify([provider, tier]), "utf8")).slice(0, 40)}`;
}

function inventoryStatus(snapshot: ReconciliationRegistrySnapshot, provider: string): ReconciliationInput["inventory"]["status"] {
  if (!snapshot.knownProviders.includes(provider)) return "stale";
  if (snapshot.authConfigured === undefined) return "auth_failed";
  if (snapshot.authConfigured === false) return "auth_failed";
  if (snapshot.hasRegistryError || snapshot.forceRefresh || !snapshot.refreshEvidence) return "stale";
  const evidence = snapshot.refreshEvidence;
  if (evidence.status === "partial") return "partial";
  if (evidence.status === "stale" || !Number.isFinite(evidence.refreshedAt)
    || !Number.isFinite(snapshot.now) || !Number.isFinite(snapshot.freshnessTtlMs)
    || snapshot.freshnessTtlMs <= 0 || snapshot.now < evidence.refreshedAt
    || snapshot.now - evidence.refreshedAt >= snapshot.freshnessTtlMs) return "stale";
  return "complete";
}

function modelKeysForProvider(snapshot: ReconciliationRegistrySnapshot, provider: string): string[] {
  return [...new Set(snapshot.models
    .filter((model) => !model.virtual && model.provider === provider && typeof model.id === "string" && model.id.length > 0)
    .map((model) => `${model.provider}/${model.id}`))].sort();
}

/** Builds one ownership-aware membership update for every provider and tier. */
export function buildInitMembershipPlan(
  source: ReconciliationSourceSnapshot,
  inventories: readonly InitMembershipInventory[],
  validateMergedConfig: ReconciliationCommandDependencies["validateMergedConfig"],
): InitMembershipPlan {
  if (!source.configBytes) return { status: "blocked", reason: "source_missing", changes: [], warnings: [] };
  if (inventories.length > MAX_INIT_INVENTORIES) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
  if (source.configBytes.byteLength > MAX_CONFIG_BYTES) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
  let sourceConfig: Record<string, unknown>;
  try { sourceConfig = assertPlainJsonObject(source.configBytes); }
  catch { return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] }; }
  if (!sourceConfig || source.ownershipBytes && source.ownershipBytes.byteLength > MAX_OWNERSHIP_BYTES) {
    return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
  }
  const rawModels = sourceConfig.models;
  if (rawModels !== undefined && !isPlainRecord(rawModels)) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
  const models: Record<string, unknown> = isPlainRecord(rawModels) ? { ...rawModels } : {};
  const before: Record<string, ConfiguredTierPool> = {};
  for (const [tier, raw] of Object.entries(models)) {
    const pool = normalizePool(raw);
    if (!validTier(tier) || !pool) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
    setOwn(before, tier, raw);
  }
  const ownership = ownershipFromBytes(source.ownershipBytes, source.source);
  if (ownership === null) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
  const configDigest = sha256(source.configBytes);
  const ownershipDigest = source.ownershipBytes ? sha256(source.ownershipBytes) : null;
  const changes: ReconciliationChange[] = [];
  const warnings = new Set<ReconciliationWarningCode>();
  const managedTiers = new Set<string>();
  let advisory = false;
  const allTiers = new Set(Object.keys(models));
  for (const inventory of inventories) for (const tier of Object.keys(inventory.modelsByTier)) allTiers.add(tier);
  if (ownership) for (const tier of Object.keys(ownership.tiers)) allTiers.add(tier);
  for (const inventory of inventories) {
    if (!validProvider(inventory.provider)) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
    for (const tier of allTiers) {
      const rawPool = Object.hasOwn(before, tier) ? before[tier] : undefined;
      const owner = tierOwnership(ownership, tier, rawPool);
      const pool = normalizePool(rawPool) ?? [];
      // Routine refresh never changes an entire tier controlled by the user.
      if (owner === "deleted" || owner === "user") {
        warnings.add("tier_user_managed");
        continue;
      }
      const sourceId = canonicalSourceId(inventory.provider, tier);
      const view = owner === "managed"
        ? providerMembershipView(ownership!, tier, inventory.provider, sourceId)
        : undefined;
      if (owner === "managed" && !view) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
      const modelsByTier = Object.hasOwn(inventory.modelsByTier, tier) ? { [tier]: inventory.modelsByTier[tier]! } : {};
      const revision = sha256(Buffer.from(JSON.stringify([inventory.provider, modelsByTier]), "utf8"));
      const applied: ReconciliationInput["inventory"]["modelsByTier"] = modelsByTier;
      const proposal = proposeReconciliation({
        configDigest,
        ownershipRevision: ownershipDigest,
        ...(view ? { ownership: view } : {}),
        configuredModels: { [tier]: pool },
        inventory: { sourceId, revision, status: inventory.status, enabled: true, modelsByTier: applied },
      });
      if (proposal.status === "invalid") return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
      advisory ||= proposal.status !== "ready";
      for (const warning of proposal.warnings) warnings.add(warning);
      const applying = proposal.changes.filter((change) => change.disposition === "apply");
      if (applying.length > 0) managedTiers.add(tier);
      changes.push(...applying);
    }
  }
  for (const tier of new Set(changes.map((change) => change.tier))) {
    if (!Object.hasOwn(models, tier)) setOwn(models, tier, []);
  }
  let candidateConfig = sourceConfig;
  for (const tier of new Set(changes.map((change) => change.tier))) {
    const candidate = applyModelChanges({ ...candidateConfig, models }, tier, changes.filter((change) => change.tier === tier));
    if (!candidate) return { status: "blocked", reason: "source_invalid", changes: [], warnings: [] };
    candidateConfig = candidate;
    Object.assign(models, candidate.models);
  }
  const nextConfigBytes = changes.length ? serialize(candidateConfig) : Buffer.from(source.configBytes);
  if (changes.length && !validateMergedConfig(source.source, nextConfigBytes)) {
    return { status: "blocked", reason: "prospective_config_invalid", changes: [], warnings: [] };
  }
  const after: Record<string, ConfiguredTierPool> = {};
  const afterModels = isPlainRecord(candidateConfig.models) ? candidateConfig.models : {};
  for (const [tier, raw] of Object.entries(afterModels)) {
    const pool = normalizePool(raw);
    if (pool) setOwn(after, tier, raw);
  }
  const nextOwnership = deriveOwnershipSnapshot({
    scope: source.source,
    previous: ownership,
    before,
    after,
    managedTiers,
  });
  const nextOwnershipBytes = serialize(nextOwnership);
  // Compare semantics, not formatting: re-serializing an unchanged or absent claim set is not a change.
  const ownershipChanged = JSON.stringify(nextOwnership) !== JSON.stringify(
    ownership ?? { version: 2, scope: source.source, tiers: {} },
  );
  if (!changes.length && !ownershipChanged) {
    return { status: advisory ? "advisory" : "blocked", reason: "no_changes", changes: [], warnings: [...warnings] };
  }
  if (nextConfigBytes.byteLength > MAX_CONFIG_BYTES || nextOwnershipBytes.byteLength > MAX_OWNERSHIP_BYTES) {
    return { status: "blocked", reason: "source_invalid", changes: [], warnings: [...warnings] };
  }
  try {
    assertPlainJsonObject(nextConfigBytes);
    assertOwnershipPayload(nextOwnershipBytes);
  } catch {
    return { status: "blocked", reason: "source_invalid", changes: [], warnings: [...warnings] };
  }
  return {
    status: advisory ? "advisory" : "ready",
    changes: Object.freeze(changes),
    warnings: Object.freeze([...warnings].sort()),
    transaction: {
      configPath: source.configPath,
      ownershipPath: source.ownershipPath,
      journalPath: source.journalPath,
      expectedConfigDigest: configDigest,
      expectedOwnershipDigest: ownershipDigest,
      nextConfigBytes,
      nextOwnershipBytes,
    },
  };
}

export interface InitActionPlan extends InitMembershipPlan {
  readonly tiers: readonly { readonly tier: string; readonly before: readonly string[] | undefined; readonly after: readonly string[] | undefined; readonly ownershipBefore: string; readonly ownershipAfter: string }[];
}

function collectProbedModels(inventories: readonly InitMembershipInventory[]): Map<string, Set<string>> | undefined {
  const probedByTier = new Map<string, Set<string>>();
  for (const inventory of inventories) {
    if (!validProvider(inventory.provider) || !isPlainRecord(inventory.modelsByTier)) return undefined;
    for (const [tier, keys] of Object.entries(inventory.modelsByTier)) {
      if (!validTier(tier) || !Array.isArray(keys) || keys.length > 5_000) return undefined;
      const found = probedByTier.get(tier) ?? new Set<string>();
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith(`${inventory.provider}/`)
          || key.length > 512 || /[\u0000-\u0020\u007f]/u.test(key) || key.includes("*")) return undefined;
        found.add(key);
      }
      probedByTier.set(tier, found);
    }
  }
  return probedByTier;
}

function generatedModelsAreProbed(
  generatedTiers: readonly (readonly [string, readonly string[]])[],
  probedByTier: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [tier, keys] of generatedTiers) {
    if (!validTier(tier) || !Array.isArray(keys) || keys.length > 5_000) return false;
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 512 || /[\u0000-\u0020\u007f]/u.test(key)
        || key.trim() !== key || key.includes("*") || key.indexOf("/") <= 0 || key.indexOf("/") === key.length - 1
        || key.slice(0, key.indexOf("/")).includes("/")) return false;
      if (!probedByTier.get(tier)?.has(key)) return false;
    }
  }
  return true;
}

/** Plans one explicit init action against the exact selected-layer snapshot. */
export function buildInitActionPlan(input: {
  readonly action: "keep" | "merge" | "defaults";
  readonly source: ReconciliationSourceSnapshot;
  readonly inventories: readonly InitMembershipInventory[];
  readonly generated: Readonly<Record<string, readonly string[]>>;
  readonly inheritedTiers: ReadonlySet<string>;
  readonly inheritedPools?: ReadonlyMap<string, readonly string[]>;
  readonly validateMergedConfig: ReconciliationCommandDependencies["validateMergedConfig"];
}): InitActionPlan {
  const blocked = (reason: InitMembershipPlan["reason"]): InitActionPlan => ({
    status: "blocked",
    reason,
    changes: [],
    warnings: [],
    tiers: [],
  });
  const { source, generated } = input;
  if (!source.configBytes) return blocked("source_missing");
  if (input.action !== "keep" && input.action !== "merge" && input.action !== "defaults") {
    return blocked("source_invalid");
  }

  const inventories = input.inventories;
  if (
    source.configBytes.byteLength > MAX_CONFIG_BYTES ||
    inventories.length === 0 ||
    inventories.length > MAX_INIT_INVENTORIES ||
    inventories.some((entry) => entry.status !== "complete") ||
    !isPlainRecord(generated) ||
    Object.keys(generated).length > 100 ||
    !Object.values(generated).some((pool) => Array.isArray(pool) && pool.length > 0)
  ) {
    return blocked("source_invalid");
  }

  let original: Record<string, unknown>;
  try {
    original = assertPlainJsonObject(source.configBytes);
  } catch {
    return blocked("source_invalid");
  }
  if (original.models !== undefined && !isPlainRecord(original.models)) {
    return blocked("source_invalid");
  }

  const before: Record<string, ConfiguredTierPool> = {};
  const originalModels = isPlainRecord(original.models) ? original.models : {};
  for (const [tier, pool] of Object.entries(originalModels)) {
    if (!validTier(tier) || !normalizePool(pool)) return blocked("source_invalid");
    setOwn(before, tier, pool);
  }

  const previous = ownershipFromBytes(source.ownershipBytes, source.source);
  if (previous === null || (source.ownershipBytes && source.ownershipBytes.byteLength > MAX_OWNERSHIP_BYTES)) {
    return blocked("source_invalid");
  }
  const generatedTiers = Object.entries(generated);
  const probedByTier = collectProbedModels(input.inventories);
  if (!probedByTier || !generatedModelsAreProbed(generatedTiers, probedByTier)) return blocked("source_invalid");
  const uniqueGeneratedTiers = generatedTiers.map(([tier, keys]) => [tier, [...new Set(keys)]] as const);
  let candidate: Record<string, unknown> = original;
  let warnings: readonly ReconciliationWarningCode[] = [];
  const managedTiers = new Set<string>();
  if (input.action === "keep") {
    // Keep delegates to existing whole-tier reconciler; inherited-only tiers are not local candidates.
    const safeInventories = input.inventories.map((entry) => ({ ...entry, modelsByTier: Object.fromEntries(
      Object.entries(entry.modelsByTier).filter(([tier]) => Object.hasOwn(before, tier) || !input.inheritedTiers.has(tier)),
    ) }));
    const keep = buildInitMembershipPlan(source, safeInventories, input.validateMergedConfig);
    if (keep.reason && keep.reason !== "no_changes") return blocked(keep.reason);
    if (keep.status === "blocked" && !keep.reason) return blocked("source_invalid");
    warnings = keep.warnings;
    try { candidate = keep.transaction ? assertPlainJsonObject(keep.transaction.nextConfigBytes) : original; }
    catch { return blocked("source_invalid"); }
    const keepOwnership = keep.transaction ? ownershipFromBytes(keep.transaction.nextOwnershipBytes, source.source) : previous;
    if (keepOwnership === null) return blocked("source_invalid");
    for (const [tier, entry] of Object.entries(keepOwnership?.tiers ?? {})) {
      if (entry.state === "generated") managedTiers.add(tier);
    }
  }
  const nextModels: Record<string, unknown> = { ...(isPlainRecord(candidate.models) ? candidate.models : {}) };
  if (input.action !== "keep") {
    for (const [tier, additions] of uniqueGeneratedTiers) {
      const current = Object.hasOwn(before, tier) ? before[tier] : undefined;
      const owner = tierOwnership(previous, tier, current);
      if (input.action === "merge") {
        if (owner === "deleted" || (current !== undefined && normalizePool(current)?.length === 0)
          || (current === undefined && input.inheritedTiers.has(tier))) continue;
        const old = normalizePool(current) ?? [];
        const appended = new Set(old);
        setOwn(nextModels, tier, [...old, ...additions.filter((key) => {
          if (appended.has(key)) return false;
          appended.add(key);
          return true;
        })]);
      } else {
        const inherited = input.inheritedPools?.get(tier);
        if (current === undefined && owner !== "deleted" && inherited
          && additions.length === inherited.length && additions.every((key, index) => key === inherited[index])) continue;
        setOwn(nextModels, tier, [...additions]);
        managedTiers.add(tier);
      }
    }
    candidate = { ...original, models: nextModels };
  }
  const after: Record<string, ConfiguredTierPool> = {};
  for (const [tier, pool] of Object.entries(isPlainRecord(candidate.models) ? candidate.models : {})) {
    if (!validTier(tier) || !normalizePool(pool)) return blocked("source_invalid");
    setOwn(after, tier, pool);
  }
  const ownership = deriveOwnershipSnapshot({ scope: source.source, previous, before, after, managedTiers });
  const changed = JSON.stringify(original) !== JSON.stringify(candidate);
  const configBytes = changed ? serialize(candidate) : Buffer.from(source.configBytes);
  const ownershipBytes = serialize(ownership);
  try { assertOwnershipPayload(ownershipBytes); } catch { return blocked("source_invalid"); }
  if (configBytes.byteLength > MAX_CONFIG_BYTES || ownershipBytes.byteLength > MAX_OWNERSHIP_BYTES
    || !input.validateMergedConfig(source.source, configBytes)) return blocked("prospective_config_invalid");
  const changes: ReconciliationChange[] = [];
  const tiers = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(previous?.tiers ?? {})])].sort().map((tier) => {
    const old = normalizePool(before[tier]);
    const next = normalizePool(after[tier]);
    for (const key of old ?? []) if (!next?.includes(key)) changes.push({ kind: "remove", disposition: "apply", tier, modelKey: key });
    for (const key of next ?? []) if (!old?.includes(key)) changes.push({ kind: "add", disposition: "apply", tier, modelKey: key });
    return { tier, before: old, after: next, ownershipBefore: tierOwnership(previous, tier, before[tier]), ownershipAfter: tierOwnership(ownership, tier, after[tier]) };
  });
  const ownershipChanged = JSON.stringify(ownership) !== JSON.stringify(previous ?? { version: 2, scope: source.source, tiers: {} });
  if (!changed && !ownershipChanged) return { status: "blocked", reason: "no_changes", changes, warnings: [], tiers };
  return { status: "ready", changes, warnings, tiers, transaction: {
    configPath: source.configPath, ownershipPath: source.ownershipPath, journalPath: source.journalPath,
    expectedConfigDigest: sha256(source.configBytes), expectedOwnershipDigest: source.ownershipBytes ? sha256(source.ownershipBytes) : null,
    nextConfigBytes: configBytes, nextOwnershipBytes: ownershipBytes,
  } };
}

function normalizePool(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : undefined;
}

/** Reads only a trustworthy v2 payload for this scope. Legacy v1 is readable but yields no claims. */
function ownershipFromBytes(
  bytes: Uint8Array | null,
  scope: OwnershipScope,
): ReconciliationOwnershipSnapshot | undefined | null {
  if (bytes === null) return undefined;
  // The store's validator is authoritative: an unreadable sidecar must block, never be silently ignored.
  try { assertOwnershipPayload(bytes); } catch { return null; }
  const parsed = parseJsonObject(bytes, MAX_OWNERSHIP_BYTES);
  if (!parsed) return null;
  if (parsed.version === 1) return undefined;
  const snapshot = parseOwnershipSnapshot(parsed);
  return snapshot && snapshot.scope === scope ? snapshot : null;
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, configurable: true, enumerable: true, writable: true });
}

function applyModelChanges(
  sourceConfig: Record<string, unknown>,
  tier: string,
  changes: readonly ReconciliationChange[],
): Record<string, unknown> | undefined {
  const candidate = parseJsonObject(serialize(sourceConfig), MAX_CONFIG_BYTES);
  if (!candidate || !isPlainRecord(candidate.models) || !Object.hasOwn(candidate.models, tier)) return undefined;
  const models = { ...candidate.models };
  const rawPool = models[tier];
  const pool = typeof rawPool === "string" ? [rawPool] : Array.isArray(rawPool) ? [...rawPool] : undefined;
  if (!pool || pool.some((item) => typeof item !== "string")) return undefined;
  const next = [...pool] as string[];
  for (const change of changes) {
    if (change.tier !== tier) return undefined;
    if (change.kind === "remove") {
      const position = next.indexOf(change.modelKey);
      if (position >= 0) next.splice(position, 1);
    } else if (!next.includes(change.modelKey)) next.push(change.modelKey);
  }
  setOwn(models, tier, next);
  setOwn(candidate, "models", models);
  return candidate;
}

function stableProposalDigest(input: {
  source: ReconciliationConfigSource;
  provider: string;
  tier: string;
  configDigest: string;
  ownershipDigest: string | null;
  proposal: ReconciliationProposal;
  nextConfigBytes: Uint8Array;
  nextOwnershipBytes: Uint8Array | null;
}): string {
  return sha256(Buffer.from(JSON.stringify({
    version: 1,
    source: input.source,
    provider: input.provider,
    tier: input.tier,
    configDigest: input.configDigest,
    ownershipDigest: input.ownershipDigest,
    proposal: input.proposal,
    nextConfig: Buffer.from(input.nextConfigBytes).toString("base64"),
    nextOwnership: input.nextOwnershipBytes ? Buffer.from(input.nextOwnershipBytes).toString("base64") : null,
  }), "utf8"));
}

function buildPlan(
  request: Extract<ReconciliationCommandRequest, { action: "preview" | "apply" }>,
  snapshot: ReconciliationCommandSnapshot,
  dependencies: ReconciliationCommandDependencies,
): ReconciliationCommandReport {
  const { source, registry } = snapshot;
  if (source.source !== request.source || source.configBytes === null) return blocked(request, "source_missing");
  if (source.configBytes.byteLength > MAX_CONFIG_BYTES) return blocked(request, "source_invalid");
  let sourceConfig: Record<string, unknown>;
  try {
    sourceConfig = assertPlainJsonObject(source.configBytes);
  } catch {
    return blocked(request, "source_invalid");
  }
  if (!isPlainRecord(sourceConfig.models) || !Object.hasOwn(sourceConfig.models, request.tier)) {
    return blocked(request, "tier_not_explicit");
  }
  const pool = sourceConfig.models[request.tier];
  if (!(typeof pool === "string" || Array.isArray(pool) && pool.every((value) => typeof value === "string"))) {
    return blocked(request, "source_invalid");
  }
  if (!registry.knownProviders.includes(request.provider)) return blocked(request, "provider_unknown");
  const status = inventoryStatus(registry, request.provider);
  const configDigest = sha256(source.configBytes);
  const ownershipDigest = source.ownershipBytes === null ? null : sha256(source.ownershipBytes);
  const ownership = ownershipFromBytes(source.ownershipBytes, request.source);
  if (ownership === null) return blocked(request, "source_invalid");
  const currentPool = normalizePool(pool);
  if (!currentPool) return blocked(request, "source_invalid");
  const owner = tierOwnership(ownership, request.tier, pool as ConfiguredTierPool);
  if (owner !== "managed") return blocked(request, "tier_protected");
  const sourceId = canonicalSourceId(request.provider, request.tier);
  const view = owner === "managed"
    ? providerMembershipView(ownership!, request.tier, request.provider, sourceId)
    : undefined;
  if (owner === "managed" && !view) return blocked(request, "source_invalid");
  const modelKeys = modelKeysForProvider(registry, request.provider);
  const inventoryRevision = sha256(Buffer.from(JSON.stringify([request.provider, modelKeys]), "utf8"));
  const proposal = proposeReconciliation({
    configDigest,
    ownershipRevision: ownershipDigest,
    ...(view ? { ownership: view } : {}),
    configuredModels: { [request.tier]: currentPool },
    inventory: {
      sourceId,
      revision: inventoryRevision,
      status,
      enabled: true,
      modelsByTier: { [request.tier]: modelKeys },
    },
  });
  if (proposal.status === "invalid") return blocked(request, "source_invalid");
  let nextConfigBytes: Buffer;
  let nextPool = currentPool;
  if (proposal.changes.length === 0) {
    // Ownership-only changes must not reformat or otherwise rewrite human config.
    nextConfigBytes = Buffer.from(source.configBytes);
  } else {
    const candidateSource = applyModelChanges(sourceConfig, request.tier, proposal.changes);
    if (!candidateSource) return blocked(request, "source_invalid");
    const candidatePool = isPlainRecord(candidateSource.models) ? normalizePool(candidateSource.models[request.tier]) : undefined;
    if (!candidatePool) return blocked(request, "source_invalid");
    nextPool = candidatePool;
    nextConfigBytes = serialize(candidateSource);
  }
  const nextOwnershipBytes = proposal.changes.length === 0
    ? source.ownershipBytes
    : serialize(deriveOwnershipSnapshot({
        scope: request.source,
        previous: ownership,
        before: sourceConfig.models as Record<string, ConfiguredTierPool>,
        after: { ...sourceConfig.models, [request.tier]: nextPool } as Record<string, ConfiguredTierPool>,
        managedTiers: new Set([request.tier]),
      }));
  if (proposal.changes.length > 0 && !dependencies.validateMergedConfig(request.source, nextConfigBytes)) {
    return blocked(request, "prospective_config_invalid");
  }
  const proposalDigest = stableProposalDigest({
    source: request.source,
    provider: request.provider,
    tier: request.tier,
    configDigest,
    ownershipDigest,
    proposal,
    nextConfigBytes,
    nextOwnershipBytes,
  });
  const report: ReconciliationCommandReport = Object.freeze({
    action: request.action,
    source: request.source,
    status: proposal.status === "ready" ? "ready" : "advisory",
    ...(proposal.status !== "ready" ? { reason: status === "complete" ? undefined : inventoryReason(status, registry) } : {}),
    provider: request.provider,
    tier: request.tier,
    inventoryStatus: status,
    proposalDigest,
    changes: proposal.changes,
    warnings: proposal.warnings,
  });

  if (request.action === "preview") return Object.freeze({ ...report });
  if (proposal.status !== "ready") return Object.freeze({ ...report, action: "apply", status: "blocked", reason: report.reason ?? "inventory_stale" });
  if (proposal.changes.length === 0) {
    return Object.freeze({ ...report, action: "apply", status: "blocked", reason: "no_changes" });
  }
  if (!request.proposalDigest) return Object.freeze({ ...report, action: "apply", status: "blocked", reason: "proposal_digest_required" });
  if (request.proposalDigest !== proposalDigest) return Object.freeze({ ...report, action: "apply", status: "blocked", reason: "proposal_changed" });
  if (nextOwnershipBytes === null) return Object.freeze({ ...report, action: "apply", status: "blocked", reason: "source_invalid" });
  const transactionInput: ApplyReconciliationTransactionInput = {
    configPath: source.configPath,
    ownershipPath: source.ownershipPath,
    journalPath: source.journalPath,
    expectedConfigDigest: configDigest,
    expectedOwnershipDigest: ownershipDigest,
    nextConfigBytes,
    nextOwnershipBytes,
  };
  try {
    const applyResult = dependencies.apply(transactionInput);
    return Object.freeze({ ...report, action: "apply", status: "committed", applyResult });
  } catch (error) {
    const reason = storeErrorReason(error);
    return Object.freeze({ ...report, action: "apply", status: reason === "store_conflict" ? "conflict" : "blocked", reason });
  }
}

function inventoryReason(
  status: ReconciliationCommandReport["inventoryStatus"],
  registry: ReconciliationRegistrySnapshot,
): ReconciliationCommandReason | undefined {
  if (status === "auth_failed") return registry.authConfigured === false ? "auth_not_configured" : "auth_unknown";
  if (status === "partial") return "inventory_partial";
  if (status === "stale") return "inventory_stale";
  return undefined;
}

function storeErrorReason(error: unknown): ReconciliationCommandReason {
  if (error instanceof ReconciliationStoreError && error.code === "locked") return "operator_repair_required";
  if (error instanceof ReconciliationStoreError && error.code === "conflict") return "store_conflict";
  if (error instanceof ReconciliationStoreError && error.code === "invalid_input") return "source_invalid";
  return "store_io_failure";
}

function runRecovery(
  request: Extract<ReconciliationCommandRequest, { action: "recover" }>,
  snapshot: ReconciliationCommandSnapshot,
  dependencies: ReconciliationCommandDependencies,
): ReconciliationCommandReport {
  if (snapshot.source.source !== request.source) return blocked(request, "source_missing");
  try {
    const recovery = dependencies.recover({
      configPath: snapshot.source.configPath,
      ownershipPath: snapshot.source.ownershipPath,
      journalPath: snapshot.source.journalPath,
    });
    const reason = recovery.status === "conflict" ? "recovery_conflict" : undefined;
    return Object.freeze({
      action: "recover",
      source: request.source,
      status: recovery.status === "conflict" ? "conflict" : recovery.status,
      ...(reason ? { reason } : {}),
      changes: Object.freeze([]),
      warnings: Object.freeze([]),
      recovery,
    });
  } catch (error) {
    const reason = storeErrorReason(error);
    return blocked(request, reason, reason === "operator_repair_required" ? "blocked" : "conflict");
  }
}

/** Offline proposal/apply/recovery logic. All external reads are explicit frozen snapshots. */
export function runReconciliationCommand(
  request: ReconciliationCommandRequest,
  snapshot: ReconciliationCommandSnapshot,
  dependencies: ReconciliationCommandDependencies,
): ReconciliationCommandReport {
  if (request.action === "recover") return runRecovery(request, snapshot, dependencies);
  return buildPlan(request, snapshot, dependencies);
}
