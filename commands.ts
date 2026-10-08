import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, ModelSelectorComponent, getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRuntimeState, runtimeStatePath } from "./runtime-state.ts";
import type { BifrostConfig, ClassifierConfig } from "./config.ts";
import { DEFAULT_CLASSIFIER_CRITERIA, DEFAULT_RULES, PROMPT_ONLY_FIELDS, classifierTotalTimeoutIssue, loadConfigForReload, loadConfigWithSourceOverride, validateConfig, validateEconomicConfig, validateTierPolicyConfig } from "./config.ts";
import type { CacheEntry } from "./cache.ts";
import { cachePath, loadCache, saveCache, DEFAULT_MAX_ENTRIES, DEFAULT_THRESHOLD } from "./cache.ts";
import { buildRouteDecisionSummary, type ClassificationPipeline, type ClassificationResult, type ClassificationSource, type RouteDecisionSummary } from "./classification-pipeline.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
import { runProbe, probeOptionsFromConfig, PROBE_PROMPT_TEXT } from "./probe.ts";
import { setBifrostModeStatus, setBifrostStatus } from "./ux-status.ts";
import { showBifrostResult } from "./result-viewer.ts";
import {
  findCandidates,
  buildTierResolutionOptions,
  resolveConfiguredTier,
  guessTier,
  modelKey,
  type HealthyModelResolution,
  type RoutedModelResolution,
  type RoutingStrategy,
  type AffinityRoutingContext,
} from "./routing.ts";
import type { ReliabilityStore } from "./reliability-store.ts";
import type { ReliabilityV2Store } from "./reliability-v2-store.ts";
import { ReliabilityV2StoreError } from "./reliability-v2-store.ts";
import { emptyReliabilityState } from "./reliability.ts";
import { createReliabilityV2Store, reliabilityV2Config, reliabilityV2Path } from "./runtime-reliability-v2.ts";
import { projectReliabilityV2ForRouting } from "./reliability-v2-routing.ts";
import { classifierMetricsEnabled, type ClassifierMetricsState, type ClassifierMetricsStore } from "./classifier-metrics.ts";
import type { EffectiveBackend } from "./classifier-detection.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_API_KEY_ENV, TYPE_SAFE_ENDPOINT, TYPE_SAFE_MODEL, type ClassifierBackend } from "./classifier-backends.ts";
import { piClassificationSupported } from "./classifier-pi-native.ts";
import { resolveTypeSafeApiKey, type TypeSafeCredentialSource } from "./typesafe-classifier.ts";
import { inspectDiagnostics, validateDiagnostics, type BifrostDiagnostic, type InspectDiagnosticsReport, type ValidateDiagnosticsReport } from "./diagnostics.ts";
import type { EconomicDiagnostic, EconomicSnapshot, ReservePolicy } from "./economic-signals.ts";
import { reconcileEconomicSnapshot } from "./economic-config.ts";
import type { AffinityAnchor } from "./affinity.ts";
import {
  buildInitOwnershipReceipt,
  parseReconciliationCommandArgs,
  runReconciliationCommand,
  type ReconciliationCommandReport,
  type ReconciliationCommandRequest,
  type ReconciliationConfigSource,
  type ReconciliationRegistrySnapshot,
  type ReconciliationSourceSnapshot,
} from "./reconciliation-command.ts";
import {
  applyReconciliationTransaction,
  recoverReconciliationTransaction,
  ReconciliationStoreError,
} from "./reconciliation-store.ts";
import { projectProviderRefreshEvidence, waitForRegistryRefresh } from "./registry-refresh.ts";
import { REGISTRY_REFRESH_TTL_MS } from "./ux-status.ts";
import { isVirtualModel } from "./virtual-model.ts";

// ── Mutable state shared across commands ────────────────────

export interface BifrostState {
  config: BifrostConfig;
  /** New routing config semantics are blocked until an accepted config is installed. */
  tierPolicyValid?: boolean;
  economicSnapshot?: EconomicSnapshot;
  economicPolicy?: ReservePolicy;
  /** Private compatibility provenance retained while economics is absent. */
  economicHistoryPolicy?: ReservePolicy;
  economicPolicyValid?: boolean;
  /** Invalid/unsupported affinity namespace must not silently become legacy routing. */
  affinityConfigValid?: boolean;
  economicDiagnostics?: readonly EconomicDiagnostic[];
  economicQuarantinedSourceRevisions?: ReadonlyMap<string, number>;
  enabled: boolean;
  classifierEnabled: boolean;
  pinned: boolean;
  cacheEntries: CacheEntry[];
  reliabilityStore: ReliabilityStore;
  reliabilityV2Store?: ReliabilityV2Store;
  configGeneration?: number;
  reliabilityV2ConfigValid?: boolean;
  reliabilityV2StateError?: string;
  onConfigInstalled?: (config: BifrostConfig, previousConfig: BifrostConfig) => void;
  onManualControl?: (session: object) => void;
  /** Read-only projection of the current branch-local successful Auto anchor. */
  getAffinityAnchor?: (ctx: ExtensionContext) => AffinityAnchor | undefined;
  classifierMetricsStore: ClassifierMetricsStore;
  extensionDir: string;
  /** Uses the extension instance's sticky detector without locking on context-free facts. */
  effectiveClassifierBackend: (config: BifrostConfig) => EffectiveBackend;
  getPipeline: (ctx: ExtensionContext) => ClassificationPipeline;
  invalidatePipeline: () => void;
  /** Leave Bifrost's virtual selection for its last dispatched physical model. */
  selectPhysicalFromVirtual?: (ctx: ExtensionContext) => Promise<boolean>;
  /** Persist runtime mode toggles (enabled/pinned/classifierEnabled) to disk. */
  saveModeState: () => void;
  lastRegistryRefreshAt?: number;
  forceRegistryRefresh?: boolean;
  /** Per-provider, content-free registry refresh evidence for offline reconciliation. */
  registryInventoryEvidence?: Readonly<Record<string, { status: "complete" | "partial" | "stale"; refreshedAt: number }>>;
  /** Recorded when detection fills an absent classifier.backend; status and test report read it (fix 12). */
  classifierDetection?: { backend: ClassifierBackend; reason: string };
}

function installConfigIfTierPoliciesValid(
  state: BifrostState,
  config: BifrostConfig,
  ctx: ExtensionContext,
): boolean {
  const errors = validateTierPolicyConfig(config).filter((issue) => issue.severity === "error");
  errors.push(...validateEconomicConfig(config).filter((issue) => issue.severity === "error"));
  errors.push(...validateConfig(config).filter((issue) => issue.severity === "error" && issue.code?.startsWith("config.reliability_")));
  errors.push(...validateConfig(config).filter((issue) => issue.severity === "error" && issue.code?.startsWith("config.affinity_")));
  const totalTimeoutIssue = classifierTotalTimeoutIssue(config);
  if (totalTimeoutIssue) errors.push(totalTimeoutIssue);
  if (errors.length > 0) {
    log(ctx, `Bifrost config reload rejected: ${errors.map((issue) => issue.message).join(" ")}`, "error");
    return false;
  }
  const previousConfig = state.config;
  const reconciled = reconcileEconomicSnapshot(
    state.economicSnapshot,
    state.economicHistoryPolicy ?? state.economicPolicy,
    config.economics,
    state.economicQuarantinedSourceRevisions,
  );
  state.config = config;
  state.tierPolicyValid = true;
  state.affinityConfigValid = true;
  state.economicSnapshot = reconciled.snapshot;
  state.economicPolicy = reconciled.policy;
  state.economicHistoryPolicy = reconciled.historyPolicy;
  state.economicPolicyValid = validateEconomicConfig(config).every((issue) => issue.severity !== "error");
  state.economicDiagnostics = reconciled.diagnostics;
  state.economicQuarantinedSourceRevisions = reconciled.quarantinedSourceRevisions;
  state.onConfigInstalled?.(config, previousConfig);
  state.invalidatePipeline();
  return true;
}

function installReloadedConfig(
  state: BifrostState,
  loaded: ReturnType<typeof loadConfigForReload>,
  ctx: ExtensionContext,
): boolean {
  if (loaded.diagnostics.length > 0) {
    log(ctx, `Bifrost config reload rejected: ${loaded.diagnostics.map(({ message }) => message).join(" ")}`, "error");
    return false;
  }
  return installConfigIfTierPoliciesValid(state, loaded.config, ctx);
}

export function log(
  ctx: ExtensionContext,
  message: string,
  type?: "info" | "warning" | "error",
) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type ?? "info");
  } else {
    console.error(`[bifrost] ${message}`);
  }
}

export function uiBusy(ctx: ExtensionContext, message: string) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWorkingMessage(message);
    ctx.ui.setWorkingVisible(true);
  } else {
    console.error(`[bifrost] ${message}`);
  }
}

export function uiDone(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWorkingMessage(undefined);
    ctx.ui.setWorkingVisible(false);
  }
}

function promptClassifierModelAvailable(
  ctx: ExtensionContext,
  model: ClassifierConfig["model"],
): boolean {
  return findCandidates(ctx, model).length > 0;
}

async function requestPromptClassifierModel(ctx: ExtensionContext): Promise<string | null> {
  const modelRuntime = {
    getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
    getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
    getError: () => ctx.modelRegistry.getError(),
    refresh: async (options?: { signal?: AbortSignal }) => {
      return ctx.modelRegistry.refresh(options);
    },
  };
  const selected = await ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
    const onSelect = (model: { provider: string; id: string }) => done(`${model.provider}/${model.id}`);
    const onCancel = () => done(null);
    return new ModelSelectorComponent(
      tui,
      ctx.model,
      // The extension facade exposes only registry methods; this adapter
      // implements the subset ModelSelectorComponent consumes.
      modelRuntime as unknown as ModelRuntime,
      ctx.scopedModels,
      onSelect,
      onCancel,
    );
  });
  return selected;
}

function uiOutput(ctx: ExtensionContext, lines: string[]) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", lines);
  } else {
    for (const line of lines) console.error(`[bifrost] ${line}`);
  }
}

async function uiResult(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
  if (await showBifrostResult(ctx, title, lines)) return;
  for (const line of lines) console.error(`[bifrost] ${line}`);
}

