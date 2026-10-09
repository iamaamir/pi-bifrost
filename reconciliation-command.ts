import { createHash } from "node:crypto";
import {
  proposeReconciliation,
  type ReconciliationChange,
  type ReconciliationInput,
  type ReconciliationOwnershipSnapshot,
  type ReconciliationProposal,
  type ReconciliationWarningCode,
} from "./reconciliation.ts";
import {
  ReconciliationStoreError,
  assertPlainJsonObject,
  type ApplyReconciliationTransactionInput,
  type ApplyResult,
  type RecoveryResult,
  type ReconciliationStorePaths,
} from "./reconciliation-store.ts";

export type ReconciliationConfigSource = "project" | "user";

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

export type ReconciliationCommandReason =
  | "usage"
  | "source_missing"
  | "source_invalid"
  | "tier_not_explicit"
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
      if (value !== "project" && value !== "user") return failUsage();
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

/** Build initial ownership only from the exact model memberships generated by this init run. */
export function buildInitOwnershipReceipt(
  generatedModelsByTier: Readonly<Record<string, readonly string[]>>,
  previouslyConfiguredModels: Readonly<Record<string, string | readonly string[]>> = {},
): ReconciliationOwnershipSnapshot | undefined {
  if (!isPlainRecord(generatedModelsByTier) || Object.keys(generatedModelsByTier).length > 100
    || !isPlainRecord(previouslyConfiguredModels) || Object.keys(previouslyConfiguredModels).length > 100) return undefined;
  const prior = new Map<string, Set<string>>();
  for (const [tier, rawModels] of Object.entries(previouslyConfiguredModels)) {
    if (!validTier(tier)) return undefined;
    const values = typeof rawModels === "string" ? [rawModels] : rawModels;
    if (!Array.isArray(values) || values.length > 5_000 || values.some((entry) => typeof entry !== "string" || entry.length > 512)) return undefined;
    prior.set(tier, new Set(values));
  }
  const sources: Record<string, ReconciliationOwnershipSnapshot["sources"][string]> = {};
  for (const [tier, models] of Object.entries(generatedModelsByTier)) {
    if (!validTier(tier) || !Array.isArray(models) || models.length > 5_000) return undefined;
    const byProvider = new Map<string, string[]>();
    for (const modelKey of models) {
      if (typeof modelKey !== "string" || modelKey.length > 512
        || /[\u0000-\u0020\u007f]/u.test(modelKey)) return undefined;
      const separator = modelKey.indexOf("/");
      const provider = modelKey.slice(0, separator);
      const id = modelKey.slice(separator + 1);
      if (separator <= 0 || separator === modelKey.length - 1 || provider.includes("/") || modelKey.includes("*")
        || modelKey.trim() !== modelKey || byProvider.get(provider)?.includes(modelKey)) return undefined;
      if (prior.get(tier)?.has(modelKey)) continue;
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), modelKey]);
      if (!id) return undefined;
    }
    for (const [provider, modelKeys] of byProvider) {
      setOwn(sources, canonicalSourceId(provider, tier), {
        generated: { [tier]: modelKeys.sort() },
        tombstones: {},
      });
    }
  }
  return Object.freeze({ version: 1, sources: Object.freeze(sources) });
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

function ownershipFromBytes(bytes: Uint8Array | null): ReconciliationOwnershipSnapshot | undefined | null {
  if (bytes === null) return undefined;
  const parsed = parseJsonObject(bytes, MAX_OWNERSHIP_BYTES);
  if (!parsed) return null;
  return parsed as unknown as ReconciliationOwnershipSnapshot;
}