export function clearBifrostWidgets(ctx: ExtensionContext) {
  if (ctx.mode === "tui" && ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
}

export function syncBifrostModeStatus(ctx: ExtensionContext, state: Pick<BifrostState, "enabled" | "pinned" | "classifierEnabled" | "config" | "economicPolicyValid">) {
  setBifrostModeStatus(ctx, {
    enabled: state.enabled,
    pinned: state.pinned,
    classifierEnabled: state.classifierEnabled,
    economicMode: state.config.economics?.mode,
    economicPolicyValid: state.economicPolicyValid,
  });
}

function openCircuitCount(state: BifrostState, now = Date.now()): number {
  return state.reliabilityStore.openCircuitCount(now);
}

function formatCandidateLines(
  resolution: HealthyModelResolution,
  selectedKey: string | undefined,
): string[] {
  const skipped = new Map(resolution.skipped.map((item) => [item.key, item]));
  const reserves = new Map((resolution.economic ?? []).map((item) => [item.key, item.evaluation]));
  return resolution.candidates.map((m) => {
    const key = modelKey(m);
    const skippedCandidate = skipped.get(key);
    const reserve = reserves.get(key);
    if (skippedCandidate) {
      const until = skippedCandidate.openUntil
        ? new Date(skippedCandidate.openUntil).toISOString()
        : "unknown";
      return `xx ${key} (open circuit until ${until})`;
    }
    if (reserve?.mode === "policy" && reserve.disposition === "rejected") return `xx ${key} (reserve policy)`;
    const marker = key === selectedKey ? "=>" : "  ";
    const reserveNote = reserve?.mode === "observe" && reserve.wouldReject ? "; reserve would reject" : "";
    return `${marker} ${key} ($${(m.cost.input + m.cost.output).toFixed(2)}/1M tokens, ctx ${m.contextWindow}${reserveNote})`;
  });
}

// ── Shared tier-resolution + display ───────────────────────

/** Placeholder the text views use when a selection did not resolve. */
const PREVIEW_NONE = "none";

/**
 * A tier resolution projected for display. `selected` and `selectedTier` are
 * absent when nothing resolved — never the string "none", which is also a legal
 * tier name. Renderers substitute the `PREVIEW_NONE` placeholder themselves.
 */
export type BifrostTierDisplay = {
  strategy: string;
  selected?: string;
  selectedTier?: string;
  fallbackReason?: string;
  requestedCandidateLines: string[];
  fallbackCandidateLines: string[];
  defaultTier?: string;
  explicitBoundary?: true;
  attemptedTiers?: Array<{ tier: string; strategy: string; candidates: string[] }>;
};

type ResolvedTierDisplay = BifrostTierDisplay & { resolution: RoutedModelResolution };
type AffinityInspectEvidence = {
  mode: "observe" | "retain-within-tier";
  status: "anchored" | "locality_unknown";
  anchor?: { model: string; provider: string; lastSuccessfulAt: string; ageMs: number };
};

function inspectAffinity(state: BifrostState, ctx: ExtensionContext): AffinityInspectEvidence | undefined {
  const mode = state.config.affinity?.mode;
  if (mode !== "observe" && mode !== "retain-within-tier") return undefined;
  const anchor = state.getAffinityAnchor?.(ctx);
  if (!anchor) return { mode, status: "locality_unknown" };
  const now = Date.now();
  return {
    mode,
    status: "anchored",
    anchor: {
      model: anchor.modelKey,
      provider: anchor.provider,
      lastSuccessfulAt: formatDiagnosticTimestamp(anchor.lastSuccessfulDispatchAt),
      ageMs: Math.max(0, now - anchor.lastSuccessfulDispatchAt),
    },
  };
}

function resolveTierDisplay(
  tier: string,
  state: BifrostState,
  ctx: ExtensionContext,
  intrinsicOrigin: string = "automatic",
): ResolvedTierDisplay {
  const affinityMode = state.config.affinity?.mode;
  const anchor = affinityMode === "observe" || affinityMode === "retain-within-tier" ? state.getAffinityAnchor?.(ctx) : undefined;
  const affinity: AffinityRoutingContext | undefined = affinityMode === "observe" || affinityMode === "retain-within-tier"
    ? { intrinsicOrigin, ...(anchor ? { anchor } : {}) }
    : undefined;
  const { options, resolution: resolved } = resolveConfiguredTier(
    ctx,
    tier,
    state.config,
    state.reliabilityStore.getState(),
    state.config.reliability,
    undefined,
    state.config.economics && state.economicPolicyValid && state.economicPolicy && state.economicSnapshot
      ? { policy: state.economicPolicy, snapshot: state.economicSnapshot }
      : undefined,
    undefined,
    affinity,
  );
  const explicitBoundary = resolved.explicitBoundary === true;
  const defaultTier = explicitBoundary ? undefined : options.defaultTier;
  const strategy = explicitBoundary ? resolved.strategy : options.requestedStrategy;

  const selectedKey = resolved.selected ? modelKey(resolved.selected) : undefined;
  const requestedCandidateLines = formatCandidateLines(
    resolved.primary,
    resolved.selectedTier === tier ? selectedKey : undefined,
  );
  const fallbackResolution = explicitBoundary ? resolved.attemptedTiers?.[1]?.resolution : resolved.fallback;
  const fallbackCandidateLines = fallbackResolution
    ? formatCandidateLines(
        fallbackResolution,
        resolved.selectedTier && resolved.selectedTier !== tier ? selectedKey : undefined,
      )
    : [];

  return {
    strategy,
    selected: selectedKey,
    selectedTier: resolved.selectedTier,
    fallbackReason: resolved.fallbackReason,
    requestedCandidateLines,
    fallbackCandidateLines,
    defaultTier,
    ...(explicitBoundary ? {
      explicitBoundary: true as const,
      attemptedTiers: (resolved.attemptedTiers ?? []).map((attempt) => ({
        tier: attempt.tier,
        strategy: attempt.strategy,
        candidates: formatCandidateLines(
          attempt.resolution,
          resolved.selectedTier === attempt.tier ? selectedKey : undefined,
        ),
      })),
    } : {}),
    resolution: resolved,
  };
}

// ── Init proposal builder (exported for tests) ──────────────

/** Default strategy per tier when generating init proposals. */
const PROPOSAL_STRATEGIES: Record<string, RoutingStrategy> = {
  quick: "random",
  general: "first",
  frontier: "first",
  economical: "cheapest",
};

export function buildInitProposal(
  models: Record<string, string[]>,
  classifierModel: string | undefined,
  extensionDir: string,
  classifierBackend: ClassifierBackend = CLASSIFIER_BACKEND_IDS.prompt,
): Record<string, unknown> {
  const tierKeys = Object.keys(models);
  const firstPopulatedTier = Object.entries(models).find(([, candidates]) => candidates.length > 0)?.[0];
  // Prefer general regardless of discovery order; otherwise use first populated tier.
  const defaultTier = (models.general?.length ?? 0) > 0
    ? "general"
    : firstPopulatedTier ?? (tierKeys.includes("general") ? "general" : tierKeys[0] ?? "general");
  const categoryStrategies: Record<string, RoutingStrategy> = {};
  for (const t of tierKeys) {
    categoryStrategies[t] = PROPOSAL_STRATEGIES[t] ?? "first";
  }
  return {
    $schema: `${extensionDir.replace(/\/$/, "")}/schema.json`,
    enabled: true,
    default: defaultTier,
    strategy: "first" as RoutingStrategy,
    categoryStrategies,
    classifier: {
      enabled: true,
      backend: classifierBackend,
      ...(classifierBackend === CLASSIFIER_BACKEND_IDS.prompt && classifierModel ? { model: classifierModel, method: "auto" as const } : {}),
      ...(classifierBackend === CLASSIFIER_BACKEND_IDS.typesafe ? { typesafe: { model: TYPE_SAFE_MODEL }, criteria: DEFAULT_CLASSIFIER_CRITERIA } : {}),
    },
    models,
    rules: DEFAULT_RULES,
  };
}

// ── Command handlers ────────────────────────────────────────

const isForced = (args:string):boolean => args?.split(/\s+/).includes("-f");
const MAX_RECONCILIATION_CONFIG_BYTES = 10_000_000;
const MAX_RECONCILIATION_OWNERSHIP_BYTES = 5_000_000;

function reconciliationPaths(source: ReconciliationConfigSource): { configPath: string; ownershipPath: string; journalPath: string } {
  const directory = source === "project" ? join(process.cwd(), CONFIG_DIR_NAME) : getAgentDir();
  return {
    configPath: join(directory, "bifrost.json"),
    ownershipPath: join(directory, "bifrost-reconcile-ownership.json"),
    journalPath: join(directory, "bifrost-reconcile.journal"),
  };
}

function readReconciliationSource(source: ReconciliationConfigSource): ReconciliationSourceSnapshot {
  const paths = reconciliationPaths(source);
  const configBytes = readBoundedRegularSnapshot(paths.configPath) ?? null;
  const ownershipBytes = readBoundedRegularSnapshot(paths.ownershipPath) ?? null;
  if (configBytes && configBytes.byteLength > MAX_RECONCILIATION_CONFIG_BYTES
    || ownershipBytes && ownershipBytes.byteLength > MAX_RECONCILIATION_OWNERSHIP_BYTES) {
    throw new Error("source exceeds reconciliation bounds");
  }
  return { ...paths, source, configBytes, ownershipBytes };
}

function reconciliationRegistrySnapshot(
  ctx: ExtensionContext,
  state: BifrostState,
  provider: string,
  now = Date.now(),
): ReconciliationRegistrySnapshot {
  let models: ReconciliationRegistrySnapshot["models"] = [];
  let hasRegistryError = false;
  const knownProviders = new Set<string>();
  try {
    const all = ctx.modelRegistry.getAll();
    models = all.map((model) => ({ provider: model.provider, id: model.id, virtual: isVirtualModel(model) }));
    for (const model of models) if (!model.virtual) knownProviders.add(model.provider);
  } catch {
    hasRegistryError = true;
  }
  try {
    if (ctx.modelRegistry.getProvider(provider)) knownProviders.add(provider);
  } catch {
    hasRegistryError = true;
  }
  try {
    hasRegistryError ||= Boolean(ctx.modelRegistry.getError());
  } catch {
    hasRegistryError = true;
  }
  let authConfigured: boolean | undefined;
  try {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    if (status && typeof status.configured === "boolean") authConfigured = status.configured;
  } catch {
    authConfigured = undefined;
  }
  const rawEvidence = state.registryInventoryEvidence?.[provider];
  const refreshEvidence = rawEvidence
    && (rawEvidence.status === "complete" || rawEvidence.status === "partial" || rawEvidence.status === "stale")
    && Number.isFinite(rawEvidence.refreshedAt)
    ? { status: rawEvidence.status, refreshedAt: rawEvidence.refreshedAt }
    : undefined;
  return {
    models,
    knownProviders: [...knownProviders],
    authConfigured,
    hasRegistryError,
    forceRefresh: state.forceRegistryRefresh === true,
    refreshEvidence,
    now,
    freshnessTtlMs: REGISTRY_REFRESH_TTL_MS,
  };
}

function setRegistryProviderEvidence(
  state: BifrostState,
  provider: string,
  evidence: { readonly status: "complete" | "partial" | "stale"; readonly refreshedAt: number },
): void {
  state.registryInventoryEvidence = Object.freeze({
    ...(state.registryInventoryEvidence ?? {}),
    [provider]: Object.freeze({ status: evidence.status, refreshedAt: evidence.refreshedAt }),
  });
}

function prospectiveConfigInstallable(source: ReconciliationConfigSource, bytes: Uint8Array, state: BifrostState): boolean {
  const loaded = loadConfigWithSourceOverride(process.cwd(), state.extensionDir, source, bytes);
  if (loaded.diagnostics.length > 0) return false;
  const errors = validateTierPolicyConfig(loaded.config).filter((issue) => issue.severity === "error");
  const validation = validateConfig(loaded.config);
  errors.push(...validation.filter((issue) => issue.severity === "error"
    && (issue.code?.startsWith("config.reliability_") || issue.code?.startsWith("config.affinity_"))));
  return errors.length === 0 && classifierTotalTimeoutIssue(loaded.config) === undefined;
}

function reconciliationReportLines(report: ReconciliationCommandReport): string[] {
  const lines = ["--- config reconcile ---", `source: ${report.source}`, `status: ${report.status}`];
  if (report.provider) lines.push(`provider: ${report.provider}`);
  if (report.tier) lines.push(`tier: ${report.tier}`);
  if (report.inventoryStatus) lines.push(`inventory: ${report.inventoryStatus}`);
  if (report.reason) lines.push(`reason: ${report.reason}`);
  if (report.proposalDigest) lines.push(`proposal: ${report.proposalDigest}`);
  if (report.changes.length) {
    lines.push("changes:", ...report.changes.map((change) => `  ${change.disposition} ${change.kind} ${change.tier}: ${change.modelKey}`));
  } else lines.push("changes: none");
  if (report.warnings.length) lines.push(`warnings: ${report.warnings.join(", ")}`);
  if (report.applyResult?.configBackupPath) lines.push(`config backup: ${report.applyResult.configBackupPath}`);
  if (report.applyResult?.ownershipBackupPath) lines.push(`ownership backup: ${report.applyResult.ownershipBackupPath}`);
  if (report.reason === "operator_repair_required") {
    lines.push("repair: verify no Bifrost writer is active, inspect and remove only its exact stale reconciliation lock files, then retry recover.");
  }
  lines.push("-----------------------");
  return lines;
}

function emitReconciliationReport(ctx: ExtensionContext, report: ReconciliationCommandReport, json: boolean): void {
  if (json) {
    console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify({
      ...report,
      ...(report.reason === "operator_repair_required"
        ? { operatorGuidance: "verify_no_active_writer_remove_exact_stale_locks_then_retry_recover" }
        : {}),
    })}`);
  } else {
    uiOutput(ctx, reconciliationReportLines(report));
  }
}

function blockedReconciliationReport(
  request: ReconciliationCommandRequest,
  reason: "source_invalid" | "store_io_failure",
): ReconciliationCommandReport {
  return { action: request.action, source: request.source, status: "blocked", reason, changes: [], warnings: [] };
}

async function handleReconciliationCommand(args: string, ctx: ExtensionContext, state: BifrostState): Promise<void> {
  const commandArgs = args.replace(/^config\s+reconcile(?:\s+|$)/iu, "");
  const parsed = parseReconciliationCommandArgs(commandArgs);
  if (!parsed.ok) {
    log(ctx, "usage: /bifrost config reconcile [--source project|user] [--tier <tier> --provider <provider>] [--refresh | --apply --proposal <digest> | --recover] [--json]", "warning");
    return;
  }
  const request = parsed.request;
  let source: ReconciliationSourceSnapshot;
  try {
    if (request.action === "recover") {
      source = { ...reconciliationPaths(request.source), source: request.source, configBytes: null, ownershipBytes: null };
    } else source = readReconciliationSource(request.source);
  } catch {
    emitReconciliationReport(ctx, blockedReconciliationReport(request, "source_invalid"), request.json);
    return;
  }

  if (request.action === "preview" && request.refresh) {
    const initial = reconciliationRegistrySnapshot(ctx, state, request.provider);
    if (!initial.knownProviders.includes(request.provider)) {
      const { refresh: _refresh, ...previewRequest } = request;
      const report = runReconciliationCommand(previewRequest, { source, registry: initial }, {
        validateMergedConfig: () => false,
        apply: applyReconciliationTransaction,
        recover: recoverReconciliationTransaction,
      });
      emitReconciliationReport(ctx, report, request.json);
      return;
    }
    if (ctx.hasUI && !(await ctx.ui.confirm(
      "Refresh provider model catalog?",
      `Contact ${request.provider} to refresh its model catalog before previewing. This will not apply config changes.`,
    ))) {
      log(ctx, "catalog refresh cancelled; no config proposal was made");
      return;
    }
    uiBusy(ctx, `Refreshing ${request.provider} model catalog...`);
    try {
      const outcome = await waitForRegistryRefresh(
        (signal) => ctx.modelRegistry.refresh({ allowNetwork: true, force: true, providers: [request.provider], signal }),
        ctx.signal,
        (result) => setRegistryProviderEvidence(state, request.provider, projectProviderRefreshEvidence(
          result,
          request.provider,
          initial.knownProviders,
          Date.now(),
        )),
      );
      if (outcome === "aborted") {
        setRegistryProviderEvidence(state, request.provider, { status: "stale", refreshedAt: Date.now() });
        emitReconciliationReport(ctx, {
          action: "preview", source: request.source, status: "aborted", reason: "inventory_stale",
          provider: request.provider, tier: request.tier, changes: [], warnings: [],
        }, request.json);
        return;
      }
    } catch {
      setRegistryProviderEvidence(state, request.provider, { status: "stale", refreshedAt: Date.now() });
    } finally {
      uiDone(ctx);
    }
  }

  const registry = request.action === "recover"
    ? reconciliationRegistrySnapshot(ctx, state, "")
    : reconciliationRegistrySnapshot(ctx, state, request.provider);
  const dependencies = {
    validateMergedConfig: (selected: ReconciliationConfigSource, bytes: Uint8Array) => prospectiveConfigInstallable(selected, bytes, state),
    apply: applyReconciliationTransaction,
    recover: recoverReconciliationTransaction,
  };
  const planRequest: ReconciliationCommandRequest = request.action === "preview" && request.refresh
    ? (({ refresh: _refresh, ...previewRequest }) => previewRequest)(request)
    : request;
  const report = runReconciliationCommand(planRequest, { source, registry }, dependencies);
  if (report.status === "committed") {
    const loaded = loadConfigForReload(process.cwd(), state.extensionDir);
    if (!installReloadedConfig(state, loaded, ctx)) {
      emitReconciliationReport(ctx, report, request.json);
      return;
    }
    syncBifrostModeStatus(ctx, state);
    clearBifrostWidgets(ctx);
  }
  emitReconciliationReport(ctx, report, request.json);
}

async function handleInit(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  clearBifrostWidgets(ctx);
  // Try to load cached probe results. If stale or missing, run probe inline.
  const probePath = join(process.cwd(), ".pi", "bifrost-probe.json");
  let workingModels: { provider: string; model: string; cost: { input: number; output: number }; duration_ms: number }[] = [];
  let probeLoaded = false;
  let probeAge = "";

  if (existsSync(probePath)) {
    try {
      const probeData = JSON.parse(readFileSync(probePath, "utf-8"));
      const probeStat = statSync(probePath);
      const ageMs = Date.now() - probeStat.mtimeMs;
      const ageMin = Math.round(ageMs / 60000);

      if (ageMs < 3600_000 && !isForced(args)) {
        workingModels = probeData
          .filter((r: any) => r.status === "ok")
          .map((r: any) => ({
            provider: r.provider,
            model: r.model,
            cost: { input: r.cost_input ?? 0, output: r.cost_output ?? 0 },
            duration_ms: r.duration_ms ?? 0,
          }));
        probeAge = `${ageMin}m ago`;
        probeLoaded = true;
      }
    } catch {
      // Corrupt — will re-probe below.
    }
  }

  // If no fresh probe data, run probe inline.
  if (!probeLoaded) {
    const available = ctx.modelRegistry.getAvailable();
    const availableCount = available.length;
    log(ctx, `Probing ${availableCount} models to find working ones...`);
    let okCount = 0;
    let errCount = 0;
    const lastModels: string[] = [];

    uiBusy(ctx, `Probing ${availableCount} models...`);
    const { results } = await runProbe(ctx, {
      ...probeOptionsFromConfig(state.config.probe),
      onProgress: (done, total, last) => {
        if (last.status === "ok") okCount++;
        else if (last.status === "error" || last.status === "timeout") errCount++;
        lastModels.push(`${last.provider}/${last.model}: ${last.status} (${last.duration_ms}ms)`);
        if (lastModels.length > 5) lastModels.shift();

        if (ctx.hasUI) {
          ctx.ui.setWidget("bifrost-probe", [
            `Probing models: ${done}/${total}`,
            `  ok: ${okCount}  errors: ${errCount}`,
            "",
            ...lastModels,
          ]);
        }
      },
    });
    uiDone(ctx);
    state.reliabilityStore.applyOutcomes(
      results.map((r) =>
        r.status === "ok"
          ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
          : { model: `${r.provider}/${r.model}`, ok: false as const, source: "probe", reason: r.error ?? r.status }
      ),
      Date.now()
    );

    workingModels = results
      .filter((r) => r.status === "ok")
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        cost: { input: r.cost_input ?? 0, output: r.cost_output ?? 0 },
        duration_ms: r.duration_ms ?? 0,
      }));
    probeLoaded = true;
    probeAge = "just now";

    const ok = results.filter((r) => r.status === "ok").length;
    const errors = results.filter((r) => r.status === "error").length;
    const timeouts = results.filter((r) => r.status === "timeout").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    log(ctx, `Probe complete: ok=${ok} error=${errors} timeout=${timeouts} skipped=${skipped}.`);
    if (ok === 0) {
      log(ctx, "No usable models found. Check API keys, network, and credits.", "error");
      log(ctx, "Proceeding with full registry — most models will likely be unreachable.", "warning");
      probeLoaded = false;
    }
  }

  if (probeLoaded && workingModels.length > 0) {
    log(ctx, `Using ${workingModels.length} probe-verified models (${probeAge}).`);
  }

  const available = ctx.modelRegistry.getAvailable();
  const models: Record<string, string[]> = {};
  const uncategorized: string[] = [];

  for (const m of available) {
    const key = `${m.provider}/${m.id}`;

    // If probe data is loaded, skip models that failed or timed out.
    if (probeLoaded && workingModels.length > 0) {
      const working = workingModels.find(
        (w) => w.provider === m.provider && w.model === m.id,
      );
      if (!working) continue; // known-broken, silently skip
    }

    const tier = guessTier(m);
    if (tier) {
      models[tier] = models[tier] ?? [];
      models[tier].push(key);
    } else {
      uncategorized.push(key);
    }
  }

  // Sort each tier by probe response time (fastest first) so "first"
  // strategy picks the fastest model.
  if (probeLoaded) {
    const speedMap = new Map(workingModels.map((w) => [`${w.provider}/${w.model}`, w.duration_ms]));
    for (const tier of Object.keys(models)) {
      models[tier].sort((a, b) => (speedMap.get(a) ?? Infinity) - (speedMap.get(b) ?? Infinity));
    }
  }

  // Pick a classifier default: fastest cheap working model.
  let classifierModel: string | undefined;
  if (probeLoaded && workingModels.length > 0) {
    const cheapWorking = workingModels
      .filter((w) => (w.cost.input + w.cost.output) < 2)
      .sort((a, b) => a.duration_ms - b.duration_ms);
    if (cheapWorking.length > 0) {
      classifierModel = `${cheapWorking[0].provider}/${cheapWorking[0].model}`;
    }
  }
  if (!classifierModel) {
    // Fallback: any working model, or a sensible default.
    if (workingModels.length > 0) {
      classifierModel = `${workingModels[0].provider}/${workingModels[0].model}`;
    } else {
      log(ctx, "No working models found for classifier. Init will omit classifier.model; regex fallback remains available.", "warning");
    }
  }

  const proposal = buildInitProposal(
    models,
    classifierModel,
    state.extensionDir,
    state.config.classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt,
  );

  const totalAssigned = Object.values(models).reduce((s, v) => s + v.length, 0);
  uiOutput(ctx, [
    "--- init ---",
    `source: ${probeLoaded ? `probe (${workingModels.length} working)` : `registry (${available.length} listed)`}`,
    `assigned: ${totalAssigned} models`,
    `classifier: ${classifierModel}`,
    `uncategorized: ${uncategorized.length}`,
    "proposed config:",
    JSON.stringify(proposal, null, 2),
    "----------------",
    probeLoaded ? "" : "⚠ Run /bifrost probe first to filter unreachable models.",
    "Assign uncategorized models manually in the generated config.",
  ].filter(Boolean));

  if (uncategorized.length > 0) {
    log(ctx, `${uncategorized.length} model(s) uncategorized — edit .pi/bifrost.json to assign them.`);
  }

  const writeWithoutPrompt = args.trim().split(/\s+/).includes("--write");
  if (!ctx.hasUI && !writeWithoutPrompt) {
    log(ctx, "run in TUI or use --write to persist", "warning");
    return;
  }

  const ok = writeWithoutPrompt || await ctx.ui.confirm(
    "Write config?",
    "Write proposed config to .pi/bifrost.json?",
  );
  if (!ok) {
    log(ctx, "config not written");
    return;
  }

  const dir = join(process.cwd(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "bifrost.json");
  const ownershipPath = join(dir, "bifrost-reconcile-ownership.json");
  const journalPath = join(dir, "bifrost-reconcile.journal");
  if (existsSync(ownershipPath)) {
    log(ctx, "Init will not replace a config with a reconciliation ownership receipt, because regeneration could discard managed-membership history. Use config reconcile to review membership changes; no files were changed.", "warning");
    return;
  }
  let previousConfig: Buffer | undefined;
  try { previousConfig = readBoundedRegularSnapshot(configPath); }
  catch {
    log(ctx, "Init could not safely snapshot the current config; no files were changed.", "error");
    return;
  }
  let previouslyConfiguredModels: Record<string, string | string[]> = {};
  if (previousConfig) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(previousConfig)); }
    catch {
      log(ctx, "Init could not safely read the existing config's model memberships; no files were changed.", "error");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(ctx, "Init could not safely read the existing config's model memberships; no files were changed.", "error");
      return;
    }
    const rawModels = (parsed as Record<string, unknown>).models;
    if (rawModels !== undefined) {
      if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)
        || Object.values(rawModels).some((pool) => typeof pool !== "string"
          && (!Array.isArray(pool) || pool.some((entry) => typeof entry !== "string")))) {
        log(ctx, "Init could not safely read the existing config's model memberships; no files were changed.", "error");
        return;
      }
      previouslyConfiguredModels = rawModels as Record<string, string | string[]>;
    }
  }
  const ownership = buildInitOwnershipReceipt(models, previouslyConfiguredModels);
  if (!ownership) {
    log(ctx, "Init could not create a safe exact-membership ownership receipt; no files were changed.", "error");
    return;
  }
  const configBytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  const ownershipBytes = Buffer.from(`${JSON.stringify(ownership, null, 2)}\n`, "utf8");
  if (previousConfig && previousConfig.byteLength > MAX_RECONCILIATION_CONFIG_BYTES
    || configBytes.byteLength > MAX_RECONCILIATION_CONFIG_BYTES
    || !prospectiveConfigInstallable("project", configBytes, state)) {
    log(ctx, "Init's proposed config is invalid or exceeds the safe write limit; no files were changed.", "error");
    return;
  }
  try {
    applyReconciliationTransaction({
      configPath,
      ownershipPath,
      journalPath,
      expectedConfigDigest: previousConfig ? createHash("sha256").update(previousConfig).digest("hex") : null,
      expectedOwnershipDigest: null,
      nextConfigBytes: configBytes,
      nextOwnershipBytes: ownershipBytes,
    });
  } catch (error) {
    const locked = error instanceof ReconciliationStoreError && error.code === "locked";
    log(ctx, locked
      ? "Init could not acquire reconciliation locks. If a prior process crashed, verify it is stopped and repair only its exact stale lock files before retrying. No files were changed."
      : "Init could not safely commit its config and ownership receipt; existing files were preserved.", "error");
    return;
  }

  // Auto-reload so the extension picks up the new config immediately.
  const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
  if (!installReloadedConfig(state, loadedConfig, ctx)) return;
  const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
    enabled: state.config.enabled ?? true,
    pinned: false,
    classifierEnabled: state.config.classifier?.enabled ?? true,
  });
  state.enabled = runtimeState.enabled;
  state.classifierEnabled = runtimeState.classifierEnabled;
  state.reliabilityStore.reload(state.config.reliability, process.cwd());
  state.classifierMetricsStore.reload({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(state.config, state.effectiveClassifierBackend(state.config).backend),
  });
  log(ctx, "wrote .pi/bifrost.json and reloaded config");
  log(ctx, `Bifrost active with ${Object.keys(state.config.models ?? {}).length} tier(s). Try a prompt.`);
  log(ctx, "Next: run /bifrost classifier to choose the routing backend.");
  if (ctx.mode === "tui" && ctx.hasUI && !writeWithoutPrompt && await ctx.ui.confirm(
    "Choose classifier backend?",
    "Open /bifrost classifier now?",
  )) {
    await handleClassifierChoose(ctx, state);
  }

  // Clear the init widget so it doesn't persist in the TUI.
  if (ctx.hasUI) {
    ctx.ui.setWidget("bifrost-output", []);
    ctx.ui.setWidget("bifrost-probe", []);
  }
}

function increasedMetric(
  after: Readonly<Record<string, number>>,
  before: Readonly<Record<string, number>>,
): string | undefined {
  return Object.entries(after).find(([key, count]) => count > (before[key] ?? 0))?.[0];
}

export function buildClassifierTestReport(input: {
  classifier: ClassifierConfig | undefined;
  result: ClassificationResult;
  before: ClassifierMetricsState;
  after: ClassifierMetricsState;
  credential?: TypeSafeCredentialSource;
  effectiveBackend?: EffectiveBackend;
}): string[] {
  const { classifier, result, before, after, credential } = input;
  const effective = input.effectiveBackend;
  const backend = effective?.backend ?? classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt;
  const backendLabel = effective?.auto ? `auto: ${backend} (${effective.reason})` : backend;
  const judgment = result.kind === "classified" ? result.judgment : undefined;
  const outcome = increasedMetric(after.outcomes, before.outcomes);
  const observedTier = judgment?.backend === backend
    ? judgment.tier
    : increasedMetric(after.tiers, before.tiers);
  const observedConfidence = judgment?.backend === backend && judgment.confidence !== undefined
    ? String(judgment.confidence)
    : increasedMetric(after.confidenceBands, before.confidenceBands) ?? "n/a";
  const rawPromptModel = classifier?.model;
  const configuredModel = Array.isArray(rawPromptModel) ? rawPromptModel.join(", ") : rawPromptModel;
  const model = judgment?.backend === backend
    ? judgment.model
    : backend === CLASSIFIER_BACKEND_IDS.typesafe
      ? classifier?.typesafe?.model ?? TYPE_SAFE_MODEL
      : backend === CLASSIFIER_BACKEND_IDS.piNative
        ? classifier?.piNative?.model ?? "catalog default"
        : configuredModel;
  const finalResult = result.kind === "unclassified" ? "unclassified" : result.tier;
  const finalSource = result.kind === "classified" ? result.source : result.kind;
  const accepted = result.kind === "classified" && judgment?.backend === backend;
  const lines = [
    "--- classifier test ---",
    `backend: ${backendLabel}`,
    `model: ${model ?? "none"}`,
    `backend result: ${observedTier ?? "none"}`,
    `confidence: ${observedConfidence}`,
    `accepted: ${accepted ? "yes" : "no"}`,
    `final result: ${finalResult}`,
    `final source: ${finalSource}`,
    `final backend: ${judgment?.backend ?? "none"}`,
    `final model: ${judgment?.model ?? "none"}`,
    `request observed: ${after.total > before.total ? "yes" : "no"}`,
  ];
  if (backend === CLASSIFIER_BACKEND_IDS.typesafe) lines.push(`credential: ${credential ?? "missing"}`);
  if (backend !== CLASSIFIER_BACKEND_IDS.prompt && after.total > before.total) {
    lines.push(`outcome: ${outcome ?? "recorded"}`);
  }
  lines.push("-----------------------");
  return lines;
}

async function handleClassifierTest(ctx: ExtensionContext, state: BifrostState): Promise<void> {
  const classifier = state.config.classifier;
  if (!state.classifierEnabled || classifier?.enabled === false) {
    log(ctx, "Classifier is disabled; run /bifrost classifier on first", "warning");
    return;
  }
  const before = state.classifierMetricsStore.snapshot();
  clearBifrostWidgets(ctx);
  uiBusy(ctx, "Testing classifier backend...");
  const prompt = `Assess this small bounded request for tier selection. Verification nonce ${Date.now()}.`;
  let result;
  try {
    result = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  const after = state.classifierMetricsStore.snapshot();
  const credential = classifier?.backend === CLASSIFIER_BACKEND_IDS.typesafe
    ? resolveTypeSafeApiKey().source
    : undefined;
  await uiResult(ctx, "Classifier test", buildClassifierTestReport({
    classifier,
    result,
    before,
    after,
    credential,
    effectiveBackend: state.effectiveClassifierBackend(state.config),
  }));
}

/**
 * Same precondition as `parsePreviewArgs`: `args` carries the `benchmark`
 * subcommand word, which `BENCHMARK_SUB.length` characters are removed before
 * the default prompt is substituted. Extracting the word to a named constant is
 * all this needed; giving it the explicit-parameter treatment would mean
 * threading the matched subcommand through `CommandFn`, a broader router change
 * than this fix warrants. Behavior is unchanged.
 */
const BENCHMARK_SUB = "benchmark";

async function handleBenchmark(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const prompt =
    args.slice(BENCHMARK_SUB.length).trim() ||
    "Write a short Python function to reverse a string and explain it briefly.";
  const categories = Object.keys(state.config.models ?? {});

  if (categories.length === 0) {
    log(ctx, "no categories configured; run /bifrost init first", "warning");
    return;
  }

  clearBifrostWidgets(ctx);
  setBifrostStatus(ctx, "benchmarking prompt...", "accent");
  uiBusy(ctx, "Classifying benchmark prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  const tier = classification.kind !== "unclassified" ? classification.tier : undefined;
  const source = classification.kind === "classified" ? classification.source : "fallback";

  const lines = [
    "--- benchmark ---",
    `prompt: ${prompt}`,
    `tier: ${tier ?? "none"}`,
    `source: ${source}`,
    "per-tier selection:",
  ];

  for (const tierName of categories) {
    const display = resolveTierDisplay(tierName, state, ctx);
    lines.push(`  ${tierName} (${display.strategy} → ${display.selectedTier ?? PREVIEW_NONE}):`);
    if (display.fallbackReason) lines.push(`    fallback: ${display.fallbackReason}`);
    lines.push(...display.requestedCandidateLines.map((line) => `    ${line}`));
    if (display.fallbackCandidateLines.length > 0 && display.defaultTier && display.defaultTier !== tierName) {
      lines.push(`    fallback candidates (${display.defaultTier}):`);
      lines.push(...display.fallbackCandidateLines.map((line) => `    ${line}`));
    }
  }

  lines.push("-----------------");
  await uiResult(ctx, "Bifrost benchmark", lines);
}

// ── Preview report ──────────────────────────────────────────

/**
 * Machine-readable shape of one `/bifrost preview` decision. Every field is a
 * primitive so the report survives `JSON.stringify` on a single line. Optional
 * keys are omitted rather than set to null, so a consumer can test for the
 * absence of a backend, model, confidence, or fallback reason.
 *
 * `ok` discriminates the outcome: `true` carries a routing decision, `false`
 * carries the reason no decision was made. Both halves keep `prompt`, so a
 * caller can always say which prompt it asked about. `--json` emits exactly one
 * of these lines on every path, so a consumer never has to infer the outcome
 * from a missing line.
 *
 * `selected` and `selectedTier` are omitted when nothing resolved. A `"none"`
 * string would be ambiguous: it is also a legal tier name, so it could mean
 * "nothing selected" or "selected inside a tier named none". The text view
 * substitutes the `"none"` placeholder itself, so the rendered output is
 * unchanged.
 *
 * This is a projection of what `resolveTierDisplay` already computes. It carries
 * no stage timings or structured candidate records. The opt-in `--trace` path
 * uses the separate RouteDecisionSummary type (ADR 0007).
 */
export type BifrostPreviewReport = BifrostPreviewSuccess | BifrostPreviewFailure;

/** A routing decision was made for the prompt. */
export type BifrostPreviewSuccess = {
  readonly ok: true;
  readonly prompt: string;
  readonly source: ClassificationSource | "fallback";
  readonly backend?: string;
  readonly model?: string;
  readonly confidence?: number;
  readonly tier: string;
  readonly strategy: string;
  readonly selectedTier?: string;
  readonly fallbackReason?: string;
  readonly requestedCandidates: string[];
  readonly fallbackCandidates: string[];
  readonly defaultTier?: string;
  readonly selected?: string;
  readonly fallbackBoundary?: "explicit";
  readonly attemptedTiers?: Array<{ readonly tier: string; readonly strategy: string; readonly candidates: string[] }>;
};

/** No routing decision was made, so no routing field is reported. */
export type BifrostPreviewFailure = {
  readonly ok: false;
  readonly prompt: string;
  readonly error: "usage" | "unclassified";
};

/** Marker prefix for machine-readable command output, so a caller can find the line without guessing. */
export const BIFROST_JSON_PREFIX = "[bifrost-json] ";

/** The `preview` subcommand word, as it appears in `args` and in the registry. Single source so the parser, the completion row, and the menu row cannot drift. */
const PREVIEW_SUB = "preview";

/**
 * Split leading preview flags from the prompt. Each supported flag is consumed
 * at most once; a duplicate flag remains prompt text for compatibility.
 *
 * Precondition: `args` is the full argument string including the subcommand
 * word, and `sub` is that word. `sub` is a parameter rather than a hardcoded
 * slice so the precondition is visible at every call site and the truncation can
 * never exceed what the caller actually passed. `args` is sliced by
 * `sub.length`, so a caller that claims a prefix the args do not have silently
 * loses that many leading characters; pass the real subcommand, or pass `""` to
 * parse a bare prompt with nothing removed.
 */
export function parsePreviewArgs(args: string, sub: string): { prompt: string; json: boolean; trace?: true } {
  let rest = args.slice(sub.length).trim();
  let json = false;
  let trace = false;
  while (rest.startsWith("--json") || rest.startsWith("--trace")) {
    const flag = /^(--json|--trace)(?=\s|$)/.exec(rest)?.[1];
    if (!flag) break;
    if ((flag === "--json" && json) || (flag === "--trace" && trace)) break;
    json ||= flag === "--json";
    trace ||= flag === "--trace";
    rest = rest.slice(flag.length).trimStart();
  }
  const parsed = { prompt: rest.trim(), json };
  return trace ? { ...parsed, trace: true } : parsed;
}

/** Build the failure half of the report. Pure: no classification, no display, no side effects. */
export function buildPreviewFailure(prompt: string, error: BifrostPreviewFailure["error"]): BifrostPreviewFailure {
  return { ok: false, prompt, error };
}

export function buildPreviewReport(input: {
  prompt: string;
  classification: Exclude<ClassificationResult, { kind: "unclassified" }>;
  display: BifrostTierDisplay;
}): BifrostPreviewSuccess {
  const { prompt, classification, display } = input;
  const judgment = classification.kind === "classified" ? classification.judgment : undefined;
  return {
    ok: true,
    prompt,
    source: classification.kind === "classified" ? classification.source : "fallback",
    ...(judgment ? { backend: judgment.backend } : {}),
    ...(judgment?.model !== undefined ? { model: judgment.model } : {}),
    ...(judgment?.confidence !== undefined ? { confidence: judgment.confidence } : {}),
    tier: classification.tier,
    strategy: display.strategy,
    // An unresolved selection arrives as an absent value, so omitting the key is
    // a true absence signal. A selection that resolved into a tier named "none"
    // keeps its key and reports the string.
    ...(display.selectedTier !== undefined ? { selectedTier: display.selectedTier } : {}),
    ...(display.fallbackReason !== undefined ? { fallbackReason: display.fallbackReason } : {}),
    requestedCandidates: display.requestedCandidateLines,
    fallbackCandidates: display.fallbackCandidateLines,
    ...(display.defaultTier !== undefined ? { defaultTier: display.defaultTier } : {}),
    ...(display.selected !== undefined ? { selected: display.selected } : {}),
    ...(display.explicitBoundary ? {
      fallbackBoundary: "explicit" as const,
      attemptedTiers: display.attemptedTiers ?? [],
    } : {}),
  };
}

export function serializePreviewReport(report: BifrostPreviewReport): string {
  return JSON.stringify(report);
}

export type BifrostTracePreview = RouteDecisionSummary & {
  readonly classifierDisclosure: {
    readonly enabled: boolean;
    readonly configuredClassifierMayReceivePrompt: boolean;
  };
};

export function buildTracePreview(
  summary: RouteDecisionSummary,
  classifierEnabled: boolean,
): BifrostTracePreview {
  return {
    ...summary,
    classifierDisclosure: {
      enabled: classifierEnabled,
      configuredClassifierMayReceivePrompt: classifierEnabled,
    },
  };
}

export function renderTracePreview(trace: BifrostTracePreview): string[] {
  const lines = [
    "--- route trace v1 ---",
    `outcome: ${trace.outcome}`,
    `classification: ${trace.classification.source}${trace.classification.tier ? ` → ${trace.classification.tier}` : ""}`,
    `classifier disclosure: ${trace.classifierDisclosure.enabled
      ? "enabled; the configured classifier may receive the preview prompt"
      : "disabled; preview prompt is not sent to a classifier"}`,
  ];
  if (trace.classification.classifier) {
    lines.push(`classifier: ${trace.classification.classifier.backend}`);
    if (trace.classification.classifier.model !== undefined) lines.push(`classifier model: ${trace.classification.classifier.model}`);
    if (trace.classification.classifier.confidence !== undefined) lines.push(`classifier confidence: ${trace.classification.classifier.confidence}`);
  }
  const renderPool = (label: string, pool: RouteDecisionSummary["requested"] | RouteDecisionSummary["fallback"]) => {
    if (!pool) return;
    lines.push(`${label}: ${pool.tier} (${pool.strategy})`);
    for (const candidate of pool.candidates) {
      lines.push(`  ${candidate.status}: ${candidate.model}${candidate.exclusion ? ` (${candidate.exclusion})` : ""}`);
    }
  };
  if (trace.explicitBoundary && trace.attempted) {
    lines.push("fallback boundary: explicit");
    trace.attempted.forEach((pool, index) => renderPool(`attempt ${index + 1}`, pool));
  } else {
    renderPool("requested", trace.requested);
    renderPool("fallback", trace.fallback);
  }
  if (trace.fallbackReason) lines.push(`fallback reason: ${trace.fallbackReason}`);
  if (trace.affinity) {
    lines.push(`affinity: ${trace.affinity.mode} (${trace.affinity.status}; selection=${trace.affinity.selection})`);
    if (trace.affinity.status !== "not_applicable" && trace.affinity.anchor) {
      lines.push(`  anchor: ${trace.affinity.anchor.modelKey} at ${formatDiagnosticTimestamp(trace.affinity.anchor.lastSuccessfulDispatchAt)}`);
    }
    if (trace.affinity.strategyWinner) lines.push(`  strategy winner: ${trace.affinity.strategyWinner}`);
    if (trace.affinity.selectedModel) lines.push(`  selected model: ${trace.affinity.selectedModel}`);
    if (trace.affinity.selectedTier) lines.push(`  selected tier: ${trace.affinity.selectedTier}`);
  }
  if (trace.selectedStrategy) lines.push(`selected strategy: ${trace.selectedStrategy}`);
  lines.push(`selected: ${trace.selected ? `${trace.selectedTier} → ${trace.selected}` : "none"}`);
  lines.push("----------------------");
  return lines;
}

export function renderPreviewReport(report: BifrostPreviewSuccess): string[] {
  return [
    "--- preview ---",
    `prompt:    ${report.prompt}`,
    `source:    ${report.source}`,
    // The JSON report omits absent fields; the human view keeps the historical
    // "none" / "n/a" placeholders so the TUI output does not change.
    ...(report.backend ? [
      `backend:   ${report.backend}`,
      `model:     ${report.model ?? "none"}`,
      `confidence:${report.confidence === undefined ? " n/a" : ` ${report.confidence}`}`,
    ] : []),
    `tier:      ${report.tier}`,
    `strategy:  ${report.strategy}`,
    `selected tier: ${report.selectedTier ?? PREVIEW_NONE}`,
    ...(report.fallbackReason ? [`fallback:  ${report.fallbackReason}`] : []),
    `requested candidates (${report.tier}):`,
    ...report.requestedCandidates,
    ...(report.fallbackCandidates.length > 0 && report.defaultTier && report.defaultTier !== report.tier
      ? [`fallback candidates (${report.defaultTier}):`, ...report.fallbackCandidates]
      : []),
    ...(report.fallbackBoundary === "explicit" ? [
      "fallback boundary: explicit",
      ...(report.attemptedTiers ?? []).flatMap((attempt, index) => [
        `attempt ${index + 1} (${attempt.tier}, ${attempt.strategy}):`,
        ...attempt.candidates.map((candidate) => `  ${candidate}`),
      ]),
    ] : []),
    `selected:  ${report.selected ?? PREVIEW_NONE}`,
    "---------------",
  ];
}

/** Write the one machine-readable line for a preview, successful or not. */
function emitPreviewReport(report: BifrostPreviewReport): void {
  console.error(`${BIFROST_JSON_PREFIX}${serializePreviewReport(report)}`);
}

async function handlePreview(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const { prompt, json, trace } = parsePreviewArgs(args, PREVIEW_SUB);
  if (!prompt) {
    // A machine caller must still get its line: the text notification below stays
    // for the interactive path, but a consumer that scans for the marker needs a
    // parseable outcome even when there is nothing to route.
    if (json && trace) {
      const summary: RouteDecisionSummary = {
        version: 1,
        kind: "route-decision",
        outcome: "usage",
        error: "usage",
        classification: { source: "unclassified" },
      };
      console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(buildTracePreview(summary, state.classifierEnabled))}`);
    } else if (json) emitPreviewReport(buildPreviewFailure(prompt, "usage"));
    log(ctx, json ? `usage: /bifrost preview ${trace ? "--trace " : ""}--json <prompt>` : `usage: /bifrost preview ${trace ? "--trace " : ""}<prompt>`, "warning");
    return;
  }

  clearBifrostWidgets(ctx);
  if (trace && state.classifierEnabled) {
    log(ctx, "Preview may send the prompt to the configured classifier", "warning");
  }
  setBifrostStatus(ctx, "previewing prompt...", "accent");
  uiBusy(ctx, "Classifying preview prompt...");
  let classification;
  try {
    classification = await state.getPipeline(ctx).classify(prompt);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  if (classification.kind === "unclassified") {
    if (trace) {
      const summary = buildRouteDecisionSummary(classification);
      const report = buildTracePreview(summary, state.classifierEnabled);
      if (json) console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
      else await uiResult(ctx, "Bifrost route trace", renderTracePreview(report));
      return;
    }
    if (json) emitPreviewReport(buildPreviewFailure(prompt, "unclassified"));
    log(ctx, "no tier matched", "warning");
    return;
  }

  const display = resolveTierDisplay(classification.tier, state, ctx, classification.kind === "classified" && classification.source === "inline" ? "explicit_tier" : "automatic");
  if (trace) {
    const options = buildTierResolutionOptions(classification.tier, state.config);
    const summary = buildRouteDecisionSummary(classification, {
      resolution: display.resolution,
      options,
    });
    const report = buildTracePreview(summary, state.classifierEnabled);
    if (json) console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
    else await uiResult(ctx, "Bifrost route trace", renderTracePreview(report));
    return;
  }

  const report = buildPreviewReport({
    prompt,
    classification,
    display,
  });

  if (json) {
    emitPreviewReport(report);
    return;
  }
  await uiResult(ctx, "Bifrost preview", renderPreviewReport(report));
}

// ── Command type ────────────────────────────────────────────

type CommandFn = (args: string, ctx: ExtensionContext) => void | Promise<void>;

export async function runBifrostCommand(
  args: string,
  ctx: ExtensionContext,
  handler: CommandFn,
): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setEditorText("");
  await handler(args, ctx);
}

interface CommandSpec {
  readonly value: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  // Orders the dashboard and never hides a command. An entry with no `menu`
  // still appears, after the common ones. That is what makes a new registry
  // command show up in /bifrost without a second edit.
  readonly menu?: "common";
  // Marks a member of an on/off-style pair, and carries everything the
  // dashboard needs to place it: which bit of state it mirrors, which way it
  // pushes that bit, and the note it shows while pushing it is a no-op. One
  // registry entry, so a new reflected command cannot half-register.
  readonly reflects?: {
    readonly state: "enabled" | "pinned";
    readonly sets: boolean;
    readonly note: string;
  };
}

interface CommandEntry {
  readonly value: string;
  readonly match: (sub: string) => boolean;
  readonly handler: CommandFn;
}

function exact(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub === word, handler };
}

// Bare prefix, no word boundary: benchmark and preview take free-text prompts,
// so "/bifrost previewXYZ" must keep dispatching with prompt "XYZ".
function prefix(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub.startsWith(word), handler };
}