function ownershipMatchesProviderTier(
  ownership: ReconciliationOwnershipSnapshot | undefined,
  sourceId: string,
  provider: string,
  tier: string,
): boolean {
  if (!ownership) return true;
  if (!isPlainRecord(ownership.sources)) return false;
  if (!Object.hasOwn(ownership.sources, sourceId)) return true;
  const source = ownership.sources[sourceId];
  if (!isPlainRecord(source) || !isPlainRecord(source.generated) || !isPlainRecord(source.tombstones)) return false;
  const prefix = `${provider}/`;
  for (const section of [source.generated, source.tombstones]) {
    for (const [ownedTier, rawModels] of Object.entries(section)) {
      if (ownedTier !== tier || !Array.isArray(rawModels)) return false;
      if (rawModels.some((model) => typeof model !== "string" || !model.startsWith(prefix)
        || model.length <= prefix.length || model.includes("*")
        || /[\u0000-\u0020\u007f]/u.test(model))) return false;
    }
  }
  return true;
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

function applyOwnershipChanges(
  snapshot: ReconciliationOwnershipSnapshot | undefined,
  sourceId: string,
  changes: ReconciliationProposal["ownershipChanges"],
): ReconciliationOwnershipSnapshot | undefined {
  if (changes.length === 0) return snapshot;
  const sources: Record<string, unknown> = { ...(snapshot?.sources ?? {}) };
  const rawSource = sources[sourceId];
  const source = isPlainRecord(rawSource) ? { ...rawSource } : { generated: {}, tombstones: {} };
  const generated = isPlainRecord(source.generated) ? { ...source.generated } : {};
  const tombstones = isPlainRecord(source.tombstones) ? { ...source.tombstones } : {};
  const membership = (target: Record<string, unknown>, tier: string): string[] => {
    const current = target[tier];
    return Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
  };
  for (const change of changes) {
    const generatedTier = membership(generated, change.tier);
    const tombstoneTier = membership(tombstones, change.tier);
    if (change.kind === "claim") {
      if (!generatedTier.includes(change.modelKey)) generatedTier.push(change.modelKey);
      setOwn(generated, change.tier, generatedTier.sort());
    } else if (change.kind === "unclaim") {
      setOwn(generated, change.tier, generatedTier.filter((key) => key !== change.modelKey));
    } else {
      if (!tombstoneTier.includes(change.modelKey)) tombstoneTier.push(change.modelKey);
      setOwn(tombstones, change.tier, tombstoneTier.sort());
    }
  }
  setOwn(source, "generated", generated);
  setOwn(source, "tombstones", tombstones);
  setOwn(sources, sourceId, source);
  return { version: 1, sources: sources as ReconciliationOwnershipSnapshot["sources"] };
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
  const ownership = ownershipFromBytes(source.ownershipBytes);
  if (ownership === null) return blocked(request, "source_invalid");
  const sourceId = canonicalSourceId(request.provider, request.tier);
  if (!ownershipMatchesProviderTier(ownership, sourceId, request.provider, request.tier)) {
    return blocked(request, "source_invalid");
  }
  const modelKeys = modelKeysForProvider(registry, request.provider);
  const inventoryRevision = sha256(Buffer.from(JSON.stringify([request.provider, modelKeys]), "utf8"));
  const proposal = proposeReconciliation({
    configDigest,
    ownershipRevision: ownershipDigest,
    ...(ownership ? { ownership } : {}),
    configuredModels: { [request.tier]: pool as string | readonly string[] },
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
  if (proposal.changes.length === 0) {
    // Ownership-only changes must not reformat or otherwise rewrite human config.
    nextConfigBytes = Buffer.from(source.configBytes);
  } else {
    const candidateSource = applyModelChanges(sourceConfig, request.tier, proposal.changes);
    if (!candidateSource) return blocked(request, "source_invalid");
    nextConfigBytes = serialize(candidateSource);
  }
  const nextOwnership = applyOwnershipChanges(ownership, sourceId, proposal.ownershipChanges);
  const nextOwnershipBytes = nextOwnership ? serialize(nextOwnership) : source.ownershipBytes;
  if ((proposal.changes.length > 0 || proposal.ownershipChanges.length > 0)
    && !dependencies.validateMergedConfig(request.source, nextConfigBytes)) {
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
  if (proposal.changes.length === 0 && proposal.ownershipChanges.length === 0) {
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