// Space-bounded: init takes flags ("init -f", "init --write") but
// "/bifrost initialize" must not match, which bare prefix would allow.
function spaced(word: string, handler: CommandFn): CommandEntry {
  return { value: word, match: (sub) => sub === word || sub.startsWith(`${word} `), handler };
}

export const BIFROST_COMMAND_OPTIONS: readonly CommandSpec[] = [
  // Reflected pairs first. The dashboard puts a reflected pair ahead of every
  // other row, in the order these states are first mentioned here.
  { value: "on", description: "Enable routing", reflects: { state: "enabled", sets: true, note: "already on" } },
  { value: "off", description: "Disable routing", reflects: { state: "enabled", sets: false, note: "already off" } },
  { value: "pin", description: "Lock current model", reflects: { state: "pinned", sets: true, note: "already pinned" } },
  { value: "unpin", description: "Resume routing", reflects: { state: "pinned", sets: false, note: "already unpinned" } },
  // Common commands, in menu order. The two prompt commands lead because both
  // prefill the editor rather than run: keep them adjacent.
  { value: PREVIEW_SUB, description: "Preview routing for a prompt", argumentHint: `[--trace] [--json] <prompt>`, menu: "common" },
  { value: "benchmark", description: "Classify a benchmark prompt", argumentHint: "<prompt>", menu: "common" },
  { value: "providers", description: "List available providers", menu: "common" },
  { value: "probe", description: "Probe working models", menu: "common" },
  { value: "init", description: "Probe models and generate config (pass -f to force re-probe)", aliases: ["init -f"], menu: "common" },
  { value: "classifier status", description: "Show classifier state", menu: "common" },
  { value: "reload", description: "Reload config after editing", menu: "common" },
  { value: "validate", description: "Validate loaded config and model references", argumentHint: "[--json]", menu: "common" },
  { value: "inspect", description: "Inspect configured models and local health", argumentHint: "[--json]", menu: "common" },
  { value: "config reconcile", description: "Preview or apply exact generated model membership", argumentHint: "[flags]" },
  { value: "reliability migrate", description: "Prepare receipt-owned reliability v2", argumentHint: "[--fresh]" },
  // Everything else, in declaration order.
  { value: "cache stats", description: "Show classification cache" },
  // Reachable from the dashboard now that the menu is derived from the
  // registry, and still unconfirmed: this writes the cache file immediately.
  // docs/ui-enhancements.md lists "Destructive confirmation - Confirm cache
  // clear/config overwrite/long probe" as a Next item. Deliberately left as is
  // here; confirmation is a separate behavior change.
  { value: "cache clear", description: "Clear classification cache" },
  { value: "classifier", description: "Choose classifier backend" },
  { value: "classifier on", description: "Enable LLM classifier" },
  { value: "classifier off", description: "Disable LLM classifier" },
  { value: "classifier test", description: "Test selected classifier backend" },
  { value: "debug", description: "Show config and routing state" },
] as const;

export function getBifrostCommandCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  // Aliases are completion-only: dispatch reaches them through the parent's
  // matcher, never through this list. Flattening here also keeps the exact-match
  // early return below alias-aware.
  const entries = BIFROST_COMMAND_OPTIONS.flatMap((command) => [
    { value: command.value, description: command.description },
    ...(command.aliases ?? []).map((alias) => ({ value: alias, description: command.description })),
  ]);
  // Exact commands should submit on first Enter. Returning a completion for
  // an already-complete command makes Pi accept the suggestion first and
  // leave the command text stuck in the editor until a second Enter.
  if (entries.some((entry) => entry.value === normalized)) return null;
  const items = entries.filter((entry) => entry.value.startsWith(normalized)).map((entry) => ({
    value: entry.value,
    label: entry.value,
    description: entry.description,
  }));
  return items.length > 0 ? items : null;
}

function formatBifrostCommandChoice(command: CommandSpec): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `/bifrost ${command.value}${hint} — ${command.description}`;
}

function parseDiagnosticJsonFlag(args: string, command: "validate" | "inspect"): boolean | undefined {
  const rest = args.slice(command.length).trim();
  if (!rest) return false;
  if (rest === "--json") return true;
  return undefined;
}

async function handleReliabilityCommand(args: string, ctx: ExtensionContext, state: BifrostState): Promise<void> {
  const rest = args.trim().slice("reliability".length).trim();
  if (rest !== "migrate" && rest !== "migrate --fresh") {
    log(ctx, "usage: /bifrost reliability migrate [--fresh]", "warning");
    return;
  }
  const stateVersion = state.config.reliability?.stateVersion;
  const reliabilityConfigErrors = validateConfig(state.config).filter((issue) => issue.severity === "error" && issue.code?.startsWith("config.reliability_"));
  if (reliabilityConfigErrors.length > 0 || !state.reliabilityV2ConfigValid
    || (stateVersion === 2 && state.config.schemaVersion !== 2)) {
    log(ctx, "Repair the reliability settings and validate the config before preparing the v2 sidecar.", "error");
    return;
  }
  let store: ReliabilityV2Store;
  try { store = createReliabilityV2Store(process.cwd(), state.config.reliability); }
  catch { log(ctx, "Reliability migration could not prepare a safe sidecar location; no files were changed.", "error"); return; }
  try {
    store.readSnapshot();
    if (stateVersion === 2) state.reliabilityV2Store = store;
    log(ctx, "Reliability v2 sidecar already exists and was left unchanged.");
    return;
  } catch (error) {
    if (!(error instanceof ReliabilityV2StoreError) || error.code !== "uninitialized_state") {
      log(ctx, "An existing reliability v2 sidecar is invalid or unsafe; repair it explicitly before migration.", "error");
      return;
    }
  }
  const fresh = rest === "migrate --fresh";
  // The store treats this as a detached placeholder when sourcePath is provided and reads the
  // authoritative bounded source only after it owns the cooperative v1 source fence.
  const snapshot = Buffer.from(JSON.stringify(emptyReliabilityState()) + "\n", "utf8");
  try {
    const destination = reliabilityV2Path(process.cwd());
    const backupPath = join(dirname(destination), "bifrost-reliability-v1.json.backup");
    const result = await store.initializeFromV1Migration({
      sourceSnapshot: snapshot,
      sourcePath: state.reliabilityStore.path,
      backupPath,
      requireSourceAbsent: fresh,
    });
    state.reliabilityV2Store = store;
    log(ctx, result.status === "seeded"
      ? "Reliability v2 sidecar initialized. Auto routing can now use receipt-owned circuit trials; model selection was not changed."
      : "Reliability v2 sidecar already exists and was left unchanged.");
  } catch (error) {
    const code = error instanceof ReliabilityV2StoreError ? error.code : "migration_failed";
    log(ctx, code === "source_lock_contended"
      ? "Reliability migration stopped safely because its v1 source lock is busy. Stop other Pi sessions that may write the source and ensure this session has no active or queued generation. If the lock remains, inspect the exact default `.pi/bifrost-reliability.json.migration.lock` or custom `reliability.path` plus `.migration.lock`; remove only a proven stale lock, never based on age or PID alone. V1 state and backup were left untouched; no v2 state was committed."
      : code === "source_missing"
        ? "No v1 reliability file exists; pass --fresh only if you intend to initialize an empty v2 sidecar."
        : code === "source_exists"
          ? "--fresh is allowed only when no v1 reliability file exists; existing v1 state was left unchanged."
      : code === "source_changed"
        ? "Reliability migration stopped because the v1 source changed during migration. No v2 state was committed; review the source and retry."
        : `Reliability migration stopped safely (${code}); existing files were preserved.`, "error");
  }
}

const MAX_RELIABILITY_MIGRATION_SOURCE_BYTES = 16 * 1024 * 1024;

function readBoundedRegularSnapshot(path: string): Buffer | undefined {
  let pathStat;
  try { pathStat = lstatSync(path); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("unsafe source");
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("unsafe source");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino
      || before.size > MAX_RELIABILITY_MIGRATION_SOURCE_BYTES) throw new Error("unsafe source");
    const bytes = Buffer.alloc(MAX_RELIABILITY_MIGRATION_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_RELIABILITY_MIGRATION_SOURCE_BYTES) throw new Error("source too large");
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || offset !== before.size) {
      throw new Error("source changed");
    }
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const DIAGNOSTIC_FIELD_PATHS = new Set([
  "schemaVersion",
  "tierPolicies",
  "tierPolicies.*",
  "tierPolicies.*.fallbackTiers",
]);

interface EconomicInspectEvidence {
  readonly mode: "off" | "observe" | "policy" | "invalid";
  readonly sources: readonly {
    readonly source: string;
    readonly scope: string;
    readonly authority: string;
    readonly freshness: "missing" | "current" | "expired" | "future";
    readonly observedAgeMs?: number;
    readonly periods: readonly {
      readonly window: string;
      readonly period: string;
      readonly unit: string;
      readonly applicability: "current" | "reset" | "expired" | "future";
    }[];
  }[];
  readonly diagnostics: readonly { readonly code: string; readonly severity: string; readonly source?: string; readonly scope?: string }[];
}

interface ReliabilityV2InspectEvidence {
  readonly version: 2;
  readonly status: "initialized" | "unavailable";
  readonly revision?: number;
  readonly observationsEnabled: boolean;
  readonly scopes?: readonly { readonly model: string; readonly generation: number; readonly recentFailureCount: number; readonly openUntil?: number }[];
  readonly observations?: readonly { readonly model: string; readonly category: string; readonly categoryEvidence: string; readonly observedAt: number; readonly retryAt?: number; readonly source: string }[];
  readonly observationCount?: number;
  readonly reasonCode?: string;
}

function inspectReliabilityV2(state: BifrostState): ReliabilityV2InspectEvidence | undefined {
  if (state.config.reliability?.stateVersion !== 2) return undefined;
  const observationsEnabled = state.config.reliability.observations?.enabled === true;
  try {
    if (!state.reliabilityV2Store) throw new ReliabilityV2StoreError("uninitialized_state", "unavailable");
    const snapshot = state.reliabilityV2Store.readSnapshot();
    const projected = Object.entries(snapshot.scopes).flatMap(([scopeKey, scope]) => {
      const match = /^model:(\d+):(.+)$/.exec(scopeKey);
      const model = match && Number(match[1]) === match[2]!.length ? match[2] : undefined;
      return model ? [{ model, generation: scope.generation, recentFailureCount: scope.failures.length, ...(scope.openUntil === undefined ? {} : { openUntil: scope.openUntil }) }] : [];
    });
    const observations = Object.values(snapshot.settledOutcomes).flatMap((outcome) => outcome.observation ? [{
      model: outcome.observation.modelKey,
      category: outcome.observation.category,
      categoryEvidence: outcome.observation.categoryEvidence,
      observedAt: outcome.observation.observedAt,
      ...(outcome.observation.retryAt === undefined ? {} : { retryAt: outcome.observation.retryAt }),
      source: outcome.observation.source,
    }] : []);
    return {
      version: 2,
      status: "initialized",
      revision: snapshot.revision,
      observationsEnabled,
      scopes: projected.slice(0, 200),
      observations: observations.slice(0, 200),
      observationCount: observations.length,
    };
  } catch (error) {
    const code = error instanceof ReliabilityV2StoreError ? error.code : "state_unavailable";
    return { version: 2, status: "unavailable", observationsEnabled, reasonCode: code };
  }
}

function inspectEconomicEvidence(state: BifrostState, now = Date.now()): EconomicInspectEvidence {
  if (state.economicPolicyValid === false) return { mode: "invalid", sources: [], diagnostics: [] };
  if (!state.config.economics) return { mode: "off", sources: [], diagnostics: [] };
  const policy = state.economicPolicy;
  if (!policy) return { mode: "off", sources: [], diagnostics: [] };
  const signals = state.economicSnapshot?.signals ?? [];
  const sources = policy.sources.map((source) => {
    const signal = signals.find((item) => item.sourceId === source.id && item.scopeRef === source.scopeRef);
    const freshness = !signal
      ? "missing" as const
      : now < signal.observedAt
        ? "future" as const
        : signal.expiresAt <= now ? "expired" as const : "current" as const;
    const periods = signal ? signal.windows.map((window) => ({
      window: window.id,
      period: window.period.id,
      unit: window.unit,
      applicability: now < signal.observedAt
        ? "future" as const
        : signal.expiresAt <= now
          ? "expired" as const
          : window.resetsAt !== undefined && window.resetsAt <= now
            ? "reset" as const
            : "current" as const,
    })) : [];
    return {
      source: source.id,
      scope: source.scopeRef,
      authority: source.authority,
      freshness,
      ...(signal ? { observedAgeMs: Math.max(0, now - signal.observedAt) } : {}),
      periods,
    };
  });
  return {
    mode: policy.mode,
    sources,
    diagnostics: (state.economicDiagnostics ?? []).map((item) => ({
      code: item.code,
      severity: item.severity,
      ...(item.sourceId ? { source: item.sourceId } : {}),
      ...(item.scopeRef ? { scope: item.scopeRef } : {}),
    })),
  };
}

function renderDiagnostic(item: BifrostDiagnostic): string {
  const fieldPath = item.path && DIAGNOSTIC_FIELD_PATHS.has(item.path) ? `path=${item.path}` : "";
  const location = [fieldPath, item.tier ? `tier=${item.tier}` : "", item.entryIndex !== undefined ? `entry=${item.entryIndex}` : "", item.ruleIndex !== undefined ? `rule=${item.ruleIndex}` : "", item.model ? `model=${item.model}` : ""].filter(Boolean).join(" ");
  return `  ${item.severity} ${item.code}${location ? ` (${location})` : ""}: ${item.repair}`;
}

function formatDiagnosticTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function renderDiagnosticLines(report: ValidateDiagnosticsReport | (InspectDiagnosticsReport & { economics?: EconomicInspectEvidence; reliabilityV2?: ReliabilityV2InspectEvidence; affinity?: AffinityInspectEvidence })): string[] {
  const lines = [report.kind === "validation" ? "--- validation (loaded effective config) ---" : "--- inspection (local snapshot) ---"];
  if (report.kind === "validation") {
    lines.push("config source: loaded effective config (run /bifrost reload after editing files)");
  } else {
    lines.push(`observed: ${formatDiagnosticTimestamp(report.observedAt)}`);
    lines.push(`registry: ${report.registry.knownModelCount} known, ${report.registry.availableModelCount} available`);
    if (report.registry.bifrostLastRefreshAgeMs !== undefined) {
      lines.push(`Bifrost last registry refresh age: ${report.registry.bifrostLastRefreshAgeMs} ms`);
    }
    for (const tier of report.tiers) {
      lines.push(`${tier.tier}: ${tier.configuredEntryCount} configured entries`);
      for (const candidate of tier.candidates) {
        lines.push(`  ${candidate.model}: available=${candidate.available}, auth=${candidate.auth}, circuit=${candidate.circuit}${candidate.openUntil === undefined ? "" : ` until ${formatDiagnosticTimestamp(candidate.openUntil)}`}`);
      }
    }
    if (report.economics) {
      lines.push(`reserve policy: ${report.economics.mode}`);
      for (const source of report.economics.sources) {
        const age = source.observedAgeMs === undefined ? "" : ` age=${source.observedAgeMs}ms`;
        const periods = source.periods.map((period) => `${period.window}:${period.period}(${period.applicability})`).join(", ") || "none";
        lines.push(`  source=${source.source} scope=${source.scope} authority=${source.authority} freshness=${source.freshness}${age} periods=${periods}`);
      }
      for (const diagnostic of report.economics.diagnostics) {
        lines.push(`  ${diagnostic.severity} ${diagnostic.code}${diagnostic.source ? ` source=${diagnostic.source}` : ""}${diagnostic.scope ? ` scope=${diagnostic.scope}` : ""}`);
      }
    }
    if (report.reliabilityV2) {
      const reliability = report.reliabilityV2;
      lines.push(`reliability v2: ${reliability.status}${reliability.revision === undefined ? "" : ` revision=${reliability.revision}`} observations=${reliability.observationsEnabled ? "on" : "off"}`);
      if (reliability.reasonCode) lines.push(`  reason=${reliability.reasonCode}`);
      for (const scope of reliability.scopes ?? []) {
        lines.push(`  model=${scope.model} generation=${scope.generation} recentFailures=${scope.recentFailureCount}${scope.openUntil === undefined ? "" : ` openUntil=${formatDiagnosticTimestamp(scope.openUntil)}`}`);
      }
      for (const observation of reliability.observations ?? []) {
        lines.push(`  observation model=${observation.model} category=${observation.category} evidence=${observation.categoryEvidence} at=${formatDiagnosticTimestamp(observation.observedAt)}${observation.retryAt === undefined ? "" : ` retryAt=${formatDiagnosticTimestamp(observation.retryAt)}`} source=${observation.source}`);
      }
      if ((reliability.observationCount ?? 0) > 200) lines.push(`  ... ${reliability.observationCount! - 200} more observations`);
    }
    if (report.affinity) {
      lines.push(`affinity: ${report.affinity.mode} (${report.affinity.status})`);
      if (report.affinity.anchor) {
        lines.push(`  last successful model=${report.affinity.anchor.model} provider=${report.affinity.anchor.provider} at=${report.affinity.anchor.lastSuccessfulAt} age=${report.affinity.anchor.ageMs}ms`);
      }
    }
  }
  if (report.diagnostics.length === 0) lines.push("diagnostics: none");
  else lines.push("diagnostics:", ...report.diagnostics.map(renderDiagnostic));
  lines.push("----------------");
  return lines;
}

async function handleDiagnosticsCommand(
  command: "validate" | "inspect",
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const json = parseDiagnosticJsonFlag(args, command);
  if (json === undefined) {
    log(ctx, `usage: /bifrost ${command} [--json]`, "warning");
    return;
  }
  const v2Evidence = command === "inspect" ? inspectReliabilityV2(state) : undefined;
  let reliabilityState = state.reliabilityStore.getState();
  if (v2Evidence?.status === "initialized" && state.reliabilityV2Store && state.config.reliability) {
    try {
      reliabilityState = projectReliabilityV2ForRouting(state.reliabilityV2Store.readSnapshot(), reliabilityV2Config(state.config.reliability), Date.now());
    } catch { /* unavailable evidence is reported separately; do not fabricate a health snapshot */ }
  }
  const affinityEvidence = command === "inspect" ? inspectAffinity(state, ctx) : undefined;
  const report = command === "validate"
    ? validateDiagnostics({ config: state.config, registry: ctx.modelRegistry })
    : {
      ...inspectDiagnostics({
      config: state.config,
      registry: ctx.modelRegistry,
      reliabilityState,
      reliabilityConfig: state.config.reliability,
      lastRegistryRefreshAt: state.lastRegistryRefreshAt,
      }),
      economics: inspectEconomicEvidence(state),
      ...(affinityEvidence ? { affinity: affinityEvidence } : {}),
      ...(v2Evidence ? { reliabilityV2: v2Evidence } : {}),
    };
  if (json) {
    console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
    return;
  }
  await uiResult(ctx, `Bifrost ${command}`, renderDiagnosticLines(report));
}

// The registry is a string-valued array, so a renamed command compiles fine
// here and only resolves to undefined at runtime, inside the picker, when a
// user opens /bifrost. Name the offending value at the call site instead.
function requireCommand(value: string): CommandSpec {
  const spec = BIFROST_COMMAND_OPTIONS.find((command) => command.value === value);
  if (!spec) throw new Error(`Bifrost: dashboard references unknown command "${value}"`);
  return spec;
}

type ReflectedState = NonNullable<CommandSpec["reflects"]>["state"];

// The member of a pair whose effect matches the state as it stands would change
// nothing, so it is annotated rather than hidden: hiding it meant the menu
// silently reshuffled as state flipped. Everything read here comes off the
// command's own registry entry, so a reflected command cannot be placed without
// also saying which way it points and what it says while it is a no-op.
function reflectedIsInert(spec: CommandSpec, state: Pick<BifrostState, ReflectedState>): boolean {
  return spec.reflects ? spec.reflects.sets === state[spec.reflects.state] : false;
}

// Every registered command, ordered for the state as it stands: the member of
// each reflected pair that changes something first, then the `common`
// commands, then everything else. Ordering is all `menu` and `reflects` decide;
// nothing here decides membership.
function dashboardCommands(state: Pick<BifrostState, ReflectedState>): CommandSpec[] {
  const reflectedStates = BIFROST_COMMAND_OPTIONS
    .map((spec) => spec.reflects?.state)
    .filter((reflects): reflects is ReflectedState => Boolean(reflects));
  // Groups follow the order the registry first mentions them, so the pair order
  // is registry order too and needs no second list.
  const groupOf = (reflects: ReflectedState): number => reflectedStates.indexOf(reflects);
  const tierOf = (spec: CommandSpec): number => (spec.reflects ? 0 : spec.menu === "common" ? 1 : 2);

  const rows = BIFROST_COMMAND_OPTIONS.map((spec) => {
    const inert = reflectedIsInert(spec, state);
    return {
      spec,
      tier: tierOf(spec),
      group: spec.reflects ? groupOf(spec.reflects.state) : 0,
      inert,
      note: inert ? spec.reflects?.note : undefined,
    };
  });
  // Array sort is stable, so an equal key leaves the row in registry order.
  rows.sort((a, b) => a.tier - b.tier || a.group - b.group || Number(a.inert) - Number(b.inert));

  return rows.map(({ spec, note }) => {
    // Resolve rather than reuse the mapped spec: requireCommand keeps the
    // checked lookup on the one path that feeds the picker, so a future
    // change that builds rows from anywhere but a registry read fails with a
    // named error instead of a TypeError inside the formatter.
    const resolved = requireCommand(spec.value);
    // A copy, so the registry keeps the bare description for autocomplete.
    return note ? { ...resolved, description: `${resolved.description} (${note})` } : resolved;
  });
}

async function pickBifrostCommand(
  ctx: ExtensionContext,
  title = "Bifrost commands",
  options: readonly CommandSpec[] = BIFROST_COMMAND_OPTIONS,
): Promise<CommandSpec | undefined> {
  if (!ctx.hasUI) return undefined;
  const selected = await ctx.ui.select(title, options.map(formatBifrostCommandChoice));
  if (!selected) return undefined;
  return options.find((command) => formatBifrostCommandChoice(command) === selected);
}

export function nextClassifierConfig(
  current: Record<string, unknown>,
  choice: { backend: ClassifierBackend; promptModel?: string | null; piNativeModel?: string | null },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, backend: choice.backend };
  if (choice.backend === CLASSIFIER_BACKEND_IDS.prompt) {
    if (choice.promptModel === null) delete next.model;
    else if (choice.promptModel !== undefined) next.model = choice.promptModel;
    return next;
  }
  for (const field of PROMPT_ONLY_FIELDS) delete next[field];
  if (choice.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
    const existing = next.typesafe && typeof next.typesafe === "object" && !Array.isArray(next.typesafe)
      ? next.typesafe as Record<string, unknown> : {};
    next.typesafe = { ...existing, model: TYPE_SAFE_MODEL };
  } else {
    const existing = next.piNative && typeof next.piNative === "object" && !Array.isArray(next.piNative)
      ? next.piNative as Record<string, unknown> : {};
    const piNative = { ...existing };
    if (choice.piNativeModel === null) delete piNative.model;
    else if (choice.piNativeModel !== undefined) piNative.model = choice.piNativeModel;
    next.piNative = piNative;
  }
  next.criteria ??= DEFAULT_CLASSIFIER_CRITERIA;
  next.fallback ??= next.model ? "prompt" : "regex";
  return next;
}

async function handleClassifierChoose(ctx: ExtensionContext, state: BifrostState): Promise<void> {
  if (!ctx.hasUI) {
    log(ctx, "Choose classifier backend in Pi UI: prompt, typesafe, or pi-native", "warning");
    return;
  }
  const backendOptions = [
    "prompt — choose a Pi model",
    `${CLASSIFIER_BACKEND_IDS.typesafe} — use Jev (requires Pi auth.json or ${TYPE_SAFE_API_KEY_ENV})`,
  ];
  if (piClassificationSupported(ctx.modelRegistry)) {
    backendOptions.push(`${CLASSIFIER_BACKEND_IDS.piNative} — use Pi native classify (requires Pi TypeSafe auth)`);
  }
  const selected = await ctx.ui.select("Classifier backend", backendOptions);
  if (!selected) return;
  const backend = selected.startsWith(CLASSIFIER_BACKEND_IDS.typesafe) ? CLASSIFIER_BACKEND_IDS.typesafe
    : selected.startsWith(CLASSIFIER_BACKEND_IDS.piNative) ? CLASSIFIER_BACKEND_IDS.piNative
    : CLASSIFIER_BACKEND_IDS.prompt;
  let selectedPromptModel: string | undefined;
  const needsPromptModel = backend === CLASSIFIER_BACKEND_IDS.prompt
    && !promptClassifierModelAvailable(ctx, state.config.classifier?.model);
  if (needsPromptModel) {
    if (ctx.modelRegistry.getAvailable().length === 0) {
      log(ctx, "No Pi models available for prompt classifier; regex fallback remains active.", "warning");
    } else {
      selectedPromptModel = await requestPromptClassifierModel(ctx) ?? undefined;
      if (!selectedPromptModel) {
        log(ctx, "Prompt classifier model selection cancelled", "warning");
        return;
      }
    }
  }
  let selectedPiNativeModel: string | null | undefined;
  if (backend === CLASSIFIER_BACKEND_IDS.piNative) {
    let catalogModels: string[] = [];
    try {
      catalogModels = (await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe"))
        .map((model) => `${model.provider}/${model.id}`);
    } catch {
      log(ctx, "Pi classifier catalog unavailable; choose catalog default and check credentials before use.", "warning");
    }
    if (catalogModels.length === 0) {
      log(ctx, `No TypeSafe classifier available now; run /login or set ${TYPE_SAFE_API_KEY_ENV} before use.`, "warning");
    }
    const picked = await ctx.ui.select("Pi native classifier model", ["Catalog default", ...catalogModels]);
    if (!picked) return;
    selectedPiNativeModel = picked === "Catalog default" ? null : picked;
  }
  const path = join(process.cwd(), CONFIG_DIR_NAME, "bifrost.json");
  let current: Record<string, unknown> = {};
  try {
    current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  } catch {
    log(ctx, "Cannot update classifier: .pi/bifrost.json is invalid JSON", "error");
    return;
  }
  const classifier = current.classifier && typeof current.classifier === "object" && !Array.isArray(current.classifier)
    ? current.classifier as Record<string, unknown> : {};
  current.classifier = nextClassifierConfig(classifier, {
    backend,
    promptModel: backend === CLASSIFIER_BACKEND_IDS.prompt
      ? selectedPromptModel ?? (needsPromptModel ? null : undefined) : undefined,
    piNativeModel: selectedPiNativeModel,
  });
  mkdirSync(join(process.cwd(), CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
  if (!installReloadedConfig(state, loadedConfig, ctx)) return;
  state.classifierMetricsStore.reload({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(state.config, state.effectiveClassifierBackend(state.config).backend),
  });
  log(ctx, `classifier backend set to ${backend}; config reloaded`);
  if (backend === CLASSIFIER_BACKEND_IDS.typesafe && resolveTypeSafeApiKey().source === "missing") {
    log(ctx, `TypeSafe credential missing; use ~/.pi/agent/auth.json or ${TYPE_SAFE_API_KEY_ENV}`, "warning");
  }
}

// ── Route table ─────────────────────────────────────────────

export function createCommandRouter(
  state: BifrostState,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  const routes: CommandEntry[] = [
    exact("on", (_, ctx) => {
      state.onManualControl?.(ctx.sessionManager);
      state.enabled = true;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost enabled");
    }),
    exact("off", async (_, ctx) => {
      if (state.selectPhysicalFromVirtual && !(await state.selectPhysicalFromVirtual(ctx))) return;
      state.onManualControl?.(ctx.sessionManager);
      state.enabled = false;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost disabled");
    }),
    exact("pin", async (_, ctx) => {
      if (state.selectPhysicalFromVirtual && !(await state.selectPhysicalFromVirtual(ctx))) return;
      state.onManualControl?.(ctx.sessionManager);
      state.pinned = true;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost pinned");
    }),
    exact("unpin", (_, ctx) => {
      state.onManualControl?.(ctx.sessionManager);
      state.pinned = false;
      state.saveModeState();
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      log(ctx, "Bifrost unpinned");
    }),
    exact("reload", (_, ctx) => {
      const done = debugMeasure("command", "reload");
      const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
      if (!installReloadedConfig(state, loadedConfig, ctx)) {
        done({ accepted: false });
        return;
      }
      // Re-init debug — user may have updated debug config since startup.
      setupDebug(state.config.debug ?? { enabled: false }, process.cwd());
      const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
        enabled: state.config.enabled ?? true,
        pinned: false,
        classifierEnabled: state.config.classifier?.enabled ?? true,
      });
      state.enabled = runtimeState.enabled;
      state.classifierEnabled = runtimeState.classifierEnabled;
      state.cacheEntries = loadCache(cachePath(process.cwd(), state.config.cache?.path), (state.config.cache?.ttlHours ?? 720) * 60 * 60 * 1000);
      state.reliabilityStore.reload(state.config.reliability, process.cwd());
      state.classifierMetricsStore.reload({
        cwd: process.cwd(),
        enabled: classifierMetricsEnabled(state.config, state.effectiveClassifierBackend(state.config).backend),
      });
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      done();
      debug("command", "reloaded", {
        enabled: state.enabled,
        classifierEnabled: state.classifierEnabled,
        tiers: Object.keys(state.config.models ?? {}).join(","),
      });
      log(ctx, "Bifrost config reloaded");
    }),

    spaced("validate", (args, ctx) => handleDiagnosticsCommand("validate", args, ctx, state)),
    spaced("inspect", (args, ctx) => handleDiagnosticsCommand("inspect", args, ctx, state)),
    spaced("config", (args, ctx) => handleReconciliationCommand(args, ctx, state)),
    spaced("reliability", (args, ctx) => handleReliabilityCommand(args, ctx, state)),

    // Providers
    exact("providers", (_, ctx) => {
      uiBusy(ctx, "Loading providers...");
      const available = ctx.modelRegistry.getAvailable();
      const counts = new Map<string, number>();
      for (const m of available) {
        counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
      }
      uiDone(ctx);
      uiOutput(ctx, [
        "available providers:",
        ...Array.from(counts.entries()).map(
          ([provider, count]) => `  ${provider}: ${count} model(s)`,
        ),
      ]);
    }),

    // Probe — test every model with a tiny prompt
    exact("probe", async (_, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      if (available.length === 0) {
        log(ctx, "No models available in registry.", "warning");
        return;
      }
      clearBifrostWidgets(ctx);
      uiBusy(ctx, `Probing ${available.length} models...`);
      log(ctx, `Probing ${available.length} model(s) with "${PROBE_PROMPT_TEXT}"...`);

      const { results, path } = await runProbe(ctx, probeOptionsFromConfig(state.config.probe));
      uiDone(ctx);
      state.reliabilityStore.applyOutcomes(
        results.map((r) =>
          r.status === "ok"
            ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
            : { model: `${r.provider}/${r.model}`, ok: false as const, source: "probe", reason: r.error ?? r.status }
        ),
        Date.now()
      );

      const ok = results.filter((r) => r.status === "ok");
      const errs = results.filter((r) => r.status === "error");
      const timeouts = results.filter((r) => r.status === "timeout");
      const skipped = results.filter((r) => r.status === "skipped");

      const lines = [
        `--- probe results (${results.length} models) ---`,
        `  ok:      ${ok.length}`,
        `  error:   ${errs.length}`,
        `  timeout: ${timeouts.length}`,
        `  skipped: ${skipped.length}`,
        "",
      ];

      if (errs.length > 0) {
        lines.push("errors:");
        for (const e of errs.slice(0, 10)) {
          lines.push(`  ${e.provider}/${e.model} — ${e.error}`);
        }
        if (errs.length > 10) lines.push(`  ... and ${errs.length - 10} more`);
      }

      if (timeouts.length > 0) {
        lines.push("timeouts:");
        for (const t of timeouts) {
          lines.push(`  ${t.provider}/${t.model}`);
        }
      }

      lines.push("", `full results → ${path}`);
      uiOutput(ctx, lines);

      if (ok.length < results.length) {
        log(
          ctx,
          `${ok.length}/${results.length} models responded. Check ${path} for details.`,
          "warning",
        );
      } else if (ok.length > 0) {
        log(ctx, `All ${ok.length} models responded successfully.`);
      }

      // Clear the probe widget so results don't persist in the TUI.
      if (ctx.hasUI) {
        ctx.ui.setWidget("bifrost-probe", []);
        ctx.ui.setWidget("bifrost-output", []);
      }
    }),

    // Init
    spaced("init", (args, ctx) => handleInit(args, ctx, state)),

    // Benchmark
    prefix("benchmark", (args, ctx) => handleBenchmark(args, ctx, state)),

    // Cache
    exact("cache stats", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      const entries = loadCache(path);
      log(
        ctx,
        `cache: ${entries.length} entries (cap ${state.config.cache?.maxEntries ?? DEFAULT_MAX_ENTRIES}, retention ${state.config.cache?.ttlHours ?? 720}h, threshold ${state.config.cache?.threshold ?? DEFAULT_THRESHOLD})`,
      );
    }),
    exact("cache clear", (_, ctx) => {
      const path = cachePath(process.cwd(), state.config.cache?.path);
      saveCache(path, []);
      state.cacheEntries = [];
      state.invalidatePipeline();
      log(ctx, "cache cleared");
    }),

    // Classifier
    exact("classifier test", (_, ctx) => handleClassifierTest(ctx, state)),
    exact("classifier", (_, ctx) => handleClassifierChoose(ctx, state)),
    exact("classifier on", (_, ctx) => {
      state.classifierEnabled = true;
      state.saveModeState();
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: true });
      log(ctx, "LLM classifier enabled");
    }),
    exact("classifier off", (_, ctx) => {
      state.classifierEnabled = false;
      state.saveModeState();
      state.invalidatePipeline();
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: false });
      log(ctx, "LLM classifier disabled; regex fallback active");
    }),
    exact("classifier status", (_, ctx) => {
      const rawModel = state.config.classifier?.model;
      const modelId = Array.isArray(rawModel)
        ? rawModel.join(", ")
        : (rawModel ?? "none");
      const classifier = state.config.classifier;
      const effective = state.effectiveClassifierBackend(state.config);
      const backend = effective.backend;
      const label = effective.auto ? `auto: ${backend} (${effective.reason})` : backend;
      const credential = backend === CLASSIFIER_BACKEND_IDS.typesafe ? resolveTypeSafeApiKey().source : undefined;
      const fallback = classifier?.fallback ?? (backend === CLASSIFIER_BACKEND_IDS.typesafe ? "prompt" : modelId === "none" ? "regex" : "prompt");
      const detail = backend === CLASSIFIER_BACKEND_IDS.typesafe
        ? `backend=${label} model=${classifier?.typesafe?.model ?? TYPE_SAFE_MODEL} endpoint=${TYPE_SAFE_ENDPOINT} minConfidence=${classifier?.minConfidence ?? 0.8} credential=${credential} fallback=${fallback} fallbackModel=${fallback === "regex" ? "none" : modelId}`
        : backend === CLASSIFIER_BACKEND_IDS.piNative
          ? `backend=${label} model=${classifier?.piNative?.model ?? "catalog default"} minConfidence=${classifier?.minConfidence ?? 0.8} fallback=${fallback} fallbackModel=${fallback === "regex" ? "none" : modelId}`
          : `backend=${label} model=${modelId} endpoint=${classifier?.endpoint ?? "registry"} method=${classifier?.method ?? "auto"}`;
      const metrics = state.classifierMetricsStore.snapshot();
      const lines = [
        `classifier: enabled=${state.classifierEnabled}`,
        detail,
        ...(backend !== CLASSIFIER_BACKEND_IDS.prompt ? [`observations=${metrics.total}`, `outcomes=${JSON.stringify(metrics.outcomes)}`] : []),
      ];
      uiOutput(ctx, lines);
    }),

    // Debug — show loaded config state
    exact("debug", (_, ctx) => {
      const rules = state.config.rules ?? [];
      const tiers = Object.keys(state.config.models ?? {});
      const lines = [
        "--- config ---",
        `cwd: ${process.cwd()}`,
        `enabled: ${state.enabled}`,
        `pinned: ${state.pinned}`,
        `classifierEnabled: ${state.classifierEnabled}`,
        `default: ${state.config.default}`,
        `strategy: ${state.config.strategy}`,
        `tiers: ${tiers.join(", ")}`,
        `debug: ${JSON.stringify(state.config.debug)}`,
        `cache: ${state.cacheEntries.length} entries (retention ${state.config.cache?.ttlHours ?? 720}h)`,
        `reliability: ${JSON.stringify(state.config.reliability ?? {})}`,
        `openCircuits: ${openCircuitCount(state)}`,
        `classifierMetrics: ${JSON.stringify(state.classifierMetricsStore.snapshot())}`,
        "",
        `rules (${rules.length}):`,
        ...rules.map((r, i) => `  ${i}: "${r.pattern}" → "${r.model}"`),
        "---",
      ];
      uiOutput(ctx, lines);
      log(ctx, "debug info printed above");
    }),
    prefix(PREVIEW_SUB, (args, ctx) => handlePreview(args, ctx, state)),
  ];

  return async (args: string, ctx: ExtensionContext) => {
    const trimmed = args.trim();
    const sub = trimmed.toLowerCase();

    if (!trimmed) {
      debug("command", "dashboard");
      if (!ctx.hasUI) {
        log(
          ctx,
          `Bifrost: enabled=${state.enabled} pinned=${state.pinned} current=${modelKey(ctx.model)}`,
        );
        return;
      }

      const mode = !state.enabled ? "off" : state.pinned ? "pinned" : "on";
      const selected = await pickBifrostCommand(
        ctx,
        `Bifrost · ${mode} · model ${modelKey(ctx.model)}${openCircuitCount(state) > 0 ? ` · circuits ${openCircuitCount(state)} open` : ""}`,
        dashboardCommands(state),
      );
      if (!selected) return;

      if (selected.argumentHint) {
        ctx.ui.setEditorText(`/bifrost ${selected.value} `);
        return;
      }

      const route = routes.find((entry) => entry.value === selected.value);
      if (!route) return;
      await route.handler(route.value, ctx);
      return;
    }

    for (const route of routes) {
      if (route.match(sub)) {
        debug("command", "dispatch", { command: sub });
        await route.handler(trimmed, ctx);
        return;
      }
    }

    debug("command", "picker", { command: sub });
    if (!ctx.hasUI) {
      log(ctx, `Unknown /bifrost subcommand: ${trimmed}`, "warning");
      return;
    }

    const selected = await pickBifrostCommand(ctx);
    if (!selected) return;

    if (selected.argumentHint) {
      ctx.ui.setEditorText(`/bifrost ${selected.value} `);
      log(ctx, `Prefilled /bifrost ${selected.value}`);
      return;
    }

    const route = routes.find((entry) => entry.value === selected.value);
    if (!route) return;

    debug("command", "dispatch", { command: route.value });
    await route.handler(route.value, ctx);
  };
}
