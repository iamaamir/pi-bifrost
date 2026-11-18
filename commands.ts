import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  ModelSelectorComponent,
  getAgentDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  loadRuntimeState,
  runtimeStatePath,
  type ClassifierEnablement,
  type RuntimeStateIssue,
} from "./runtime-state.ts";
import type { BifrostConfig, ClassifierConfig } from "./config.ts";
import {
  BUNDLED_PUBLIC_INIT_DEFAULTS,
  DEFAULT_CLASSIFIER_CRITERIA,
  DEFAULT_RULES,
  MAX_CONFIG_SOURCE_BYTES,
  PROMPT_ONLY_FIELDS,
  classifierConfigErrors,
  classifierTotalTimeoutIssue,
  schemaVersionAtLeast,
  validateConfig,
  validateEconomicConfig,
  validateTierPolicyConfig,
} from "./config.ts";
import {
  loadConfigForReload,
  loadConfigWithSourceOverride,
  readBoundedConfigText,
  type ConfigLoadDiagnostic,
} from "./config-load.ts";
import {
  applyConfigMigration,
  ConfigMigrationError,
  parseConfigMigrationArgs,
  planConfigMigration,
  readConfigMigrationSource,
} from "./config-migration.ts";
import type { CacheEntry } from "./cache.ts";
import {
  cachePath,
  loadCache,
  saveCache,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_THRESHOLD,
} from "./cache.ts";
import {
  buildRouteDecisionSummary,
  type ClassificationPipeline,
  type ClassificationResult,
  type ClassificationSource,
  type RouteDecisionSummary,
} from "./classification-pipeline.ts";
import { setupDebug, debug, debugMeasure } from "./debug.ts";
import {
  runProbe,
  probeOptionsFromConfig,
  PROBE_PROMPT_TEXT,
  readRecentCompleteProbeReport,
  failureDetails,
} from "./probe.ts";
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
import { reasonLabel } from "./virtual-routing.ts";
import type { ReliabilityStore } from "./reliability-store.ts";
import type { ReliabilityV2Store } from "./reliability-v2-store.ts";
import { ReliabilityV2StoreError } from "./reliability-v2-store.ts";
import type { ProviderCooldownStore } from "./provider-cooldowns.ts";
import { projectProviderCooldownsForRouting, providerScopeModelKey } from "./provider-cooldowns.ts";
import {
  emptyReliabilityState,
  getCircuitState,
  hasActiveAllowanceCooldown,
  resolveReliabilityConfig,
} from "./reliability.ts";
import {
  createProviderCooldownStore,
  createReliabilityV2Store,
  reliabilityV2Config,
  reliabilityV2Path,
} from "./runtime-reliability-v2.ts";
import { projectReliabilityV2ForRouting } from "./reliability-v2-routing.ts";
import {
  classifierMetricsEnabled,
  type ClassifierMetricsState,
  type ClassifierMetricsStore,
} from "./classifier-metrics.ts";
import type { EffectiveBackend } from "./classifier-detection.ts";
import {
  CLASSIFIER_BACKEND_IDS,
  TYPE_SAFE_API_KEY_ENV,
  TYPE_SAFE_ENDPOINT,
  TYPE_SAFE_MODEL,
  type ClassifierBackend,
} from "./classifier-backends.ts";
import { piClassificationSupported } from "./classifier-pi-native.ts";
import { resolveTypeSafeApiKey, type TypeSafeCredentialSource } from "./typesafe-classifier.ts";
import {
  inspectDiagnostics,
  validateDiagnostics,
  type BifrostDiagnostic,
  type InspectDiagnosticsReport,
  type ValidateDiagnosticsReport,
} from "./diagnostics.ts";
import type { EconomicDiagnostic, EconomicSnapshot, ReservePolicy } from "./economic-signals.ts";
import { reconcileEconomicSnapshot } from "./economic-config.ts";
import { resolvePiAffinityMode, type AffinityAnchor } from "./affinity.ts";
import {
  buildInitOwnershipReceipt,
  buildInitMembershipPlan,
  parseReconciliationCommandArgs,
  runReconciliationCommand,
  type ReconciliationCommandReport,
  type ReconciliationCommandRequest,
  type ReconciliationConfigSource,
  type ReconciliationRegistrySnapshot,
  type ReconciliationSourceSnapshot,
} from "./reconciliation-command.ts";
import {
  parseOwnershipSnapshot,
  tierOwnership,
  type ReconciliationOwnershipSnapshot,
} from "./reconciliation.ts";
import {
  applyReconciliationTransaction,
  assertOwnershipPayload,
  createReconciliationOwnershipReceipt,
  recoverReconciliationTransaction,
  ReconciliationStoreError,
} from "./reconciliation-store.ts";
import { projectProviderRefreshEvidence, waitForRegistryRefresh } from "./registry-refresh.ts";
import { REGISTRY_REFRESH_TTL_MS } from "./ux-status.ts";
import { isBifrostAuto, isVirtualModel } from "./virtual-model.ts";
import { hasExplicitExtensionRoutingFile, hasUserBootstrapFiles } from "./auto-setup.ts";
import { getCostReportData } from "./cost-report.ts";
import { formatCostText, showCostView } from "./ui/cost-view.ts";
import { Text } from "@earendil-works/pi-tui";
import { log as logImportant, type NoticeLevel } from "./ui/notice.ts";
import { setProbeProgress } from "./ui/probe-progress.ts";

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
  legacyClassifierEnabled?: boolean;
  classifierRuntimeStateIssue?: RuntimeStateIssue;
  getClassifierEnablementForSession: (
    session: ExtensionContext["sessionManager"],
    config?: BifrostConfig,
  ) => ClassifierEnablement;
  setClassifierSessionOverride: (
    session: ExtensionContext["sessionManager"],
    enabled?: boolean,
  ) => void;
  classifyForSession: (
    ctx: ExtensionContext,
    text: string,
    signal?: AbortSignal,
    options?: { readonly offline?: boolean },
  ) => Promise<ClassificationResult>;
  pinned: boolean;
  cacheEntries: CacheEntry[];
  reliabilityStore: ReliabilityStore;
  reliabilityV2Store?: ReliabilityV2Store;
  providerCooldownStore?: ProviderCooldownStore;
  configGeneration?: number;
  /** True when this session generated model memberships from Pi's startup catalog without writing config. */
  bootstrapModelsInMemory?: boolean;
  reliabilityV2ConfigValid?: boolean;
  reliabilityV2StateError?: string;
  onConfigInstalled?: (
    config: BifrostConfig,
    previousConfig: BifrostConfig,
    validatedReload?: boolean,
    ctx?: ExtensionContext,
  ) => void;
  onInitStarted?: (session: ExtensionContext["sessionManager"]) => BifrostConfig | undefined;
  onManualControl?: (
    session: ExtensionContext["sessionManager"],
    action?: "on" | "off" | "pin" | "unpin",
  ) => void;
  /** Read-only projection of the current branch-local successful Auto anchor. */
  getAffinityAnchor?: (ctx: ExtensionContext) => AffinityAnchor | undefined;
  /**
   * Providers Auto would currently skip for sign-in reasons, read from the
   * session cache. Absent until a turn has resolved it, so a view can say the
   * signal is unresolved instead of implying every provider is ready.
   */
  getSignInExclusions?: (ctx: ExtensionContext) => ReadonlySet<string> | undefined;
  classifierMetricsStore: ClassifierMetricsStore;
  extensionDir: string;
  /** Uses the extension instance's sticky detector without locking on context-free facts. */
  effectiveClassifierBackend: (config: BifrostConfig, ctx?: ExtensionContext) => EffectiveBackend;
  getPipeline: (ctx: ExtensionContext) => ClassificationPipeline;
  invalidatePipeline: (session?: ExtensionContext["sessionManager"]) => void;
  /** Leave Bifrost's virtual selection for its last dispatched physical model. */
  selectPhysicalFromVirtual?: (ctx: ExtensionContext) => Promise<boolean>;
  /** Persist Bifrost's enabled mode while preserving legacy and unknown state fields. */
  saveModeState: () => boolean | void;
  lastRegistryRefreshAt?: number;
  forceRegistryRefresh?: boolean;
  /** Per-provider, content-free registry refresh evidence for offline reconciliation. */
  registryInventoryEvidence?: Readonly<
    Record<string, { status: "complete" | "partial" | "stale"; refreshedAt: number }>
  >;
  /** Recorded when detection fills an absent classifier.backend; status and test report read it (fix 12). */
  classifierDetection?: { backend: ClassifierBackend; reason: string };
}

type ClassifierRuntimeState = Pick<BifrostState, "config" | "getClassifierEnablementForSession">;
type BifrostModeStatusState = Pick<
  BifrostState,
  "enabled" | "pinned" | "config" | "economicPolicyValid" | "getClassifierEnablementForSession"
>;

function classifierEnablementFor(
  state: ClassifierRuntimeState,
  ctx: ExtensionContext,
  config: BifrostConfig = state.config,
): ClassifierEnablement {
  return state.getClassifierEnablementForSession(ctx.sessionManager, config);
}

function installConfigIfTierPoliciesValid(
  state: BifrostState,
  config: BifrostConfig,
  ctx: ExtensionContext,
  validatedReload = false,
): boolean {
  const errors = validateTierPolicyConfig(config).filter((issue) => issue.severity === "error");
  errors.push(
    ...validateConfig(config).filter(
      (issue) =>
        issue.severity === "error" &&
        (issue.code?.startsWith("config.reliability_") ||
          issue.code?.startsWith("config.affinity_")),
    ),
  );
  const totalTimeoutIssue = classifierTotalTimeoutIssue(config);
  if (totalTimeoutIssue) errors.push(totalTimeoutIssue);
  if (errors.length > 0) {
    debug("config", "reload_rejected", {
      category: "validation_failed",
      issueCount: errors.length,
    });
    logImportant(
      ctx,
      "Config reload rejected",
      errors.map((issue) => issue.message).join(" "),
      "error",
    );
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
  state.economicPolicyValid = validateEconomicConfig(config).every(
    (issue) => issue.severity !== "error",
  );
  state.economicDiagnostics = reconciled.diagnostics;
  state.economicQuarantinedSourceRevisions = reconciled.quarantinedSourceRevisions;
  state.onConfigInstalled?.(config, previousConfig, validatedReload, ctx);
  state.invalidatePipeline();
  return true;
}

function installReloadedConfig(
  state: BifrostState,
  loaded: ReturnType<typeof loadConfigForReload>,
  ctx: ExtensionContext,
): boolean {
  if (loaded.diagnostics.length > 0) {
    debug("config", "reload_rejected", {
      category: "source_invalid",
      issueCount: loaded.diagnostics.length,
    });
    logImportant(
      ctx,
      "Config reload rejected",
      loaded.diagnostics.map(({ message }) => message).join(" "),
      "error",
    );
    return false;
  }
  const installed = installConfigIfTierPoliciesValid(state, loaded.config, ctx, true);
  if (installed && loaded.warnings.length > 0) {
    logImportant(
      ctx,
      "Configuration loaded with warnings",
      loaded.warnings.map(({ message }) => message).join(" "),
      "warning",
    );
  }
  return installed;
}

export function log(ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") {
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

/**
 * Reports one `/bifrost init` outcome: what happened, what changed, and at
 * most one next step. It appends that line as the `init` notice card, which is
 * the terminal state of the run; headless prints the same shape on stderr.
 */
function reportInitOutcome(
  ctx: ExtensionContext,
  outcome: string,
  changed: string,
  next: string | undefined,
  level: NoticeLevel,
): void {
  logImportant(ctx, "init", `${outcome}. ${next ? `${changed} ${next}` : changed}`, level);
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
    const onSelect = (model: { provider: string; id: string }) =>
      done(`${model.provider}/${model.id}`);
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

export function syncBifrostModeStatus(ctx: ExtensionContext, state: BifrostModeStatusState) {
  setBifrostModeStatus(ctx, {
    enabled: state.enabled,
    pinned: state.pinned,
    classifierEnabled: classifierEnablementFor(state, ctx).enabled,
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
      if (skippedCandidate.reason === "provider_not_allowed")
        return `xx ${key} (${reasonLabel("provider_not_allowed")})`;
      // Sign-in and every other non-circuit skip carry no openUntil; printing
      // "open circuit until unknown" for them was a lie in the old code.
      if (skippedCandidate.reason === "sign_in_unavailable")
        return `xx ${key} (${reasonLabel("sign_in_unavailable")})`;
      const until = skippedCandidate.openUntil
        ? new Date(skippedCandidate.openUntil).toISOString()
        : "unknown";
      return `xx ${key} (open circuit until ${until})`;
    }
    if (reserve?.mode === "policy" && reserve.disposition === "rejected")
      return `xx ${key} (reserve policy)`;
    const marker = key === selectedKey ? "=>" : "  ";
    const reserveNote =
      reserve?.mode === "observe" && reserve.wouldReject ? "; reserve would reject" : "";
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
  /** Set when the configured sign-in check has no session result to apply. */
  signInNote?: string;
  defaultTier?: string;
  explicitBoundary?: true;
  attemptedTiers?: Array<{ tier: string; strategy: string; candidates: string[] }>;
};

type ResolvedTierDisplay = BifrostTierDisplay & { resolution: RoutedModelResolution };
type AffinityInspectEvidence = {
  mode: "off" | "observe" | "retain-within-tier";
  source: "config" | "auto_default" | "physical_default";
  status: "anchored" | "locality_unknown" | "disabled";
  anchor?: { model: string; provider: string; lastSuccessfulAt: string; ageMs: number };
};

function inspectAffinity(
  state: BifrostState,
  ctx: ExtensionContext,
): AffinityInspectEvidence | undefined {
  const surface = isBifrostAuto(ctx.model) && state.enabled && !state.pinned ? "auto" : "physical";
  const { mode, source } = resolvePiAffinityMode(state.config.affinity?.mode, surface);
  if (mode === "off") return { mode, source, status: "disabled" };
  const anchor = state.getAffinityAnchor?.(ctx);
  if (!anchor) return { mode, source, status: "locality_unknown" };
  const now = Date.now();
  return {
    mode,
    source,
    status: "anchored",
    anchor: {
      model: anchor.modelKey,
      provider: anchor.provider,
      lastSuccessfulAt: formatDiagnosticTimestamp(anchor.lastSuccessfulDispatchAt),
      ageMs: Math.max(0, now - anchor.lastSuccessfulDispatchAt),
    },
  };
}

export function resolveTierDisplay(
  tier: string,
  state: BifrostState,
  ctx: ExtensionContext,
  intrinsicOrigin: string = "automatic",
): ResolvedTierDisplay {
  const surface = isBifrostAuto(ctx.model) && state.enabled && !state.pinned ? "auto" : "physical";
  const affinityMode = resolvePiAffinityMode(state.config.affinity?.mode, surface);
  const anchor = affinityMode.mode !== "off" ? state.getAffinityAnchor?.(ctx) : undefined;
  const affinity: AffinityRoutingContext = {
    intrinsicOrigin,
    effectiveMode: affinityMode.mode,
    modeSource: affinityMode.source,
    ...(anchor ? { anchor } : {}),
  };
  let reliabilityState = state.reliabilityStore.getState();
  if (state.enabled && state.config.reliability?.enabled !== false && state.providerCooldownStore) {
    const registryModels =
      typeof ctx.modelRegistry.getAll === "function"
        ? ctx.modelRegistry.getAll()
        : ctx.modelRegistry.getAvailable();
    reliabilityState = projectProviderCooldownsForRouting(
      reliabilityState,
      state.providerCooldownStore,
      registryModels,
      state.config.reliability?.cooldownOnAllowanceExhausted !== false &&
        state.config.reliability?.allowanceCooldownScope !== "model",
    );
  }
  // Preview reuses the session's cached exclusions instead of resolving auth
  // again: the command stays offline, and the model it names is the model the
  // next Auto turn would actually select.
  const signInMode = state.enabled && state.config.signInEligibility === "exclude";
  const signInExcluded = signInMode ? state.getSignInExclusions?.(ctx) : undefined;
  const excludedBySignIn =
    signInExcluded && signInExcluded.size > 0
      ? (model: { readonly provider: string }) => signInExcluded.has(model.provider)
      : undefined;
  const signInNote =
    signInMode && signInExcluded === undefined
      ? "sign-in eligibility is enabled but has not been resolved in this session; this view may name a provider the next Auto turn skips"
      : undefined;
  const { options, resolution: resolved } = resolveConfiguredTier(
    ctx,
    tier,
    state.config,
    reliabilityState,
    state.config.reliability,
    undefined,
    state.config.economics &&
      state.economicPolicyValid &&
      state.economicPolicy &&
      state.economicSnapshot
      ? { policy: state.economicPolicy, snapshot: state.economicSnapshot }
      : undefined,
    undefined,
    affinity,
    excludedBySignIn,
  );
  const explicitBoundary = resolved.explicitBoundary === true;
  const defaultTier = explicitBoundary ? undefined : options.defaultTier;
  const strategy = explicitBoundary ? resolved.strategy : options.requestedStrategy;

  const selectedKey = resolved.selected ? modelKey(resolved.selected) : undefined;
  const requestedCandidateLines = formatCandidateLines(
    resolved.primary,
    resolved.selectedTier === tier ? selectedKey : undefined,
  );
  const fallbackResolution = explicitBoundary
    ? resolved.attemptedTiers?.[1]?.resolution
    : resolved.fallback;
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
    ...(signInNote ? { signInNote } : {}),
    defaultTier,
    ...(explicitBoundary
      ? {
          explicitBoundary: true as const,
          attemptedTiers: (resolved.attemptedTiers ?? []).map((attempt) => ({
            tier: attempt.tier,
            strategy: attempt.strategy,
            candidates: formatCandidateLines(
              attempt.resolution,
              resolved.selectedTier === attempt.tier ? selectedKey : undefined,
            ),
          })),
        }
      : {}),
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
  classifierBackend?: ClassifierBackend,
): Record<string, unknown> {
  const tierKeys = Object.keys(models);
  const firstPopulatedTier = Object.entries(models).find(
    ([, candidates]) => candidates.length > 0,
  )?.[0];
  // Prefer general regardless of discovery order; otherwise use first populated tier.
  const defaultTier =
    (models.general?.length ?? 0) > 0
      ? "general"
      : (firstPopulatedTier ??
        (tierKeys.includes("general") ? "general" : (tierKeys[0] ?? "general")));
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
      ...(classifierBackend ? { backend: classifierBackend } : {}),
      ...(classifierBackend !== CLASSIFIER_BACKEND_IDS.typesafe && classifierModel
        ? { model: classifierModel, method: "auto" as const }
        : {}),
      ...(classifierBackend === CLASSIFIER_BACKEND_IDS.typesafe
        ? { typesafe: { model: TYPE_SAFE_MODEL }, criteria: DEFAULT_CLASSIFIER_CRITERIA }
        : {}),
    },
    models,
    rules: DEFAULT_RULES,
  };
}

// ── Command handlers ────────────────────────────────────────

/** Human-readable names for probe failure reasons (see failureDetails in probe.ts). */
const REASON_LABELS: Record<string, string> = {
  provider_error: "provider errors",
  http_error: "HTTP errors",
  rate_limited: "rate limited",
  allowance_exhausted: "allowance exhausted",
  authentication_or_access: "authentication failed",
  unsupported_parameter: "unsupported parameters",
  unsupported_api: "unsupported API",
  empty_response: "empty responses",
  not_eligible: "not eligible",
  timeout: "timed out",
  unknown: "unknown errors",
};

const isForced = (args: string): boolean => args?.split(/\s+/).includes("-f");
const MAX_RECONCILIATION_OWNERSHIP_BYTES = 5_000_000;

/** An empty v2 payload records that no tier is proven Bifrost-managed. */
function emptyOwnershipBytes(scope: ReconciliationConfigSource): Buffer {
  return Buffer.from(JSON.stringify({ version: 2, scope, tiers: {} }, null, 2) + "\n", "utf8");
}

function reconciliationPaths(source: ReconciliationConfigSource): {
  configPath: string;
  ownershipPath: string;
  journalPath: string;
} {
  const cwd = process.cwd();
  if (source === "workspace") {
    const metadataDirectory = join(cwd, CONFIG_DIR_NAME);
    return {
      configPath: join(cwd, "bifrost.json"),
      ownershipPath: join(metadataDirectory, "bifrost-reconcile-workspace-ownership.json"),
      journalPath: join(metadataDirectory, "bifrost-reconcile-workspace.journal"),
    };
  }
  const directory = source === "project" ? join(cwd, CONFIG_DIR_NAME) : getAgentDir();
  return {
    configPath: join(directory, "bifrost.json"),
    ownershipPath: join(directory, "bifrost-reconcile-ownership.json"),
    journalPath: join(directory, "bifrost-reconcile.journal"),
  };
}

function readReconciliationSource(
  source: ReconciliationConfigSource,
): ReconciliationSourceSnapshot {
  const paths = reconciliationPaths(source);
  const configBytes = readBoundedRegularSnapshot(paths.configPath) ?? null;
  const ownershipBytes = readBoundedRegularSnapshot(paths.ownershipPath) ?? null;
  if (
    (configBytes && configBytes.byteLength > MAX_CONFIG_SOURCE_BYTES) ||
    (ownershipBytes && ownershipBytes.byteLength > MAX_RECONCILIATION_OWNERSHIP_BYTES)
  ) {
    throw new Error("source exceeds reconciliation bounds");
  }
  return { ...paths, source, configBytes, ownershipBytes };
}

function readInheritedConfigSnapshot(path: string): string | null {
  if (!existsSync(path)) return null;
  const { text } = readBoundedConfigText(path);
  if (text === undefined) throw new Error("unsafe inherited config");
  return text;
}

/** An unreadable receipt provides no ownership coverage; every pool stays protected as handwritten. */
function readInheritedReceiptSnapshot(path: string): string | null {
  try {
    return readInheritedConfigSnapshot(path);
  } catch {
    return null;
  }
}

interface InheritedTierPool {
  readonly pool: readonly string[];
  /** True only when this layer's ownership receipt proves the whole pool is generated. */
  readonly generated: boolean;
}

interface InheritedPoolSnapshot {
  readonly path: string;
  readonly text: string | null;
}

interface InheritedPools {
  /** Per-layer config snapshots, kept for the confirmation-time change re-check. */
  readonly snapshots: readonly InheritedPoolSnapshot[];
  readonly tierNames: ReadonlySet<string>;
  /** tier -> pool and receipt coverage; a later layer replaces an earlier one. */
  readonly effective: ReadonlyMap<string, InheritedTierPool>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelPool(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readReceiptSnapshot(
  text: string | null,
  scope: ReconciliationConfigSource,
): ReconciliationOwnershipSnapshot | undefined {
  if (text === null) return undefined;
  try {
    assertOwnershipPayload(Buffer.from(text, "utf8"));
    const receipt = parseOwnershipSnapshot(JSON.parse(text));
    return receipt?.scope === scope ? receipt : undefined;
  } catch {
    return undefined;
  }
}

function parseInheritedConfig(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new Error("invalid inherited config");
  return parsed;
}

function readInheritedLayerPools(layer: ReconciliationConfigSource): {
  path: string;
  text: string | null;
  receiptSnapshot: InheritedPoolSnapshot | null;
  tiers: ReadonlyMap<string, InheritedTierPool>;
} {
  const paths = reconciliationPaths(layer);
  const text = readInheritedConfigSnapshot(paths.configPath);
  const parsed = text === null ? {} : parseInheritedConfig(text);
  const rawPools = isJsonObject(parsed.models) ? parsed.models : {};
  // No pools to protect, so the receipt cannot change the decision and is not read or tracked.
  const hasPools = Object.keys(rawPools).length > 0;
  const receiptText = hasPools ? readInheritedReceiptSnapshot(paths.ownershipPath) : null;
  const receipt = readReceiptSnapshot(receiptText, layer);
  const tiers = new Map(
    Object.entries(rawPools).map(([tier, raw]) => {
      const pool = normalizeModelPool(raw);
      return [tier, { pool, generated: receipt ? tierOwnership(receipt, tier, raw as string | readonly string[]) === "managed" : false }];
    }),
  );
  return {
    path: paths.configPath,
    text,
    receiptSnapshot: hasPools ? { path: paths.ownershipPath, text: receiptText } : null,
    tiers,
  };
}

function readInheritedPools(layers: readonly ReconciliationConfigSource[]): InheritedPools {
  const layerPools = layers.map(readInheritedLayerPools);
  return {
    snapshots: layerPools.flatMap(({ path, text, receiptSnapshot }) =>
      receiptSnapshot ? [{ path, text }, receiptSnapshot] : [{ path, text }],
    ),
    tierNames: new Set(layerPools.flatMap(({ tiers }) => [...tiers.keys()])),
    effective: new Map(layerPools.flatMap(({ tiers }) => [...tiers])),
  };
}

function sameMembership(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Init shadows a tier when it would replace a different pool that holds unowned models. */
function isShadowedTier(proposed: readonly string[], inherited: InheritedTierPool): boolean {
  return inherited.pool.length > 0 && !inherited.generated && !sameMembership(proposed, inherited.pool);
}

function findShadowedTiers(
  proposed: Readonly<Record<string, readonly string[]>>,
  ownedTiers: Readonly<Record<string, unknown>>,
  inherited: ReadonlyMap<string, InheritedTierPool>,
): string[] {
  return Object.keys(proposed)
    .filter((tier) => !Object.hasOwn(ownedTiers, tier) && inherited.has(tier))
    .filter((tier) => isShadowedTier(proposed[tier], inherited.get(tier)!));
}

function selectInitSource(): ReconciliationSourceSnapshot {
  const project = readReconciliationSource("project");
  if (project.configBytes !== null || project.ownershipBytes !== null) return project;
  const workspace = readReconciliationSource("workspace");
  if (workspace.configBytes !== null || workspace.ownershipBytes !== null) return workspace;
  const user = readReconciliationSource("user");
  return user.configBytes !== null || user.ownershipBytes !== null ? user : project;
}

function initSourceLabel(source: ReconciliationSourceSnapshot): string {
  return source.source === "workspace"
    ? "workspace (bifrost.json)"
    : source.source === "user"
      ? `user (${source.configPath})`
      : "project (.pi/bifrost.json)";
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
    models = all.map((model) => ({
      provider: model.provider,
      id: model.id,
      virtual: isVirtualModel(model),
    }));
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
  const refreshEvidence =
    rawEvidence &&
    (rawEvidence.status === "complete" ||
      rawEvidence.status === "partial" ||
      rawEvidence.status === "stale") &&
    Number.isFinite(rawEvidence.refreshedAt)
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

interface ProspectiveConfigValidation {
  readonly installable: boolean;
  /** Structural findings reported as warnings: they never veto a write. */
  readonly warnings: readonly ConfigLoadDiagnostic[];
}

function prospectiveConfigValidation(
  source: ReconciliationConfigSource,
  bytes: Uint8Array,
  state: BifrostState,
): ProspectiveConfigValidation {
  const loaded = loadConfigWithSourceOverride(process.cwd(), state.extensionDir, source, bytes);
  // Schema findings the domain validators own are warnings, so they do not veto
  // a write: an unrecognized field the user already carries must not stop init
  // or a classifier change from being saved. Values that make the policy unsafe
  // are caught by the semantic checks below.
  if (loaded.diagnostics.length > 0) return { installable: false, warnings: loaded.warnings };
  const errors = validateTierPolicyConfig(loaded.config).filter(
    (issue) => issue.severity === "error",
  );
  const validation = validateConfig(loaded.config);
  errors.push(
    ...validation.filter(
      (issue) =>
        issue.severity === "error" &&
        (issue.code?.startsWith("config.reliability_") ||
          issue.code?.startsWith("config.affinity_")),
    ),
  );
  return {
    installable: errors.length === 0 && classifierTotalTimeoutIssue(loaded.config) === undefined,
    warnings: loaded.warnings,
  };
}

function prospectiveConfigInstallable(
  source: ReconciliationConfigSource,
  bytes: Uint8Array,
  state: BifrostState,
): boolean {
  return prospectiveConfigValidation(source, bytes, state).installable;
}

function reconciliationReportLines(report: ReconciliationCommandReport): string[] {
  const lines = [
    "--- config reconcile ---",
    `source: ${report.source}`,
    `status: ${report.status}`,
  ];
  if (report.provider) lines.push(`provider: ${report.provider}`);
  if (report.tier) lines.push(`tier: ${report.tier}`);
  if (report.inventoryStatus) lines.push(`inventory: ${report.inventoryStatus}`);
  if (report.reason) lines.push(`reason: ${report.reason}`);
  if (report.proposalDigest) lines.push(`proposal: ${report.proposalDigest}`);
  if (report.changes.length) {
    lines.push(
      "changes:",
      ...report.changes.map(
        (change) => `  ${change.disposition} ${change.kind} ${change.tier}: ${change.modelKey}`,
      ),
    );
  } else lines.push("changes: none");
  if (report.warnings.length) lines.push(`warnings: ${report.warnings.join(", ")}`);
  if (report.applyResult?.configBackupPath)
    lines.push(`config backup: ${report.applyResult.configBackupPath}`);
  if (report.applyResult?.ownershipBackupPath)
    lines.push(`ownership backup: ${report.applyResult.ownershipBackupPath}`);
  if (report.reason === "operator_repair_required") {
    lines.push(
      "repair: verify no Bifrost writer is active, inspect and remove only its exact stale reconciliation lock files, then retry recover.",
    );
  }
  lines.push("-----------------------");
  return lines;
}

function emitReconciliationReport(
  ctx: ExtensionContext,
  report: ReconciliationCommandReport,
  json: boolean,
): void {
  if (json) {
    console.error(
      `${BIFROST_JSON_PREFIX}${JSON.stringify({
        ...report,
        ...(report.reason === "operator_repair_required"
          ? {
              operatorGuidance:
                "verify_no_active_writer_remove_exact_stale_locks_then_retry_recover",
            }
          : {}),
      })}`,
    );
  } else {
    uiOutput(ctx, reconciliationReportLines(report));
  }
}

function blockedReconciliationReport(
  request: ReconciliationCommandRequest,
  reason: "source_invalid" | "store_io_failure",
): ReconciliationCommandReport {
  return {
    action: request.action,
    source: request.source,
    status: "blocked",
    reason,
    changes: [],
    warnings: [],
  };
}

async function handleReconciliationCommand(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const commandArgs = args.replace(/^config\s+reconcile(?:\s+|$)/iu, "");
  const parsed = parseReconciliationCommandArgs(commandArgs);
  if (!parsed.ok) {
    log(
      ctx,
      "usage: /bifrost config reconcile [--source project|workspace|user] [--tier <tier> --provider <provider>] [--refresh | --apply --proposal <digest> | --recover] [--json]",
      "warning",
    );
    return;
  }
  const request = parsed.request;
  let source: ReconciliationSourceSnapshot;
  try {
    if (request.action === "recover") {
      source = {
        ...reconciliationPaths(request.source),
        source: request.source,
        configBytes: null,
        ownershipBytes: null,
      };
    } else source = readReconciliationSource(request.source);
  } catch {
    emitReconciliationReport(
      ctx,
      blockedReconciliationReport(request, "source_invalid"),
      request.json,
    );
    return;
  }

  if (request.action === "preview" && request.refresh) {
    const initial = reconciliationRegistrySnapshot(ctx, state, request.provider);
    if (!initial.knownProviders.includes(request.provider)) {
      const { refresh: _refresh, ...previewRequest } = request;
      const report = runReconciliationCommand(
        previewRequest,
        { source, registry: initial },
        {
          validateMergedConfig: () => false,
          apply: applyReconciliationTransaction,
          recover: recoverReconciliationTransaction,
        },
      );
      emitReconciliationReport(ctx, report, request.json);
      return;
    }
    if (
      ctx.hasUI &&
      !(await ctx.ui.confirm(
        "Refresh provider model catalog?",
        `Contact ${request.provider} to refresh its model catalog before previewing. This will not apply config changes.`,
      ))
    ) {
      logImportant(ctx, "Catalog refresh cancelled", "No config proposal was made.", "info");
      return;
    }
    uiBusy(ctx, `Refreshing ${request.provider} model catalog...`);
    try {
      const outcome = await waitForRegistryRefresh(
        (signal) =>
          ctx.modelRegistry.refresh({
            allowNetwork: true,
            force: true,
            providers: [request.provider],
            signal,
          }),
        ctx.signal,
        (result) =>
          setRegistryProviderEvidence(
            state,
            request.provider,
            projectProviderRefreshEvidence(
              result,
              request.provider,
              initial.knownProviders,
              Date.now(),
            ),
          ),
      );
      if (outcome === "aborted") {
        setRegistryProviderEvidence(state, request.provider, {
          status: "stale",
          refreshedAt: Date.now(),
        });
        emitReconciliationReport(
          ctx,
          {
            action: "preview",
            source: request.source,
            status: "aborted",
            reason: "inventory_stale",
            provider: request.provider,
            tier: request.tier,
            changes: [],
            warnings: [],
          },
          request.json,
        );
        return;
      }
    } catch {
      setRegistryProviderEvidence(state, request.provider, {
        status: "stale",
        refreshedAt: Date.now(),
      });
    } finally {
      uiDone(ctx);
    }
  }

  const registry =
    request.action === "recover"
      ? reconciliationRegistrySnapshot(ctx, state, "")
      : reconciliationRegistrySnapshot(ctx, state, request.provider);
  // A planned change that would load with structural warnings must say so
  // before the user commits it; the committed case reloads, which reports them.
  let prospectiveWarnings: readonly ConfigLoadDiagnostic[] = [];
  const dependencies = {
    validateMergedConfig: (selected: ReconciliationConfigSource, bytes: Uint8Array) => {
      const validation = prospectiveConfigValidation(selected, bytes, state);
      prospectiveWarnings = validation.warnings;
      return validation.installable;
    },
    apply: applyReconciliationTransaction,
    recover: recoverReconciliationTransaction,
  };
  const planRequest: ReconciliationCommandRequest =
    request.action === "preview" && request.refresh
      ? (({ refresh: _refresh, ...previewRequest }) => previewRequest)(request)
      : request;
  const report = runReconciliationCommand(planRequest, { source, registry }, dependencies);
  if (report.status === "ready" && prospectiveWarnings.length > 0) {
    log(
      ctx,
      `Bifrost config would load with warnings: ${prospectiveWarnings.map(({ message }) => message).join(" ")}`,
      "warning",
    );
  }
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

function emitConfigMigrationReport(
  ctx: ExtensionContext,
  report: Record<string, unknown>,
  json: boolean,
): void {
  if (json) {
    console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
    return;
  }
  const lines = [
    `Config migration: ${String(report.status)} (${String(report.source)} source).`,
    ...(typeof report.reason === "string" ? [`No changes made: ${report.reason}.`] : []),
    ...(typeof report.proposalDigest === "string"
      ? [`Review digest: ${report.proposalDigest}`]
      : []),
    ...(typeof report.backupPath === "string" ? [`Exact backup: ${report.backupPath}`] : []),
    ...(report.status === "committed"
      ? ["Run /bifrost reload to activate the migrated configuration."]
      : []),
  ];
  uiOutput(ctx, lines);
}

async function handleConfigMigrationCommand(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const commandArgs = args.replace(/^config\s+migrate(?:\s+|$)/iu, "");
  const parsed = parseConfigMigrationArgs(commandArgs);
  if (!parsed.ok) {
    log(
      ctx,
      "usage: /bifrost config migrate [--source project|workspace|user] [--apply --proposal <digest>] [--json]",
      "warning",
    );
    return;
  }
  const request = parsed.request;
  const sourcePath = reconciliationPaths(request.source).configPath;
  let sourceBytes: Buffer;
  try {
    sourceBytes = readConfigMigrationSource(sourcePath);
  } catch {
    emitConfigMigrationReport(
      ctx,
      { version: 1, source: request.source, status: "blocked", reason: "source_invalid" },
      request.json,
    );
    return;
  }

  const plan = planConfigMigration(request.source, sourceBytes);
  if (plan.status === "blocked") {
    emitConfigMigrationReport(
      ctx,
      { version: 1, source: request.source, status: "blocked", reason: plan.reason },
      request.json,
    );
    return;
  }
  if (plan.status === "current") {
    emitConfigMigrationReport(
      ctx,
      { version: 1, source: request.source, status: "current" },
      request.json,
    );
    return;
  }

  if (!prospectiveConfigInstallable(request.source, plan.replacementBytes, state)) {
    emitConfigMigrationReport(
      ctx,
      {
        version: 1,
        source: request.source,
        status: "blocked",
        reason: "merged_config_invalid",
      },
      request.json,
    );
    return;
  }

  if (!request.apply) {
    emitConfigMigrationReport(
      ctx,
      {
        version: 1,
        source: request.source,
        status: "ready",
        proposalDigest: plan.proposalDigest,
        changes: [{ path: "schemaVersion", from: plan.beforeVersion ?? "absent", to: 2 }],
      },
      request.json,
    );
    return;
  }
  if (request.proposalDigest !== plan.proposalDigest) {
    emitConfigMigrationReport(
      ctx,
      { version: 1, source: request.source, status: "blocked", reason: "proposal_mismatch" },
      request.json,
    );
    return;
  }

  try {
    const backupPath = applyConfigMigration({
      sourcePath,
      expectedSourceBytes: sourceBytes,
      replacementBytes: plan.replacementBytes,
    });
    emitConfigMigrationReport(
      ctx,
      {
        version: 1,
        source: request.source,
        status: "committed",
        proposalDigest: plan.proposalDigest,
        backupPath,
        changes: [{ path: "schemaVersion", from: plan.beforeVersion ?? "absent", to: 2 }],
      },
      request.json,
    );
  } catch (error) {
    const migrationError = error instanceof ConfigMigrationError ? error : undefined;
    emitConfigMigrationReport(
      ctx,
      {
        version: 1,
        source: request.source,
        status: "blocked",
        reason: migrationError?.code ?? "apply_failed",
        ...(migrationError?.backupPath ? { backupPath: migrationError.backupPath } : {}),
      },
      request.json,
    );
  }
}

async function handleConfigCommand(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  if (/^config\s+migrate(?:\s|$)/iu.test(args.trim())) {
    await handleConfigMigrationCommand(args, ctx, state);
    return;
  }
  await handleReconciliationCommand(args, ctx, state);
}

async function handleInit(args: string, ctx: ExtensionContext, state: BifrostState): Promise<void> {
  const tokens = args.trim().split(/\s+/).slice(1);
  if (tokens.some((token) => !["-f", "--write", "-g"].includes(token))) {
    reportInitOutcome(
      ctx,
      "not started",
      "Nothing was read or written.",
      "Usage: /bifrost init [-f] [--write] [-g].",
      "warning",
    );
    return;
  }
  const selectedSource: ReconciliationConfigSource = tokens.includes("-g") ? "user" : "project";
  const bootstrapOriginalConfig = state.onInitStarted?.(ctx.sessionManager);
  const initConfig = bootstrapOriginalConfig ?? state.config;
  clearBifrostWidgets(ctx);
  let initRefreshReceipt: { catalogKeys: string[]; evidence: Map<string, object> } | undefined;
  let refreshedCatalogKeys: string[] | undefined;
  let refreshedProviders: string[] = [];
  if (typeof ctx.modelRegistry.refresh === "function") {
    state.registryInventoryEvidence = Object.freeze(
      Object.fromEntries(
        Object.entries(state.registryInventoryEvidence ?? {}).map(([provider, evidence]) => [
          provider,
          { ...evidence, status: "stale" as const },
        ]),
      ),
    );
    uiBusy(ctx, "Refreshing Pi's model catalog...");
    try {
      const outcome = await waitForRegistryRefresh(
        (signal) =>
          ctx.modelRegistry.refresh({
            allowNetwork: true,
            force: true,
            ...(signal ? { signal } : {}),
          }),
        ctx.signal,
        (result) => {
          let knownProviders: string[] = [];
          try {
            const catalog = ctx.modelRegistry.getAll().filter((model) => !isBifrostAuto(model));
            knownProviders = [...new Set(catalog.map((model) => model.provider))];
            refreshedProviders = knownProviders;
            refreshedCatalogKeys = catalog.map(modelKey).sort();
          } catch {
            /* failed catalog snapshots stay stale */
          }
          const refreshedAt = Date.now();
          for (const provider of knownProviders) {
            const evidence = projectProviderRefreshEvidence(
              result,
              provider,
              knownProviders,
              refreshedAt,
            );
            state.registryInventoryEvidence = Object.freeze({
              ...(state.registryInventoryEvidence ?? {}),
              [provider]: Object.freeze(evidence),
            });
          }
        },
      );
      if (outcome === "aborted") {
        state.forceRegistryRefresh = true;
        reportInitOutcome(
          ctx,
          "cancelled",
          "Nothing was saved.",
          "Run /bifrost init again to refresh the catalog.",
          "info",
        );
        return;
      }
      state.forceRegistryRefresh = false;
      if (refreshedCatalogKeys) {
        initRefreshReceipt = {
          catalogKeys: refreshedCatalogKeys,
          evidence: new Map(
            refreshedProviders.flatMap((provider) => {
              const evidence = state.registryInventoryEvidence?.[provider];
              return evidence ? [[provider, evidence] as const] : [];
            }),
          ),
        };
      }
    } catch {
      state.forceRegistryRefresh = true;
      logImportant(
        ctx,
        "Catalog refresh unavailable",
        "Using the available catalog snapshot.",
        "warning",
      );
    } finally {
      uiDone(ctx);
    }
  }
  // Reuse recent probe data; otherwise manual init probes before proposing model pools.
  const probePath = join(process.cwd(), ".pi", "bifrost-probe.json");
  const available = ctx.modelRegistry.getAvailable().filter((model) => !isVirtualModel(model));
  let workingModels: {
    provider: string;
    model: string;
    cost: { input: number; output: number };
    duration_ms: number;
  }[] = [];
  let probeLoaded = false;
  let ranProbe = false;
  let probeAge = "";

  if (!isForced(args)) {
    const cachedResults = readRecentCompleteProbeReport(probePath, available);
    if (cachedResults) {
      workingModels = cachedResults
        .filter((result) => result.status === "ok")
        .map((result) => ({
          provider: result.provider,
          model: result.model,
          cost: { input: result.cost_input ?? 0, output: result.cost_output ?? 0 },
          duration_ms: result.duration_ms ?? 0,
        }));
      probeAge = "within the past hour";
      probeLoaded = true;
    }
  }

  if (!probeLoaded) {
    ranProbe = true;
    const availableCount = available.length;
    log(ctx, `Probing ${availableCount} models to find working ones...`);
    let okCount = 0;
    let errCount = 0;

    uiBusy(ctx, `Probing ${availableCount} models...`);
    let probeRun: Awaited<ReturnType<typeof runProbe>>;
    try {
      probeRun = await runProbe(ctx, {
        ...probeOptionsFromConfig(initConfig.probe),
        signal: ctx.signal,

        onProgress: (done, total, last) => {
          if (last.status === "ok") okCount++;
          else if (last.status === "error" || last.status === "timeout") errCount++;

          setProbeProgress(ctx, { done, total, okCount, errCount });
        },
      });
    } finally {
      // The probe widget must never outlive the probe: every later exit path
      // renders its feedback in the chat, and a stale progress panel reads as
      // "still probing". A rejected probe skips the code below, so clear here.
      uiDone(ctx);
      if (ctx.hasUI) ctx.ui.setWidget("bifrost-probe", []);
    }
    if (probeRun.cancelled || ctx.signal?.aborted) {
      reportInitOutcome(
        ctx,
        "cancelled",
        "Nothing was saved.",
        "Probe results from this run were discarded; run /bifrost init again to retry.",
        "info",
      );
      return;
    }
    const { results } = probeRun;
    state.reliabilityStore.applyOutcomes(
      results.map((r) =>
        r.status === "ok"
          ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
          : {
              model: `${r.provider}/${r.model}`,
              ok: false as const,
              source: "probe",
              reason: r.error ?? r.status,
            },
      ),
      Date.now(),
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
  }
  if (probeLoaded && workingModels.length === 0) {
    reportInitOutcome(
      ctx,
      "failed — no working models",
      "Nothing was saved.",
      "Check API keys, credits, and network, then retry.",
      "error",
    );
    return;
  }

  let refreshRemainsCurrent = false;
  if (ranProbe && initRefreshReceipt && !ctx.signal?.aborted && !state.forceRegistryRefresh) {
    try {
      const currentKeys = ctx.modelRegistry
        .getAll()
        .filter((model) => !isBifrostAuto(model))
        .map(modelKey)
        .sort();
      refreshRemainsCurrent =
        currentKeys.length === initRefreshReceipt.catalogKeys.length &&
        currentKeys.every((key, index) => key === initRefreshReceipt!.catalogKeys[index]) &&
        [...initRefreshReceipt.evidence].every(
          ([provider, evidence]) => state.registryInventoryEvidence?.[provider] === evidence,
        );
    } catch {
      /* an unreadable catalog cannot extend this command's refresh evidence */
    }
  }

  if (probeLoaded && workingModels.length > 0 && ctx.mode !== "tui") {
    logImportant(
      ctx,
      "Using verified models",
      `${workingModels.length} probe-verified models (${probeAge}).`,
      "info",
    );
  }

  const models: Record<string, string[]> = {};
  const uncategorized: string[] = [];

  for (const m of available) {
    const key = `${m.provider}/${m.id}`;

    // If probe data is loaded, skip models that failed or timed out.
    if (probeLoaded) {
      const working = workingModels.find((w) => w.provider === m.provider && w.model === m.id);
      if (!working) continue;
    }

    const tier = guessTier(m);
    if (tier) {
      models[tier] = models[tier] ?? [];
      models[tier].push(key);
    } else {
      uncategorized.push(key);
    }
  }

  if (probeLoaded && Object.values(models).every((pool) => pool.length === 0)) {
    reportInitOutcome(
      ctx,
      "failed — no working models",
      "Nothing was saved.",
      "Check API keys, credits, and network, then retry.",
      "error",
    );
    return;
  }
  const probeVerified = new Set(Object.values(models).flat());

  // Sort each tier by probe response time (fastest first) so "first"
  // strategy picks the fastest model.
  if (probeLoaded) {
    const speedMap = new Map(workingModels.map((w) => [`${w.provider}/${w.model}`, w.duration_ms]));
    for (const tier of Object.keys(models)) {
      models[tier].sort((a, b) => (speedMap.get(a) ?? Infinity) - (speedMap.get(b) ?? Infinity));
    }
  }

  let source: ReconciliationSourceSnapshot;
  try {
    source = readReconciliationSource(selectedSource);
  } catch {
    reportInitOutcome(
      ctx,
      "blocked",
      "Nothing was saved; the current config could not be read safely.",
      "Check that the config file is readable, then retry.",
      "error",
    );
    return;
  }
  let sourceConfig: Record<string, unknown> = {};
  if (source.configBytes !== null) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(source.configBytes).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid config root");
      sourceConfig = parsed as Record<string, unknown>;
    } catch {
      reportInitOutcome(
        ctx,
        "blocked",
        "Nothing was saved; the selected config could not be parsed.",
        "Fix the config file, then run /bifrost init again.",
        "error",
      );
      return;
    }
  }
  const sourceModels =
    sourceConfig.models &&
    typeof sourceConfig.models === "object" &&
    !Array.isArray(sourceConfig.models)
      ? (sourceConfig.models as Record<string, unknown>)
      : {};
  let inheritedSources: readonly InheritedPoolSnapshot[] = [];
  let inheritedTiers: ReadonlySet<string> = new Set<string>();
  if (selectedSource === "project") {
    try {
      const inherited = readInheritedPools(["user", "workspace"]);
      inheritedSources = inherited.snapshots;
      inheritedTiers = inherited.tierNames;
      const shadowedTiers = findShadowedTiers(models, sourceModels, inherited.effective);
      if (shadowedTiers.length > 0) {
        reportInitOutcome(
          ctx,
          "blocked",
          `Nothing was saved; pools inherited from your global or workspace config already set ${shadowedTiers.join(", ")} with different models.`,
          "Edit the existing source, use /bifrost init -g for the global config, or review /bifrost config reconcile --source workspace.",
          "warning",
        );
        return;
      }
    } catch {
      reportInitOutcome(
        ctx,
        "blocked",
        "Nothing was saved; your inherited config could not be read safely.",
        "Fix your global or workspace config, then retry.",
        "error",
      );
      return;
    }
  }
  const sourceClassifier =
    sourceConfig.classifier &&
    typeof sourceConfig.classifier === "object" &&
    !Array.isArray(sourceConfig.classifier)
      ? (sourceConfig.classifier as Record<string, unknown>)
      : {};
  const configLayers = loadConfigForReload(process.cwd(), state.extensionDir);
  const publicDefaults = BUNDLED_PUBLIC_INIT_DEFAULTS as unknown as Record<string, unknown>;
  const layerOrder = ["global", "workspace", "project"] as const;
  const targetLayer =
    source.source === "project"
      ? "project"
      : source.source === "workspace"
        ? "workspace"
        : "global";
  const targetLayerIndex = layerOrder.indexOf(targetLayer);
  const inheritedFields = new Set(
    configLayers.sourceFields
      .filter(
        ({ layer }) =>
          layer !== "effective" &&
          layerOrder.indexOf(layer as (typeof layerOrder)[number]) < targetLayerIndex,
      )
      .flatMap(({ fields }) => fields),
  );
  const detectedClassifier = state.effectiveClassifierBackend(initConfig, ctx);
  const classifierEnabled = classifierEnablementFor(state, ctx, initConfig).enabled;
  const needsDetectedPromptModel =
    classifierEnabled &&
    detectedClassifier.backend === CLASSIFIER_BACKEND_IDS.prompt &&
    initConfig.classifier?.model === undefined;
  let classifierModel: string | undefined;
  if (needsDetectedPromptModel) {
    const reliability = state.reliabilityStore.getState();
    const eligible = [...available]
      .filter((model) => !isBifrostAuto(model))
      .sort((left, right) => modelKey(left).localeCompare(modelKey(right)))
      .filter((model) => {
        const key = modelKey(model);
        const circuit = getCircuitState(reliability, key, Date.now(), initConfig.reliability);
        return !circuit.open && !hasActiveAllowanceCooldown(reliability, key, Date.now());
      });
    const eligibleKeys = new Set(eligible.map(modelKey));
    const probeChoices = probeLoaded
      ? workingModels
          .filter(
            (model) =>
              eligibleKeys.has(`${model.provider}/${model.model}`) &&
              model.cost.input + model.cost.output < 2,
          )
          .sort((left, right) => left.duration_ms - right.duration_ms)
      : [];
    classifierModel = probeChoices[0]
      ? `${probeChoices[0].provider}/${probeChoices[0].model}`
      : !probeLoaded && eligible[0]
        ? modelKey(eligible[0])
        : undefined;
    if (!classifierModel) {
      logImportant(
        ctx,
        "Classifier model unavailable",
        "Init will omit classifier.model; regex fallback remains available.",
        "warning",
      );
    }
  }
  const effectiveClassifierSummary = !classifierEnabled
    ? "off"
    : detectedClassifier.backend !== CLASSIFIER_BACKEND_IDS.prompt
      ? `${detectedClassifier.backend} (${detectedClassifier.auto ? "detected default" : "configured"})`
      : initConfig.classifier?.model
        ? `prompt (${initConfig.classifier.model}, configured)`
        : classifierModel
          ? `prompt (${classifierModel}, detected default)`
          : "prompt (no eligible model; regex fallback)";

  const proposal = buildInitProposal(
    models,
    inheritedFields.has("classifier") || sourceConfig.classifier !== undefined
      ? undefined
      : classifierModel,
    state.extensionDir,
    sourceClassifier.backend as ClassifierBackend | undefined,
  ) as Record<string, unknown> & { classifier: Record<string, unknown> };
  proposal.cache = publicDefaults.cache ?? {
    enabled: true,
    maxEntries: DEFAULT_MAX_ENTRIES,
    threshold: DEFAULT_THRESHOLD,
  };
  proposal.classifier = {
    ...(publicDefaults.classifier as Record<string, unknown> | undefined),
    ...proposal.classifier,
  };
  proposal.reliability = publicDefaults.reliability ?? resolveReliabilityConfig(undefined);
  proposal.debug = publicDefaults.debug ?? { enabled: false };
  for (const key of [
    "schemaVersion",
    "tierPolicies",
    "economics",
    "affinity",
    "routingScope",
    "probe",
  ] as const) {
    if (sourceConfig[key] !== undefined) proposal[key] = sourceConfig[key];
    else if (publicDefaults[key] !== undefined) proposal[key] = publicDefaults[key];
  }
  proposal.enabled = sourceConfig.enabled ?? publicDefaults.enabled ?? true;
  proposal.strategy = sourceConfig.strategy ?? publicDefaults.strategy ?? "first";
  const proposedStrategies = proposal.categoryStrategies as Record<string, RoutingStrategy>;
  proposal.categoryStrategies = Object.fromEntries(
    Object.keys(models).map((tier) => [
      tier,
      (sourceConfig.categoryStrategies as Record<string, RoutingStrategy> | undefined)?.[tier] ??
        (publicDefaults.categoryStrategies as Record<string, RoutingStrategy> | undefined)?.[
          tier
        ] ??
        proposedStrategies[tier] ??
        "first",
    ]),
  );
  const finalTiers = new Set([
    ...Object.keys(models),
    ...Object.keys(sourceModels),
    ...inheritedTiers,
  ]);
  proposal.rules = sourceConfig.rules ?? DEFAULT_RULES.filter(({ model }) => finalTiers.has(model));
  const defaultTier = sourceConfig.default ?? publicDefaults.default;
  if (typeof defaultTier === "string" && models[defaultTier]?.length)
    proposal.default = defaultTier;
  let transaction: Parameters<typeof applyReconciliationTransaction>[0];
  let receiptOnly = false;
  let changes: readonly { kind: "add" | "remove"; tier: string; modelKey: string }[];
  let settingsAdded = false;
  if (source.configBytes !== null) {
    const byProvider = new Map<string, Record<string, string[]>>();
    for (const model of available) {
      if (isBifrostAuto(model)) continue;
      const tier = guessTier(model);
      const key = modelKey(model);
      const byTier = byProvider.get(model.provider) ?? {};
      byProvider.set(model.provider, byTier);
      if (!tier) continue;
      if (probeLoaded && !probeVerified.has(key)) continue;
      byTier[tier] = [...(byTier[tier] ?? []), key];
    }
    const inventories = [...byProvider.entries()].map(([provider, modelsByTier]) => {
      const evidence = state.registryInventoryEvidence?.[provider];
      let authConfigured: boolean | undefined;
      try {
        authConfigured = ctx.modelRegistry.getProviderAuthStatus(provider)?.configured;
      } catch {
        authConfigured = undefined;
      }
      const now = Date.now();
      const fresh =
        evidence?.status === "complete" &&
        now >= evidence.refreshedAt &&
        (now - evidence.refreshedAt < REGISTRY_REFRESH_TTL_MS ||
          (refreshRemainsCurrent && initRefreshReceipt?.evidence.get(provider) === evidence));
      const status = state.forceRegistryRefresh
        ? ("stale" as const)
        : authConfigured === false
          ? ("auth_failed" as const)
          : fresh && authConfigured === true
            ? ("complete" as const)
            : ("stale" as const);
      return { provider, status, modelsByTier };
    });
    const plan = buildInitMembershipPlan(
      source,
      inventories,
      (selected, bytes) => prospectiveConfigInstallable(selected, bytes, state),
    );
    if (plan.status !== "ready" || !plan.transaction) {
      if (plan.reason === "no_changes" && plan.status === "blocked") {
        const existing = JSON.parse(Buffer.from(source.configBytes!).toString("utf8")) as Record<
          string,
          unknown
        >;
        let addedSetting = false;
        for (const [key, value] of Object.entries(proposal)) {
          if (
            key !== "$schema" &&
            (key === "models" || !inheritedFields.has(key)) &&
            existing[key] === undefined
          ) {
            existing[key] = value;
            addedSetting = true;
          }
        }
        if (addedSetting) {
          settingsAdded = true;
          const nextConfigBytes = Buffer.from(JSON.stringify(existing, null, 2) + "\n", "utf8");
          const ownershipBytes =
            source.ownershipBytes ?? emptyOwnershipBytes(source.source);
          if (
            nextConfigBytes.byteLength > MAX_CONFIG_SOURCE_BYTES ||
            !prospectiveConfigInstallable(source.source, nextConfigBytes, state)
          ) {
            reportInitOutcome(
              ctx,
              "blocked",
              "Nothing was saved; the proposed config is invalid or too large.",
              "Inspect the existing config, then retry.",
              "error",
            );
            return;
          }
          transaction = {
            configPath: source.configPath,
            ownershipPath: source.ownershipPath,
            journalPath: source.journalPath,
            expectedConfigDigest: createHash("sha256").update(source.configBytes!).digest("hex"),
            expectedOwnershipDigest: source.ownershipBytes
              ? createHash("sha256").update(source.ownershipBytes).digest("hex")
              : null,
            nextConfigBytes,
            nextOwnershipBytes: ownershipBytes,
          };
          changes = [];
        } else {
          if (source.ownershipBytes !== null) {
            reportInitOutcome(
              ctx,
              "unchanged",
              "Nothing changed; the pools already match what init would write.",
              undefined,
              "info",
            );
            return;
          }
          // Empty ownership claims make existing entries explicitly manual without rewriting config.
          receiptOnly = true;
          transaction = {
            configPath: source.configPath,
            ownershipPath: source.ownershipPath,
            journalPath: source.journalPath,
            expectedConfigDigest: createHash("sha256").update(source.configBytes!).digest("hex"),
            expectedOwnershipDigest: null,
            nextConfigBytes: source.configBytes!,
            nextOwnershipBytes: emptyOwnershipBytes(source.source),
          };
          changes = [];
        }
      } else {
        if (plan.status === "advisory") {
          reportInitOutcome(
            ctx,
            "paused",
            "Nothing was saved; the model inventory is incomplete or stale.",
            "Run /bifrost init -f to refresh the catalog, then retry.",
            "warning",
          );
        } else if (plan.reason === "no_changes") {
          reportInitOutcome(
            ctx,
            "unchanged",
            "Nothing changed; the pools already match what init would write.",
            undefined,
            "info",
          );
        } else {
          reportInitOutcome(
            ctx,
            "blocked",
            plan.reason === "source_invalid"
              ? "Nothing was saved; the existing configuration is invalid."
              : plan.reason === "prospective_config_invalid"
                ? "Nothing was saved; the proposed configuration failed validation."
                : `Nothing was saved; membership changes could not be prepared (${plan.reason ?? "unknown reason"}).`,
            "Fix the configuration and retry.",
            "error",
          );
        }
        return;
      }
    } else {
      const reconciled = JSON.parse(
        Buffer.from(plan.transaction.nextConfigBytes).toString("utf8"),
      ) as Record<string, unknown>;
      for (const [key, value] of Object.entries(proposal)) {
        if (
          key !== "$schema" &&
          (key === "models" || !inheritedFields.has(key)) &&
          reconciled[key] === undefined
        ) {
          reconciled[key] = value;
          settingsAdded = true;
        }
      }
      const nextConfigBytes = settingsAdded
        ? Buffer.from(JSON.stringify(reconciled, null, 2) + "\n", "utf8")
        : plan.transaction.nextConfigBytes;
      if (
        nextConfigBytes.byteLength > MAX_CONFIG_SOURCE_BYTES ||
        !prospectiveConfigInstallable(source.source, nextConfigBytes, state)
      ) {
        reportInitOutcome(
          ctx,
          "blocked",
          "Nothing was saved; the proposed config is invalid or too large.",
          "Inspect the existing config, then retry.",
          "error",
        );
        return;
      }
      transaction = { ...plan.transaction, nextConfigBytes };
      changes = plan.changes;
    }
  } else {
    if (source.ownershipBytes !== null) {
      reportInitOutcome(
        ctx,
        "blocked",
        "Nothing was saved; a saved ownership record exists without its config.",
        "Review the target directory, then retry.",
        "error",
      );
      return;
    }
    const ownership = buildInitOwnershipReceipt(source.source, models);
    if (!ownership) {
      reportInitOutcome(
        ctx,
        "blocked",
        "Nothing was saved; the ownership record for this init could not be created.",
        "Retry; if it fails again, inspect the target directory.",
        "error",
      );
      return;
    }
    const installProposal = Object.fromEntries(
      Object.entries(proposal).filter(
        ([key]) => key === "$schema" || key === "models" || !inheritedFields.has(key),
      ),
    );
    const configBytes = Buffer.from(JSON.stringify(installProposal, null, 2) + "\n", "utf8");
    const ownershipBytes = Buffer.from(JSON.stringify(ownership, null, 2) + "\n", "utf8");
    if (
      configBytes.byteLength > MAX_CONFIG_SOURCE_BYTES ||
      ownershipBytes.byteLength > 5_000_000 ||
      !prospectiveConfigInstallable(source.source, configBytes, state)
    ) {
      reportInitOutcome(
        ctx,
        "blocked",
        "Nothing was saved; the proposed config is invalid or too large.",
        "Inspect the existing config, then retry.",
        "error",
      );
      return;
    }
    transaction = {
      configPath: source.configPath,
      ownershipPath: source.ownershipPath,
      journalPath: source.journalPath,
      expectedConfigDigest: null,
      expectedOwnershipDigest: null,
      nextConfigBytes: configBytes,
      nextOwnershipBytes: ownershipBytes,
    };
    settingsAdded = true;
    changes = Object.entries(models).flatMap(([tier, keys]) =>
      keys.map((key) => ({ kind: "add" as const, tier, modelKey: key })),
    );
  }
  const savedPools = (
    JSON.parse(Buffer.from(transaction.nextConfigBytes).toString("utf8")) as Record<string, unknown>
  ).models as Record<string, unknown>;
  const savedModelKeys = Object.values(savedPools).flatMap((pool) =>
    typeof pool === "string"
      ? [pool]
      : Array.isArray(pool)
        ? pool.filter((key): key is string => typeof key === "string")
        : [],
  );
  const unverifiedSavedCount = probeLoaded
    ? savedModelKeys.filter((key) => !probeVerified.has(key)).length
    : 0;
  const added = changes.filter((change) => change.kind === "add");
  const removed = changes.filter((change) => change.kind === "remove");
  const tierSummary = [...new Set(changes.map((change) => change.tier))]
    .sort()
    .map(
      (tier) =>
        tier +
        ": +" +
        added.filter((change) => change.tier === tier).length +
        "/-" +
        removed.filter((change) => change.tier === tier).length,
    )
    .slice(0, 5);

  const previewLines = [
    "◆ Bifrost · Setup preview",
    "",
    probeLoaded
      ? `  ✓ ${workingModels.length} working models (${probeAge})`
      : `  ${available.length} catalog models (not probe-verified)`,
    "",
    `  Pools       +${added.length} / -${removed.length} memberships`,
    ...(tierSummary.length ? [`  Tiers       ${tierSummary.join(" · ")}`] : []),
    `  Classifier  ${effectiveClassifierSummary}`,
    `  Save to     ${initSourceLabel(source)}`,
    ...(settingsAdded ? ["  Defaults    Added where missing"] : []),
    ...(uncategorized.length ? [`  ! ${uncategorized.length} uncategorized models excluded`] : []),
    ...(unverifiedSavedCount
      ? [` ⚠️ ${unverifiedSavedCount} unverified membership preserved`]
      : []),
  ];

  // Replace probing UI with the setup preview.
  if (ctx.mode === "tui") {
    ctx.ui.setWidget("bifrost-probe", undefined);

    ctx.ui.setWidget("bifrost-output", (_tui, theme) => {
      const lines = [
        theme.bold("◆ Bifrost") + theme.fg("dim", " · Setup preview"),
        "",
        probeLoaded
          ? theme.fg("success", `  ✓ ${workingModels.length} working models (${probeAge})`)
          : theme.fg("warning", `  ${available.length} listed models (not verified)`),
        "",
        theme.fg("muted", "  Pools       ") +
          theme.fg("success", `+${added.length}`) +
          theme.fg("dim", " / ") +
          theme.fg("error", `-${removed.length}`) +
          theme.fg("dim", " memberships"),

        ...previewLines
          .slice(5)
          .map((line) => (line.trimStart().startsWith("!") ? theme.fg("warning", line) : line)),
      ];

      return new Text(lines.join("\n"), 0, 0);
    });
  } else {
    uiOutput(ctx, previewLines);
  }

  if (uncategorized.length > 0) {
    logImportant(
      ctx,
      "Uncategorized models",
      `${uncategorized.length} model(s) are not in any tier. Edit ${source.configPath} to assign them.`,
      "warning",
    );
  }

  const writeWithoutPrompt = args.trim().split(/\s+/).includes("--write");
  if (!ctx.hasUI && !writeWithoutPrompt) {
    reportInitOutcome(
      ctx,
      "stopped before saving",
      "Nothing was saved; recent probe results are reused for an hour unless you pass -f or the catalog changes.",
      "Run /bifrost init in the TUI, or pass --write to save without the confirm.",
      "warning",
    );
    return;
  }

  const ok =
    writeWithoutPrompt ||
    (await ctx.ui.confirm("Save Bifrost setup?", `Apply the changes shown above?`));
  // The review card is stale from here on: every remaining exit either saves or
  // reports why not, and the footer card must be the terminal state.
  clearBifrostWidgets(ctx);
  if (!ok) {
    reportInitOutcome(
      ctx,
      "declined",
      "Nothing was saved; recent probe results are reused for an hour unless you pass -f or the catalog changes.",
      "Run /bifrost init again to review and save.",
      "info",
    );
    return;
  }

  if (ctx.signal?.aborted) {
    reportInitOutcome(
      ctx,
      "cancelled",
      "The reviewed update was not saved.",
      "Run /bifrost init again to review and save.",
      "info",
    );
    return;
  }
  const currentKeys = ctx.modelRegistry
    .getAvailable()
    .filter((model) => !isBifrostAuto(model))
    .map(modelKey)
    .sort();
  const plannedKeys = available
    .filter((model) => !isBifrostAuto(model))
    .map(modelKey)
    .sort();
  let refreshReceiptChanged = false;
  if (refreshRemainsCurrent && initRefreshReceipt) {
    try {
      const currentCatalogKeys = ctx.modelRegistry
        .getAll()
        .filter((model) => !isBifrostAuto(model))
        .map(modelKey)
        .sort();
      refreshReceiptChanged =
        state.forceRegistryRefresh === true ||
        currentCatalogKeys.length !== initRefreshReceipt.catalogKeys.length ||
        currentCatalogKeys.some((key, index) => key !== initRefreshReceipt!.catalogKeys[index]) ||
        [...initRefreshReceipt.evidence].some(
          ([provider, evidence]) => state.registryInventoryEvidence?.[provider] !== evidence,
        );
    } catch {
      refreshReceiptChanged = true;
    }
  }
  if (
    refreshReceiptChanged ||
    currentKeys.length !== plannedKeys.length ||
    currentKeys.some((key, index) => key !== plannedKeys[index])
  ) {
    reportInitOutcome(
      ctx,
      "stale review",
      "Nothing was saved; Pi's model inventory changed while awaiting confirmation.",
      "Run /bifrost init again to review the new models.",
      "warning",
    );
    return;
  }
  let currentSource: ReconciliationSourceSnapshot;
  try {
    currentSource = readReconciliationSource(selectedSource);
  } catch {
    reportInitOutcome(
      ctx,
      "blocked",
      "Nothing was saved; the config destination could not be checked.",
      "Run /bifrost init again.",
      "warning",
    );
    return;
  }
  try {
    for (const { path, text } of inheritedSources) {
      if (readInheritedConfigSnapshot(path) !== text) {
        reportInitOutcome(
          ctx,
          "stale review",
          "Nothing was saved; your inherited config changed while awaiting confirmation.",
          "Run /bifrost init again to review the new configuration.",
          "warning",
        );
        return;
      }
    }
  } catch {
    reportInitOutcome(
      ctx,
      "blocked",
      "Nothing was saved; your inherited config could not be checked.",
      "Run /bifrost init again.",
      "warning",
    );
    return;
  }
  if (currentSource.source !== source.source || currentSource.configPath !== source.configPath) {
    reportInitOutcome(
      ctx,
      "stale review",
      "Nothing was saved; the config destination changed while awaiting confirmation.",
      "Run /bifrost init again.",
      "warning",
    );
    return;
  }
  const targetDirectory = dirname(source.configPath);
  if (!existsSync(targetDirectory)) mkdirSync(targetDirectory, { recursive: true });
  const ownershipDirectory = dirname(source.ownershipPath);
  if (!existsSync(ownershipDirectory)) mkdirSync(ownershipDirectory, { recursive: true });
  try {
    if (receiptOnly) {
      createReconciliationOwnershipReceipt({
        configPath: transaction.configPath,
        ownershipPath: transaction.ownershipPath,
        journalPath: transaction.journalPath,
        expectedConfigDigest: transaction.expectedConfigDigest!,
        ownershipBytes: transaction.nextOwnershipBytes,
      });
    } else {
      applyReconciliationTransaction(transaction);
    }
  } catch (error) {
    const locked = error instanceof ReconciliationStoreError && error.code === "locked";
    reportInitOutcome(
      ctx,
      locked ? "blocked by a lock" : "failed",
      locked
        ? "Nothing was saved; another Bifrost writer holds the lock."
        : `The reviewed update to ${source.configPath} could not be confirmed.`,
      locked
        ? "Verify no other Bifrost writer is active and remove only exact stale lock files, then retry."
        : "Inspect the file and run /bifrost config reconcile --recover before retrying.",
      "error",
    );
    return;
  }

  // Auto-reload so the extension picks up the new config immediately.
  const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
  if (!installReloadedConfig(state, loadedConfig, ctx)) {
    reportInitOutcome(
      ctx,
      "failed",
      "The configuration was written but could not be reloaded.",
      "Fix the diagnostics above, then run /bifrost reload.",
      "error",
    );
    return;
  }
  const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
    enabled: state.config.enabled ?? true,
    pinned: false,
    classifierEnabled: state.config.classifier?.enabled ?? true,
    classifierSource: "configuration",
  });
  state.enabled = runtimeState.enabled;
  state.legacyClassifierEnabled = runtimeState.legacyClassifierEnabled;
  state.classifierRuntimeStateIssue = runtimeState.runtimeStateIssue;
  state.reliabilityStore.reload(state.config.reliability, process.cwd());
  state.classifierMetricsStore.reload({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(
      state.config,
      state.effectiveClassifierBackend(state.config).backend,
    ),
  });

  const tierCount = Object.keys(state.config.models ?? {}).length;
  const tiers = `${tierCount} tier${tierCount === 1 ? "" : "s"}`;
  reportInitOutcome(
    ctx,
    "saved",
    // Saving does not switch routing on: /bifrost off persists across reloads,
    // so report the state the user is actually in.
    state.enabled
      ? `Saved ${source.configPath} and reloaded. Bifrost is active with ${tiers}.`
      : `Saved ${source.configPath} and reloaded. Bifrost is configured with ${tiers}, but routing is off.`,
    state.enabled ? "Send a prompt to try it." : "Run /bifrost on to route prompts.",
    "success",
  );
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
  const observedTier =
    judgment?.backend === backend ? judgment.tier : increasedMetric(after.tiers, before.tiers);
  const observedConfidence =
    judgment?.backend === backend && judgment.confidence !== undefined
      ? String(judgment.confidence)
      : (increasedMetric(after.confidenceBands, before.confidenceBands) ?? "n/a");
  const rawPromptModel = classifier?.model;
  const configuredModel = Array.isArray(rawPromptModel)
    ? rawPromptModel.join(", ")
    : rawPromptModel;
  const model =
    judgment?.backend === backend
      ? judgment.model
      : backend === CLASSIFIER_BACKEND_IDS.typesafe
        ? (classifier?.typesafe?.model ?? TYPE_SAFE_MODEL)
        : backend === CLASSIFIER_BACKEND_IDS.piNative
          ? (classifier?.piNative?.model ?? "catalog default")
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
    `metric delta: +${Math.max(0, after.total - before.total)} observation(s)`,
    `classifier fallback: ${result.classifierAttempt?.fallbackKind ?? "none"}`,
  ];
  if (backend === CLASSIFIER_BACKEND_IDS.typesafe)
    lines.push(`credential: ${credential ?? "missing"}`);
  if (backend !== CLASSIFIER_BACKEND_IDS.prompt && after.total > before.total) {
    lines.push(`outcome: ${outcome ?? "recorded"}`);
  }
  lines.push("-----------------------");
  return lines;
}

async function handleClassifierTest(ctx: ExtensionContext, state: BifrostState): Promise<void> {
  const classifier = state.config.classifier;
  const enablement = classifierEnablementFor(state, ctx);
  if (enablement.runtimeStateIssue) {
    logImportant(
      ctx,
      "Classifier test blocked",
      "Runtime state is invalid. Repair .pi/bifrost-state.json, then run /bifrost reload.",
      "error",
    );
    return;
  }
  if (!enablement.enabled) {
    logImportant(
      ctx,
      "Classifier test unavailable",
      "Classifier is disabled; run /bifrost classifier on first.",
      "warning",
    );
    return;
  }
  const effective = state.effectiveClassifierBackend(state.config, ctx);
  const errors = classifierConfigErrors(state.config, effective.backend, true);
  if (errors.length > 0) {
    logImportant(ctx, "Classifier test blocked", errors.join(" "), "error");
    return;
  }
  const before = state.classifierMetricsStore.snapshot();
  clearBifrostWidgets(ctx);
  uiBusy(ctx, "Testing classifier backend...");
  const prompt = `Assess this small bounded request for tier selection. Verification nonce ${Date.now()}.`;
  let result;
  try {
    result = await state.classifyForSession(ctx, prompt, ctx.signal);
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  const after = state.classifierMetricsStore.snapshot();
  const credential =
    effective.backend === CLASSIFIER_BACKEND_IDS.typesafe
      ? resolveTypeSafeApiKey().source
      : undefined;
  await uiResult(
    ctx,
    "Classifier test",
    buildClassifierTestReport({
      classifier,
      result,
      before,
      after,
      credential,
      effectiveBackend: effective,
    }),
  );
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
    logImportant(
      ctx,
      "Benchmark unavailable",
      "No categories configured; run /bifrost init first.",
      "warning",
    );
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
    if (
      display.fallbackCandidateLines.length > 0 &&
      display.defaultTier &&
      display.defaultTier !== tierName
    ) {
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
  /** Present when the sign-in check is configured but unresolved in this session. */
  readonly signInNote?: string;
  readonly defaultTier?: string;
  readonly selected?: string;
  readonly fallbackBoundary?: "explicit";
  readonly attemptedTiers?: Array<{
    readonly tier: string;
    readonly strategy: string;
    readonly candidates: string[];
  }>;
};

/** No routing decision was made, so no routing field is reported. */
export type BifrostPreviewFailure = {
  readonly ok: false;
  readonly prompt: string;
  readonly error: "usage" | "unclassified" | "config_invalid";
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
export function parsePreviewArgs(
  args: string,
  sub: string,
): { prompt: string; json: boolean; trace?: true; offline?: true } {
  let rest = args.slice(sub.length).trim();
  let json = false;
  let trace = false;
  let offline = false;
  while (rest.startsWith("--json") || rest.startsWith("--trace") || rest.startsWith("--offline")) {
    const flag = /^(--json|--trace|--offline)(?=\s|$)/.exec(rest)?.[1];
    if (!flag) break;
    if (
      (flag === "--json" && json) ||
      (flag === "--trace" && trace) ||
      (flag === "--offline" && offline)
    )
      break;
    json ||= flag === "--json";
    trace ||= flag === "--trace";
    offline ||= flag === "--offline";
    rest = rest.slice(flag.length).trimStart();
  }
  const parsed = { prompt: rest.trim(), json };
  return {
    ...parsed,
    ...(trace ? { trace: true as const } : {}),
    ...(offline ? { offline: true as const } : {}),
  };
}

/** Build the failure half of the report. Pure: no classification, no display, no side effects. */
export function buildPreviewFailure(
  prompt: string,
  error: BifrostPreviewFailure["error"],
): BifrostPreviewFailure {
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
    ...(display.signInNote !== undefined ? { signInNote: display.signInNote } : {}),
    ...(display.defaultTier !== undefined ? { defaultTier: display.defaultTier } : {}),
    ...(display.selected !== undefined ? { selected: display.selected } : {}),
    ...(display.explicitBoundary
      ? {
          fallbackBoundary: "explicit" as const,
          attemptedTiers: display.attemptedTiers ?? [],
        }
      : {}),
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
    ...(trace.error ? [`error: ${trace.error}`] : []),
    `classification: ${trace.classification.source}${trace.classification.tier ? ` → ${trace.classification.tier}` : ""}`,
    `classifier disclosure: ${
      trace.classifierDisclosure.enabled
        ? "enabled; the configured classifier may receive the preview prompt"
        : "disabled; preview prompt is not sent to a classifier"
    }`,
  ];
  if (trace.classification.classifier) {
    lines.push(`classifier: ${trace.classification.classifier.backend}`);
    if (trace.classification.classifier.model !== undefined)
      lines.push(`classifier model: ${trace.classification.classifier.model}`);
    if (trace.classification.classifier.confidence !== undefined)
      lines.push(`classifier confidence: ${trace.classification.classifier.confidence}`);
  }
  const renderPool = (
    label: string,
    pool: RouteDecisionSummary["requested"] | RouteDecisionSummary["fallback"],
  ) => {
    if (!pool) return;
    lines.push(`${label}: ${pool.tier} (${pool.strategy})`);
    for (const candidate of pool.candidates) {
      const evidence = candidate.exclusionEvidence
        ?.map(({ code, source }) => `${code} from ${source}`)
        .join(", ");
      lines.push(
        `  ${candidate.status}: ${candidate.model}${candidate.exclusion ? ` (${candidate.exclusion})` : ""}${evidence ? `; evidence: ${evidence}` : ""}`,
      );
    }
    for (const entry of pool.unresolvedPatterns ?? []) {
      const evidence = entry.exclusionEvidence
        .map(({ code, source }) => `${code} from ${source}`)
        .join(", ");
      lines.push(`  excluded: ${entry.pattern} (${entry.exclusion}); evidence: ${evidence}`);
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
    lines.push(
      `affinity: ${trace.affinity.mode} (${trace.affinity.status}; source=${trace.affinity.modeSource ?? "config"}; selection=${trace.affinity.selection})`,
    );
    if (trace.affinity.status !== "not_applicable" && trace.affinity.anchor) {
      lines.push(
        `  anchor: ${trace.affinity.anchor.modelKey} at ${formatDiagnosticTimestamp(trace.affinity.anchor.lastSuccessfulDispatchAt)}`,
      );
    }
    if (trace.affinity.strategyWinner)
      lines.push(`  strategy winner: ${trace.affinity.strategyWinner}`);
    if (trace.affinity.selectedModel)
      lines.push(`  selected model: ${trace.affinity.selectedModel}`);
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
    ...(report.backend
      ? [
          `backend:   ${report.backend}`,
          `model:     ${report.model ?? "none"}`,
          `confidence:${report.confidence === undefined ? " n/a" : ` ${report.confidence}`}`,
        ]
      : []),
    `tier:      ${report.tier}`,
    `strategy:  ${report.strategy}`,
    `selected tier: ${report.selectedTier ?? PREVIEW_NONE}`,
    ...(report.fallbackReason ? [`fallback:  ${report.fallbackReason}`] : []),
    ...(report.signInNote ? [`sign-in:  ${report.signInNote}`] : []),
    `requested candidates (${report.tier}):`,
    ...report.requestedCandidates,
    ...(report.fallbackCandidates.length > 0 &&
    report.defaultTier &&
    report.defaultTier !== report.tier
      ? [`fallback candidates (${report.defaultTier}):`, ...report.fallbackCandidates]
      : []),
    ...(report.fallbackBoundary === "explicit"
      ? [
          "fallback boundary: explicit",
          ...(report.attemptedTiers ?? []).flatMap((attempt, index) => [
            `attempt ${index + 1} (${attempt.tier}, ${attempt.strategy}):`,
            ...attempt.candidates.map((candidate) => `  ${candidate}`),
          ]),
        ]
      : []),
    `selected:  ${report.selected ?? PREVIEW_NONE}`,
    "---------------",
  ];
}

/** Write the one machine-readable line for a preview, successful or not. */
function emitPreviewReport(report: BifrostPreviewReport): void {
  console.error(`${BIFROST_JSON_PREFIX}${serializePreviewReport(report)}`);
}

function hasInvalidRoutingConfig(
  state: Pick<
    BifrostState,
    "tierPolicyValid" | "economicPolicyValid" | "reliabilityV2ConfigValid" | "affinityConfigValid"
  >,
): boolean {
  return (
    state.tierPolicyValid === false ||
    state.economicPolicyValid === false ||
    state.reliabilityV2ConfigValid === false ||
    state.affinityConfigValid === false
  );
}

async function handlePreview(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const { prompt, json, trace, offline } = parsePreviewArgs(args, PREVIEW_SUB);
  const classifierEnabled = classifierEnablementFor(state, ctx).enabled;
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
      console.error(
        `${BIFROST_JSON_PREFIX}${JSON.stringify(buildTracePreview(summary, classifierEnabled && !offline))}`,
      );
    } else if (json) emitPreviewReport(buildPreviewFailure(prompt, "usage"));
    log(
      ctx,
      json
        ? `usage: /bifrost preview ${offline ? "--offline " : ""}${trace ? "--trace " : ""}--json <prompt>`
        : `usage: /bifrost preview ${offline ? "--offline " : ""}${trace ? "--trace " : ""}<prompt>`,
      "warning",
    );
    return;
  }

  clearBifrostWidgets(ctx);
  if (hasInvalidRoutingConfig(state)) {
    if (trace) {
      const summary: RouteDecisionSummary = {
        version: 1,
        kind: "route-decision",
        outcome: "config_invalid",
        error: "config_invalid",
        classification: { source: "unclassified" },
      };
      const report = buildTracePreview(summary, false);
      if (json) console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
      else await uiResult(ctx, "Bifrost route trace", renderTracePreview(report));
    } else if (json) emitPreviewReport(buildPreviewFailure(prompt, "config_invalid"));
    logImportant(
      ctx,
      "Preview unavailable",
      "A configuration source is invalid. Run /bifrost validate and repair the reported source.",
      "error",
    );
    return;
  }
  if (trace && classifierEnabled && !offline) {
    logImportant(
      ctx,
      "Classifier privacy",
      "Preview may send the prompt to the configured classifier.",
      "warning",
    );
  }
  setBifrostStatus(ctx, "previewing prompt...", "accent");
  uiBusy(ctx, "Classifying preview prompt...");
  let classification;
  try {
    classification = await state.classifyForSession(ctx, prompt, ctx.signal, { offline });
  } finally {
    uiDone(ctx);
    syncBifrostModeStatus(ctx, state);
  }
  if (classification.kind === "unclassified") {
    if (trace) {
      const summary = buildRouteDecisionSummary(classification);
      const report = buildTracePreview(summary, classifierEnabled && !offline);
      if (json) console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
      else await uiResult(ctx, "Bifrost route trace", renderTracePreview(report));
      return;
    }
    if (json) emitPreviewReport(buildPreviewFailure(prompt, "unclassified"));
    logImportant(ctx, "No route matched", "No configured tier matched the prompt.", "warning");
    return;
  }

  const display = resolveTierDisplay(
    classification.tier,
    state,
    ctx,
    classification.kind === "classified" && classification.source === "inline"
      ? "explicit_tier"
      : "automatic",
  );
  if (trace) {
    const options = buildTierResolutionOptions(classification.tier, state.config);
    const summary = buildRouteDecisionSummary(classification, {
      resolution: display.resolution,
      options,
    });
    const report = buildTracePreview(summary, classifierEnabled && !offline);
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
  {
    value: "on",
    description: "Enable routing",
    reflects: { state: "enabled", sets: true, note: "already on" },
  },
  {
    value: "off",
    description: "Disable routing",
    reflects: { state: "enabled", sets: false, note: "already off" },
  },
  {
    value: "pin",
    description: "Lock current model",
    reflects: { state: "pinned", sets: true, note: "already pinned" },
  },
  {
    value: "unpin",
    description: "Resume routing",
    reflects: { state: "pinned", sets: false, note: "already unpinned" },
  },
  // Common commands, in menu order. The two prompt commands lead because both
  // prefill the editor rather than run: keep them adjacent.
  {
    value: PREVIEW_SUB,
    description: "Preview routing for a prompt",
    argumentHint: `[--offline] [--trace] [--json] <prompt>`,
    menu: "common",
  },
  {
    value: "benchmark",
    description: "Classify a benchmark prompt",
    argumentHint: "<prompt>",
    menu: "common",
  },
  { value: "providers", description: "List available providers", menu: "common" },
  { value: "probe", description: "Probe working models", menu: "common" },
  {
    value: "init",
    description: "Refresh model catalog and save setup (pass -f to probe)",
    aliases: ["init -f"],
    menu: "common",
  },
  { value: "classifier status", description: "Show classifier state", menu: "common" },
  { value: "reload", description: "Reload config after editing", menu: "common" },
  {
    value: "validate",
    description: "Validate loaded config and model references",
    argumentHint: "[--json]",
    menu: "common",
  },
  {
    value: "inspect",
    description: "Inspect configured models and local health",
    argumentHint: "[--json]",
    menu: "common",
  },
  {
    value: "config reconcile",
    description: "Preview or apply exact generated model membership",
    argumentHint: "[flags]",
  },
  {
    value: "config migrate",
    description: "Preview or apply an explicit schema migration",
    argumentHint: "[--source project|workspace|user] [--apply --proposal <digest>]",
  },
  { value: "reliability", description: "Show provider cooldowns" },
  {
    value: "reliability reset",
    description: "Clear one provider cooldown",
    argumentHint: "--provider <provider-id>",
  },
  {
    value: "reliability migrate",
    description: "Prepare receipt-owned reliability v2",
    argumentHint: "[--fresh]",
  },
  // Everything else, in declaration order.
  { value: "cache stats", description: "Show classification cache" },
  { value: "cost", description: "Show recorded session usage and cost estimate" },
  // Reachable from the dashboard now that the menu is derived from the
  // registry, and still unconfirmed: this writes the cache file immediately.
  // docs/ui-enhancements.md lists "Destructive confirmation - Confirm cache
  // clear/config overwrite/long probe" as a Next item. Deliberately left as is
  // here; confirmation is a separate behavior change.
  { value: "cache clear", description: "Clear classification cache" },
  { value: "classifier", description: "Choose classifier backend" },
  { value: "classifier on", description: "Enable LLM classifier for this session" },
  { value: "classifier off", description: "Disable LLM classifier for this session" },
  { value: "classifier inherit", description: "Clear this session's classifier override" },
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
  const items = entries
    .filter((entry) => entry.value.startsWith(normalized))
    .map((entry) => ({
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

function parseDiagnosticJsonFlag(
  args: string,
  command: "validate" | "inspect",
): boolean | undefined {
  const rest = args.slice(command.length).trim();
  if (!rest) return false;
  if (rest === "--json") return true;
  return undefined;
}

async function handleReliabilityCommand(
  args: string,
  ctx: ExtensionContext,
  state: BifrostState,
): Promise<void> {
  const rest = args.trim().slice("reliability".length).trim();
  if (!rest) {
    try {
      const store =
        state.providerCooldownStore ??
        createProviderCooldownStore(process.cwd(), state.config.reliability);
      const paused = store.list();
      if (paused.length === 0) {
        logImportant(
          ctx,
          "No cooldowns active",
          "No provider cooldowns or recovery trials are active.",
          "info",
        );
        return;
      }
      log(
        ctx,
        [
          "Provider cooldowns:",
          ...paused.map(
            (item) =>
              `  ${item.providerId}: ${item.openUntil === undefined ? "cooldown expired" : `paused until ${new Date(item.openUntil).toISOString()}`}${item.trialActive ? "; recovery trial active" : item.recoveryPending ? "; recovery trial available" : ""}`,
          ),
        ].join("\n"),
      );
    } catch {
      logImportant(
        ctx,
        "Cooldown state unavailable",
        "Provider cooldown state is invalid or unavailable; inspect .pi/bifrost-provider-reliability.json.",
        "error",
      );
    }
    return;
  }
  if (rest.startsWith("reset ")) {
    const match = /^reset\s+--provider\s+([A-Za-z0-9][A-Za-z0-9._:+@-]{0,200})$/u.exec(rest);
    if (!match) {
      log(ctx, "usage: /bifrost reliability reset --provider <provider-id>", "warning");
      return;
    }
    const providerId = match[1]!;
    let knownProviders = new Set<string>();
    try {
      for (const model of ctx.modelRegistry.getAll()) knownProviders.add(model.provider);
    } catch {
      /* configured provider IDs remain available below */
    }
    for (const tiers of Object.values(state.config.models ?? {})) {
      for (const key of tiers ?? []) knownProviders.add(key.slice(0, key.indexOf("/")));
    }
    if (state.config.default) {
      for (const key of state.config.models?.[state.config.default] ?? [])
        knownProviders.add(key.slice(0, key.indexOf("/")));
    }
    try {
      providerScopeModelKey("usage", providerId);
    } catch {
      logImportant(
        ctx,
        "Provider reset blocked",
        "Provider ID is outside the supported reliability namespace.",
        "warning",
      );
      return;
    }
    let store: ProviderCooldownStore;
    try {
      store =
        state.providerCooldownStore ??
        createProviderCooldownStore(process.cwd(), state.config.reliability);
      if (
        !knownProviders.has(providerId) &&
        !store.list().some((item) => item.providerId === providerId)
      ) {
        logImportant(
          ctx,
          "Provider reset skipped",
          `${providerId} is not configured or present in cooldown state. Nothing was reset.`,
          "warning",
        );
        return;
      }
      const result = await store.reset(providerId);
      logImportant(
        ctx,
        result === "reset" ? "Provider cooldown reset" : "Provider reset skipped",
        result === "trial_active"
          ? `${providerId} has an active recovery trial; cooldown reset was stopped.`
          : result === "reset"
            ? `${providerId} cooldown was reset.`
            : `${providerId} has no active cooldown.`,
        result === "reset" ? "success" : "info",
      );
    } catch {
      logImportant(
        ctx,
        "Provider reset failed",
        `${providerId} cooldown could not be reset; provider state was left unchanged.`,
        "error",
      );
    }
    return;
  }
  if (rest !== "migrate" && rest !== "migrate --fresh") {
    log(
      ctx,
      "usage: /bifrost reliability [reset --provider <provider-id> | migrate [--fresh]]",
      "warning",
    );
    return;
  }
  const stateVersion = state.config.reliability?.stateVersion;
  const reliabilityConfigErrors = validateConfig(state.config).filter(
    (issue) => issue.severity === "error" && issue.code?.startsWith("config.reliability_"),
  );
  if (
    reliabilityConfigErrors.length > 0 ||
    !state.reliabilityV2ConfigValid ||
    (stateVersion === 2 && !schemaVersionAtLeast(state.config.schemaVersion, 2))
  ) {
    logImportant(
      ctx,
      "Reliability migration blocked",
      "Repair the reliability settings and validate the config before preparing the v2 sidecar.",
      "error",
    );
    return;
  }
  let store: ReliabilityV2Store;
  try {
    store = createReliabilityV2Store(process.cwd(), state.config.reliability);
  } catch {
    logImportant(
      ctx,
      "Reliability migration blocked",
      "Could not prepare a safe sidecar location. No files were changed.",
      "error",
    );
    return;
  }
  try {
    store.readSnapshot();
    if (stateVersion === 2) state.reliabilityV2Store = store;
    logImportant(
      ctx,
      "Reliability migration skipped",
      "Reliability v2 sidecar already exists and was left unchanged.",
      "info",
    );
    return;
  } catch (error) {
    if (!(error instanceof ReliabilityV2StoreError) || error.code !== "uninitialized_state") {
      logImportant(
        ctx,
        "Reliability migration blocked",
        "An existing v2 sidecar is invalid or unsafe; repair it explicitly before migration.",
        "error",
      );
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
    logImportant(
      ctx,
      result.status === "seeded"
        ? "Reliability v2 sidecar initialized"
        : "Reliability migration skipped",
      result.status === "seeded"
        ? "Auto routing can now use receipt-owned circuit trials; model selection was not changed."
        : "Reliability v2 sidecar already exists and was left unchanged.",
      result.status === "seeded" ? "success" : "info",
    );
  } catch (error) {
    const code = error instanceof ReliabilityV2StoreError ? error.code : "migration_failed";
    logImportant(
      ctx,
      "Reliability migration failed",
      code === "source_lock_contended"
        ? "The v1 source lock is busy. Existing state and backup were left untouched; no v2 state was committed."
        : code === "source_missing"
          ? "No v1 reliability file exists; pass --fresh only if you intend to initialize an empty v2 sidecar."
          : code === "source_exists"
            ? "--fresh is allowed only when no v1 reliability file exists; existing v1 state was left unchanged."
            : code === "source_changed"
              ? "The v1 source changed during migration. No v2 state was committed; review the source and retry."
              : `Migration stopped safely (${code}); existing files were preserved.`,
      "error",
    );
  }
}

const MAX_RELIABILITY_MIGRATION_SOURCE_BYTES = 16 * 1024 * 1024;

function readBoundedRegularSnapshot(path: string): Buffer | undefined {
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error("unsafe source");
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("unsafe source");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino ||
      before.size > MAX_RELIABILITY_MIGRATION_SOURCE_BYTES
    )
      throw new Error("unsafe source");
    const bytes = Buffer.alloc(MAX_RELIABILITY_MIGRATION_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_RELIABILITY_MIGRATION_SOURCE_BYTES) throw new Error("source too large");
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      offset !== before.size
    ) {
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
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: string;
    readonly source?: string;
    readonly scope?: string;
  }[];
}

interface ReliabilityV2InspectEvidence {
  readonly version: 2;
  readonly status: "initialized" | "unavailable";
  readonly revision?: number;
  readonly observationsEnabled: boolean;
  readonly cooldownOnAllowanceExhausted: boolean;
  readonly scopes?: readonly {
    readonly model: string;
    readonly generation: number;
    readonly recentFailureCount: number;
    readonly openUntil?: number;
  }[];
  readonly observations?: readonly {
    readonly model: string;
    readonly category: string;
    readonly categoryEvidence: string;
    readonly observedAt: number;
    readonly retryAt?: number;
    readonly source: string;
  }[];
  readonly observationCount?: number;
  readonly reasonCode?: string;
}

function inspectReliabilityV2(state: BifrostState): ReliabilityV2InspectEvidence | undefined {
  if (state.config.reliability?.stateVersion !== 2) return undefined;
  const observationsEnabled = state.config.reliability.observations?.enabled === true;
  try {
    if (!state.reliabilityV2Store)
      throw new ReliabilityV2StoreError("uninitialized_state", "unavailable");
    const snapshot = state.reliabilityV2Store.readSnapshot();
    const projected = Object.entries(snapshot.scopes).flatMap(([scopeKey, scope]) => {
      const match = /^model:(\d+):(.+)$/.exec(scopeKey);
      const model = match && Number(match[1]) === match[2]!.length ? match[2] : undefined;
      return model
        ? [
            {
              model,
              generation: scope.generation,
              recentFailureCount: scope.failures.length,
              ...(scope.openUntil === undefined ? {} : { openUntil: scope.openUntil }),
            },
          ]
        : [];
    });
    const observations = Object.values(snapshot.settledOutcomes).flatMap((outcome) =>
      outcome.observation
        ? [
            {
              model: outcome.observation.modelKey,
              category: outcome.observation.category,
              categoryEvidence: outcome.observation.categoryEvidence,
              observedAt: outcome.observation.observedAt,
              ...(outcome.observation.retryAt === undefined
                ? {}
                : { retryAt: outcome.observation.retryAt }),
              source: outcome.observation.source,
            },
          ]
        : [],
    );
    return {
      version: 2,
      status: "initialized",
      revision: snapshot.revision,
      observationsEnabled,
      cooldownOnAllowanceExhausted: state.config.reliability?.cooldownOnAllowanceExhausted ?? true,
      scopes: projected.slice(0, 200),
      observations: observations.slice(0, 200),
      observationCount: observations.length,
    };
  } catch (error) {
    const code = error instanceof ReliabilityV2StoreError ? error.code : "state_unavailable";
    return {
      version: 2,
      status: "unavailable",
      observationsEnabled,
      cooldownOnAllowanceExhausted: state.config.reliability?.cooldownOnAllowanceExhausted ?? true,
      reasonCode: code,
    };
  }
}

function inspectEconomicEvidence(state: BifrostState, now = Date.now()): EconomicInspectEvidence {
  if (state.economicPolicyValid === false) return { mode: "invalid", sources: [], diagnostics: [] };
  if (!state.config.economics) return { mode: "off", sources: [], diagnostics: [] };
  const policy = state.economicPolicy;
  if (!policy) return { mode: "off", sources: [], diagnostics: [] };
  const signals = state.economicSnapshot?.signals ?? [];
  const sources = policy.sources.map((source) => {
    const signal = signals.find(
      (item) => item.sourceId === source.id && item.scopeRef === source.scopeRef,
    );
    const freshness = !signal
      ? ("missing" as const)
      : now < signal.observedAt
        ? ("future" as const)
        : signal.expiresAt <= now
          ? ("expired" as const)
          : ("current" as const);
    const periods = signal
      ? signal.windows.map((window) => ({
          window: window.id,
          period: window.period.id,
          unit: window.unit,
          applicability:
            now < signal.observedAt
              ? ("future" as const)
              : signal.expiresAt <= now
                ? ("expired" as const)
                : window.resetsAt !== undefined && window.resetsAt <= now
                  ? ("reset" as const)
                  : ("current" as const),
        }))
      : [];
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
  const location = [
    fieldPath,
    item.tier ? `tier=${item.tier}` : "",
    item.entryIndex !== undefined ? `entry=${item.entryIndex}` : "",
    item.ruleIndex !== undefined ? `rule=${item.ruleIndex}` : "",
    item.model ? `model=${item.model}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `  ${item.severity} ${item.code}${location ? ` (${location})` : ""}: ${item.repair}`;
}

function formatDiagnosticTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function classifierConflictNote(
  conflict: { readonly saved: boolean; readonly configured: boolean },
  source: string,
): string {
  if (source === "session") return "explicit session-only override is active";
  if (!conflict.configured && conflict.saved)
    return "configured off takes precedence; /bifrost classifier on overrides only this session";
  return "classification paused. /bifrost classifier on or off affects only this session. To resume configured behavior after restart, back up .pi/bifrost-state.json, remove only classifierEnabled, then run /bifrost reload";
}

function renderDiagnosticLines(
  report:
    | ValidateDiagnosticsReport
    | (InspectDiagnosticsReport & {
        economics?: EconomicInspectEvidence;
        reliabilityV2?: ReliabilityV2InspectEvidence;
        affinity?: AffinityInspectEvidence;
      }),
): string[] {
  const lines = [
    report.kind === "validation"
      ? "--- validation (loaded effective config) ---"
      : "--- inspection (local snapshot) ---",
  ];
  if (report.kind === "validation") {
    lines.push("config source: loaded effective config (run /bifrost reload after editing files)");
  }
  lines.push(
    `classifier runtime: ${report.classifier.enabled ? "enabled" : "disabled"} (${report.classifier.source}); configured=${report.classifier.configuredEnabled ? "on" : "off"}; readiness=${report.classifier.readiness}${report.classifier.backend ? `; backend=${report.classifier.backend}` : ""}`,
  );
  if (report.classifier.legacyConflict)
    lines.push(
      `classifier conflict: saved=${report.classifier.legacyConflict.saved}, configured=${report.classifier.legacyConflict.configured}; ${classifierConflictNote(report.classifier.legacyConflict, report.classifier.source)}`,
    );
  if (report.classifier.runtimeStateIssue)
    lines.push(
      `classifier runtime state: invalid (${report.classifier.runtimeStateIssue}); classification is paused by default. Repair .pi/bifrost-state.json: it must be a JSON object, and enabled and classifierEnabled must be booleans if present. Then run /bifrost reload.`,
    );
  for (const error of report.classifier.errors) lines.push(`classifier error: ${error}`);
  if (report.kind === "inspection") {
    lines.push(`observed: ${formatDiagnosticTimestamp(report.observedAt)}`);
    lines.push(
      `registry: ${report.registry.knownModelCount} known, ${report.registry.availableModelCount} available`,
    );
    lines.push(
      `reliability policy: ${report.reliabilityPolicy.enabled ? "enabled" : "disabled"}; usage/billing cooldown=${report.reliabilityPolicy.cooldownOnAllowanceExhausted ? "on" : "off"} (${report.reliabilityPolicy.allowanceCooldownScope} scope); provider rate-limit throttles=on`,
    );
    if (report.registry.bifrostLastRefreshAgeMs !== undefined) {
      lines.push(
        `Bifrost last registry refresh age: ${report.registry.bifrostLastRefreshAgeMs} ms`,
      );
    }
    for (const tier of report.tiers) {
      lines.push(`${tier.tier}: ${tier.configuredEntryCount} configured entries`);
      for (const candidate of tier.candidates) {
        const failure = candidate.failureEvidence
          ? `, lastFailure=${candidate.failureEvidence.category}, evidence=${candidate.failureEvidence.evidence}, scope=${candidate.failureEvidence.scope}`
          : "";
        lines.push(
          `  ${candidate.model}: available=${candidate.available}, auth=${candidate.auth}, circuit=${candidate.circuit}${candidate.openUntil === undefined ? "" : ` until ${formatDiagnosticTimestamp(candidate.openUntil)}`}${failure}`,
        );
      }
    }
    if (report.economics) {
      lines.push(`reserve policy: ${report.economics.mode}`);
      for (const source of report.economics.sources) {
        const age = source.observedAgeMs === undefined ? "" : ` age=${source.observedAgeMs}ms`;
        const periods =
          source.periods
            .map((period) => `${period.window}:${period.period}(${period.applicability})`)
            .join(", ") || "none";
        lines.push(
          `  source=${source.source} scope=${source.scope} authority=${source.authority} freshness=${source.freshness}${age} periods=${periods}`,
        );
      }
      for (const diagnostic of report.economics.diagnostics) {
        lines.push(
          `  ${diagnostic.severity} ${diagnostic.code}${diagnostic.source ? ` source=${diagnostic.source}` : ""}${diagnostic.scope ? ` scope=${diagnostic.scope}` : ""}`,
        );
      }
    }
    if (report.reliabilityV2) {
      const reliability = report.reliabilityV2;
      lines.push(
        `reliability v2: ${reliability.status}${reliability.revision === undefined ? "" : ` revision=${reliability.revision}`} observations=${reliability.observationsEnabled ? "on" : "off"} allowanceCooldown=${reliability.cooldownOnAllowanceExhausted ? "on" : "off"}`,
      );
      if (reliability.reasonCode) lines.push(`  reason=${reliability.reasonCode}`);
      for (const scope of reliability.scopes ?? []) {
        lines.push(
          `  model=${scope.model} generation=${scope.generation} recentFailures=${scope.recentFailureCount}${scope.openUntil === undefined ? "" : ` openUntil=${formatDiagnosticTimestamp(scope.openUntil)}`}`,
        );
      }
      for (const observation of reliability.observations ?? []) {
        lines.push(
          `  observation model=${observation.model} category=${observation.category} evidence=${observation.categoryEvidence} at=${formatDiagnosticTimestamp(observation.observedAt)}${observation.retryAt === undefined ? "" : ` retryAt=${formatDiagnosticTimestamp(observation.retryAt)}`} source=${observation.source}`,
        );
      }
      if ((reliability.observationCount ?? 0) > 200)
        lines.push(`  ... ${reliability.observationCount! - 200} more observations`);
    }
    if (report.affinity) {
      lines.push(
        `affinity: ${report.affinity.mode} (${report.affinity.status}; source=${report.affinity.source})`,
      );
      if (report.affinity.anchor) {
        lines.push(
          `  last successful model=${report.affinity.anchor.model} provider=${report.affinity.anchor.provider} at=${report.affinity.anchor.lastSuccessfulAt} age=${report.affinity.anchor.ageMs}ms`,
        );
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
  if (
    v2Evidence?.status === "initialized" &&
    state.reliabilityV2Store &&
    state.config.reliability
  ) {
    try {
      reliabilityState = projectReliabilityV2ForRouting(
        state.reliabilityV2Store.readSnapshot(),
        reliabilityV2Config(state.config.reliability),
        Date.now(),
      );
    } catch {
      /* unavailable evidence is reported separately; do not fabricate a health snapshot */
    }
  }
  if (
    command === "inspect" &&
    state.enabled &&
    state.config.reliability?.enabled !== false &&
    state.providerCooldownStore
  ) {
    try {
      const registryModels =
        typeof ctx.modelRegistry.getAll === "function"
          ? ctx.modelRegistry.getAll()
          : ctx.modelRegistry.getAvailable();
      reliabilityState = projectProviderCooldownsForRouting(
        reliabilityState,
        state.providerCooldownStore,
        registryModels,
        state.config.reliability?.cooldownOnAllowanceExhausted !== false &&
          state.config.reliability?.allowanceCooldownScope !== "model",
      );
    } catch {
      /* provider state is local-only; an unreadable sidecar adds no health evidence */
    }
  }
  const affinityEvidence = command === "inspect" ? inspectAffinity(state, ctx) : undefined;
  const classifierRuntime = classifierEnablementFor(state, ctx);
  const report =
    command === "validate"
      ? validateDiagnostics({
          config: state.config,
          registry: ctx.modelRegistry,
          effectiveClassifierBackend: state.effectiveClassifierBackend(state.config, ctx).backend,
          classifierEnabled: classifierRuntime.enabled,
          classifierEnablementSource: classifierRuntime.source,
          ...(classifierRuntime.legacyConflict
            ? { classifierConflict: classifierRuntime.legacyConflict }
            : {}),
          ...(classifierRuntime.runtimeStateIssue
            ? { classifierRuntimeStateIssue: classifierRuntime.runtimeStateIssue }
            : {}),
        })
      : {
          ...inspectDiagnostics({
            config: state.config,
            registry: ctx.modelRegistry,
            reliabilityState,
            reliabilityConfig: state.config.reliability,
            lastRegistryRefreshAt: state.lastRegistryRefreshAt,
            classifierEnabled: classifierRuntime.enabled,
            classifierEnablementSource: classifierRuntime.source,
            effectiveClassifierBackend: state.effectiveClassifierBackend(state.config, ctx).backend,
            ...(classifierRuntime.legacyConflict
              ? { classifierConflict: classifierRuntime.legacyConflict }
              : {}),
            ...(classifierRuntime.runtimeStateIssue
              ? { classifierRuntimeStateIssue: classifierRuntime.runtimeStateIssue }
              : {}),
          }),
          economics: inspectEconomicEvidence(state),
          ...(affinityEvidence ? { affinity: affinityEvidence } : {}),
          ...(v2Evidence ? { reliabilityV2: v2Evidence } : {}),
          modelPoolSource: state.bootstrapModelsInMemory
            ? "session_catalog_in_memory"
            : "configured",
        };
  if (json) {
    console.error(`${BIFROST_JSON_PREFIX}${JSON.stringify(report)}`);
    return;
  }
  const lines = renderDiagnosticLines(report);
  if (command === "inspect")
    lines.splice(
      -1,
      0,
      `model pool source: ${state.bootstrapModelsInMemory ? "Pi catalog (in memory; run /bifrost init to refresh and save)" : "configuration"}`,
    );
  await uiResult(ctx, `Bifrost ${command}`, lines);
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
  const reflectedStates = BIFROST_COMMAND_OPTIONS.map((spec) => spec.reflects?.state).filter(
    (reflects): reflects is ReflectedState => Boolean(reflects),
  );
  // Groups follow the order the registry first mentions them, so the pair order
  // is registry order too and needs no second list.
  const groupOf = (reflects: ReflectedState): number => reflectedStates.indexOf(reflects);
  const tierOf = (spec: CommandSpec): number =>
    spec.reflects ? 0 : spec.menu === "common" ? 1 : 2;

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
  choice: {
    backend: ClassifierBackend;
    promptModel?: string | null;
    piNativeModel?: string | null;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, backend: choice.backend };
  if (choice.backend === CLASSIFIER_BACKEND_IDS.prompt) {
    if (choice.promptModel === null) delete next.model;
    else if (choice.promptModel !== undefined) next.model = choice.promptModel;
    return next;
  }
  for (const field of PROMPT_ONLY_FIELDS) delete next[field];
  if (choice.backend === CLASSIFIER_BACKEND_IDS.typesafe) {
    const existing =
      next.typesafe && typeof next.typesafe === "object" && !Array.isArray(next.typesafe)
        ? (next.typesafe as Record<string, unknown>)
        : {};
    next.typesafe = { ...existing, model: TYPE_SAFE_MODEL };
  } else {
    const existing =
      next.piNative && typeof next.piNative === "object" && !Array.isArray(next.piNative)
        ? (next.piNative as Record<string, unknown>)
        : {};
    const piNative = { ...existing };
    if (choice.piNativeModel === null) delete piNative.model;
    else if (choice.piNativeModel !== undefined) piNative.model = choice.piNativeModel;
    next.piNative = piNative;
  }
  next.criteria ??= DEFAULT_CLASSIFIER_CRITERIA;
  next.fallback ??= next.model ? "prompt" : "regex";
  return next;
}

function persistBootstrapConfig(
  ctx: ExtensionContext,
  state: BifrostState,
  sourceAtStart: ReconciliationSourceSnapshot,
  classifierChoice?: {
    backend: ClassifierBackend;
    promptModel?: string | null;
    piNativeModel?: string | null;
  },
  configGenerationAtStart = state.configGeneration ?? 0,
): boolean {
  if (!state.bootstrapModelsInMemory) return true;
  let source: ReconciliationSourceSnapshot;
  try {
    source = selectInitSource();
  } catch {
    logImportant(
      ctx,
      "Classifier update blocked",
      "A config source is invalid. No files were changed.",
      "error",
    );
    return false;
  }
  const userFiles = hasUserBootstrapFiles(
    process.cwd(),
    getAgentDir(),
    CONFIG_DIR_NAME,
    join(state.extensionDir, "bifrost.json"),
  );
  const isEmptyConfig = (bytes: Uint8Array | null): boolean => {
    if (!bytes) return false;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return Boolean(
        parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.getPrototypeOf(parsed) === Object.prototype &&
          Object.keys(parsed).length === 0,
      );
    } catch {
      return false;
    }
  };
  const freshEmptyConfig =
    isEmptyConfig(sourceAtStart.configBytes) &&
    isEmptyConfig(source.configBytes) &&
    Buffer.from(sourceAtStart.configBytes!).equals(Buffer.from(source.configBytes!));
  const stillFresh =
    ((sourceAtStart.configBytes === null && source.configBytes === null) || freshEmptyConfig) &&
    sourceAtStart.ownershipBytes === null &&
    source.ownershipBytes === null &&
    sourceAtStart.source === source.source &&
    state.bootstrapModelsInMemory &&
    (state.configGeneration ?? 0) === configGenerationAtStart &&
    !userFiles.userConfig &&
    !userFiles.routeFile &&
    !hasExplicitExtensionRoutingFile(join(state.extensionDir, "bifrost.json"));
  if (!stillFresh && !classifierChoice) {
    state.bootstrapModelsInMemory = false;
    return true;
  }
  let current: Record<string, unknown> = {};
  if (source.configBytes !== null) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(source.configBytes).toString("utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype
      )
        throw new Error("invalid config object");
      current = parsed as Record<string, unknown>;
    } catch {
      logImportant(
        ctx,
        "Classifier update blocked",
        "The selected config is invalid JSON. No files were changed.",
        "error",
      );
      return false;
    }
  } else if (source.ownershipBytes !== null) {
    logImportant(
      ctx,
      "Classifier update blocked",
      "An ownership receipt exists without its config. No files were changed.",
      "error",
    );
    return false;
  }
  const currentClassifier =
    current.classifier &&
    typeof current.classifier === "object" &&
    !Array.isArray(current.classifier)
      ? (current.classifier as Record<string, unknown>)
      : source.configBytes === null && state.config.classifier
        ? (state.config.classifier as unknown as Record<string, unknown>)
        : {};
  if (classifierChoice)
    current.classifier = nextClassifierConfig(currentClassifier, classifierChoice);
  const generatedModels = Object.fromEntries(
    Object.entries(state.config.models ?? {}).map(([tier, pool]) => [
      tier,
      typeof pool === "string" ? [pool] : pool,
    ]),
  ) as Record<string, readonly string[]>;
  if (stillFresh) {
    const generatedDefault = state.config.default;
    if (!generatedDefault || Object.keys(generatedModels).length === 0) {
      if (!classifierChoice) {
        state.bootstrapModelsInMemory = false;
        return true;
      }
    } else {
      const receipt = buildInitOwnershipReceipt("project", generatedModels);
      if (!receipt) {
        logImportant(
          ctx,
          "Starter setup blocked",
          "Could not safely save generated model pools and default. No files were changed.",
          "error",
        );
        return false;
      }
      current.models = generatedModels;
      current.default = generatedDefault;
    }
  }
  if (!stillFresh && source.configBytes === null && !classifierChoice) {
    state.bootstrapModelsInMemory = false;
    return true;
  }
  const configBytes = Buffer.from(JSON.stringify(current, null, 2) + "\n", "utf8");
  const ownership = stillFresh
    ? buildInitOwnershipReceipt("project", generatedModels)
    : source.ownershipBytes
      ? undefined
      : buildInitOwnershipReceipt("project", {});
  const ownershipBytes = ownership
    ? Buffer.from(JSON.stringify(ownership, null, 2) + "\n", "utf8")
    : source.ownershipBytes
      ? Buffer.from(source.ownershipBytes)
      : undefined;
  if (
    !ownershipBytes ||
    configBytes.byteLength > MAX_CONFIG_SOURCE_BYTES ||
    ownershipBytes.byteLength > MAX_RECONCILIATION_OWNERSHIP_BYTES ||
    !prospectiveConfigInstallable(source.source, configBytes, state)
  ) {
    logImportant(
      ctx,
      "Classifier update blocked",
      "The requested config is invalid or exceeds the safe write limit. No files were changed.",
      "error",
    );
    return false;
  }
  const expectedConfigDigest = source.configBytes
    ? createHash("sha256").update(source.configBytes).digest("hex")
    : null;
  const expectedOwnershipDigest = source.ownershipBytes
    ? createHash("sha256").update(source.ownershipBytes).digest("hex")
    : null;
  const targetDirectory = dirname(source.configPath);
  if (!existsSync(targetDirectory)) mkdirSync(targetDirectory, { recursive: true });
  const ownershipDirectory = dirname(source.ownershipPath);
  if (!existsSync(ownershipDirectory)) mkdirSync(ownershipDirectory, { recursive: true });
  try {
    applyReconciliationTransaction({
      configPath: source.configPath,
      ownershipPath: source.ownershipPath,
      journalPath: source.journalPath,
      expectedConfigDigest,
      expectedOwnershipDigest,
      nextConfigBytes: configBytes,
      nextOwnershipBytes: ownershipBytes,
    });
  } catch {
    logImportant(
      ctx,
      "Classifier update failed",
      "Could not safely save the classifier and starter model setup. Existing files were preserved.",
      "error",
    );
    return false;
  }
  state.bootstrapModelsInMemory = false;
  if (stillFresh)
    logImportant(
      ctx,
      "Starter models saved",
      "Detected model pools were saved with your classifier choice.",
      "success",
    );
  return true;
}

async function handleClassifierChoose(ctx: ExtensionContext, state: BifrostState): Promise<void> {
  if (!ctx.hasUI) {
    logImportant(
      ctx,
      "Classifier selection unavailable",
      "Choose classifier backend in Pi UI: prompt, typesafe, or pi-native.",
      "warning",
    );
    return;
  }
  let bootstrapSourceAtStart: ReconciliationSourceSnapshot | undefined;
  const configGenerationAtStart = state.configGeneration ?? 0;
  if (state.bootstrapModelsInMemory) {
    try {
      bootstrapSourceAtStart = selectInitSource();
    } catch {
      logImportant(
        ctx,
        "Classifier update blocked",
        "A config source is invalid. No files were changed.",
        "error",
      );
      return;
    }
  }
  const backendOptions = [
    "prompt — choose a Pi model",
    `${CLASSIFIER_BACKEND_IDS.typesafe} — use Jev (requires Pi auth.json or ${TYPE_SAFE_API_KEY_ENV})`,
  ];
  if (piClassificationSupported(ctx.modelRegistry)) {
    backendOptions.push(
      `${CLASSIFIER_BACKEND_IDS.piNative} — use Pi native classify (requires Pi TypeSafe auth)`,
    );
  }
  const selected = await ctx.ui.select("Classifier backend", backendOptions);
  if (!selected) return;
  const backend = selected.startsWith(CLASSIFIER_BACKEND_IDS.typesafe)
    ? CLASSIFIER_BACKEND_IDS.typesafe
    : selected.startsWith(CLASSIFIER_BACKEND_IDS.piNative)
      ? CLASSIFIER_BACKEND_IDS.piNative
      : CLASSIFIER_BACKEND_IDS.prompt;
  let selectedPromptModel: string | undefined;
  const needsPromptModel =
    backend === CLASSIFIER_BACKEND_IDS.prompt &&
    !promptClassifierModelAvailable(ctx, state.config.classifier?.model);
  if (needsPromptModel) {
    if (ctx.modelRegistry.getAvailable().length === 0) {
      logImportant(
        ctx,
        "Classifier model unavailable",
        "No Pi models are available; regex fallback remains active.",
        "warning",
      );
    } else {
      selectedPromptModel = (await requestPromptClassifierModel(ctx)) ?? undefined;
      if (!selectedPromptModel) {
        logImportant(
          ctx,
          "Model selection cancelled",
          "Prompt classifier configuration was not changed.",
          "info",
        );
        return;
      }
    }
  }
  let selectedPiNativeModel: string | null | undefined;
  if (backend === CLASSIFIER_BACKEND_IDS.piNative) {
    let catalogModels: string[] = [];
    try {
      catalogModels = (await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe")).map(
        (model) => `${model.provider}/${model.id}`,
      );
    } catch {
      logImportant(
        ctx,
        "Classifier catalog unavailable",
        "Could not load the typesafe classifier catalog. Check credentials, then retry.",
        "warning",
      );
    }
    if (catalogModels.length === 0) {
      logImportant(
        ctx,
        "TypeSafe classifier unavailable",
        `Run /login or set ${TYPE_SAFE_API_KEY_ENV} before use.`,
        "warning",
      );
    }
    const picked = await ctx.ui.select("Pi native classifier model", [
      "Catalog default",
      ...catalogModels,
    ]);
    if (!picked) return;
    selectedPiNativeModel = picked === "Catalog default" ? null : picked;
  }
  const path = join(process.cwd(), CONFIG_DIR_NAME, "bifrost.json");
  let current: Record<string, unknown> = {};
  try {
    current = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : {};
  } catch {
    logImportant(ctx, "Classifier update blocked", ".pi/bifrost.json is invalid JSON.", "error");
    return;
  }
  const classifier =
    current.classifier &&
    typeof current.classifier === "object" &&
    !Array.isArray(current.classifier)
      ? (current.classifier as Record<string, unknown>)
      : {};
  const choice = {
    backend,
    promptModel:
      backend === CLASSIFIER_BACKEND_IDS.prompt
        ? (selectedPromptModel ?? (needsPromptModel ? null : undefined))
        : undefined,
    piNativeModel: selectedPiNativeModel,
  };
  if (bootstrapSourceAtStart) {
    if (
      !persistBootstrapConfig(ctx, state, bootstrapSourceAtStart, choice, configGenerationAtStart)
    )
      return;
    const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
    if (!installReloadedConfig(state, loadedConfig, ctx)) return;
    state.classifierMetricsStore.reload({
      cwd: process.cwd(),
      enabled: classifierMetricsEnabled(
        state.config,
        state.effectiveClassifierBackend(state.config).backend,
      ),
    });
    logImportant(
      ctx,
      "Classifier backend updated",
      `${backend}; configuration reloaded.`,
      "success",
    );
    if (
      backend === CLASSIFIER_BACKEND_IDS.typesafe &&
      resolveTypeSafeApiKey().source === "missing"
    ) {
      logImportant(
        ctx,
        "TypeSafe credential missing",
        `Use ~/.pi/agent/auth.json or set ${TYPE_SAFE_API_KEY_ENV}.`,
        "warning",
      );
    }
    return;
  }
  current.classifier = nextClassifierConfig(classifier, choice);
  mkdirSync(join(process.cwd(), CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
  if (!installReloadedConfig(state, loadedConfig, ctx)) return;
  state.classifierMetricsStore.reload({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(
      state.config,
      state.effectiveClassifierBackend(state.config).backend,
    ),
  });
  logImportant(ctx, "Classifier backend updated", `${backend}; configuration reloaded.`, "success");
  if (backend === CLASSIFIER_BACKEND_IDS.typesafe && resolveTypeSafeApiKey().source === "missing") {
    logImportant(
      ctx,
      "TypeSafe credential missing",
      `Use ~/.pi/agent/auth.json or set ${TYPE_SAFE_API_KEY_ENV}.`,
      "warning",
    );
  }
}

// ── Route table ─────────────────────────────────────────────

/**
 * Re-read every config layer and install the result through Bifrost's runtime
 * reload path. Shared by `/bifrost reload` and by an approved agent apply, so
 * both activate a saved configuration exactly the same way.
 */
export function reloadBifrostConfig(
  state: BifrostState,
  ctx: ExtensionContext,
  announceSuccess = false,
): boolean {
  const done = debugMeasure("command", "reload");
  const loadedConfig = loadConfigForReload(process.cwd(), state.extensionDir);
  if (!installReloadedConfig(state, loadedConfig, ctx)) {
    done({ accepted: false });
    return false;
  }
  // Re-init debug — user may have updated debug config since startup.
  setupDebug(state.config.debug ?? { enabled: false }, process.cwd());
  const runtimeState = loadRuntimeState(runtimeStatePath(process.cwd()), {
    enabled: state.config.enabled ?? true,
    pinned: false,
    classifierEnabled: state.config.classifier?.enabled ?? true,
    classifierSource: "configuration",
  });
  state.enabled = runtimeState.enabled;
  state.legacyClassifierEnabled = runtimeState.legacyClassifierEnabled;
  state.classifierRuntimeStateIssue = runtimeState.runtimeStateIssue;
  state.cacheEntries = loadCache(
    cachePath(process.cwd(), state.config.cache?.path),
    (state.config.cache?.ttlHours ?? 720) * 60 * 60 * 1000,
  );
  state.reliabilityStore.reload(state.config.reliability, process.cwd());
  state.classifierMetricsStore.reload({
    cwd: process.cwd(),
    enabled: classifierMetricsEnabled(
      state.config,
      state.effectiveClassifierBackend(state.config).backend,
    ),
  });
  syncBifrostModeStatus(ctx, state);
  clearBifrostWidgets(ctx);
  if (announceSuccess && loadedConfig.warnings.length === 0) {
    logImportant(ctx, "Bifrost config reloaded", "Configuration is active.", "success");
  }
  done();
  debug("command", "reloaded", {
    enabled: state.enabled,
    classifierEnabled: classifierEnablementFor(state, ctx).enabled,
    tiers: Object.keys(state.config.models ?? {}).join(","),
  });
  return true;
}

export function createCommandRouter(
  state: BifrostState,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  const routes: CommandEntry[] = [
    exact("cost", async (_, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const data = getCostReportData(ctx.sessionManager.getBranch(), entries);
      if (!(await showCostView(ctx, data)))
        await uiResult(ctx, "Session usage", formatCostText(data));
    }),
    exact("on", (_, ctx) => {
      state.onManualControl?.(ctx.sessionManager, "on");
      state.enabled = true;
      const persisted = state.saveModeState() !== false;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      logImportant(
        ctx,
        "Bifrost enabled",
        persisted
          ? "Routing is enabled; this choice survives a restart."
          : "Routing is enabled for this session; the mode state could not be saved.",
        persisted ? "success" : "warning",
      );
    }),
    exact("off", async (_, ctx) => {
      if (state.selectPhysicalFromVirtual && !(await state.selectPhysicalFromVirtual(ctx))) return;
      state.onManualControl?.(ctx.sessionManager, "off");
      state.enabled = false;
      const persisted = state.saveModeState() !== false;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      logImportant(
        ctx,
        "Bifrost disabled",
        persisted
          ? "Routing is disabled; this choice survives a restart."
          : "Routing is disabled for this session; the mode state could not be saved.",
        persisted ? "success" : "warning",
      );
    }),
    exact("pin", async (_, ctx) => {
      if (state.selectPhysicalFromVirtual && !(await state.selectPhysicalFromVirtual(ctx))) return;
      state.onManualControl?.(ctx.sessionManager, "pin");
      state.pinned = true;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      logImportant(ctx, "Bifrost pinned", "Automatic model switching is disabled.", "success");
    }),
    exact("unpin", (_, ctx) => {
      state.onManualControl?.(ctx.sessionManager, "unpin");
      state.pinned = false;
      syncBifrostModeStatus(ctx, state);
      clearBifrostWidgets(ctx);
      logImportant(ctx, "Bifrost unpinned", "Automatic model switching is enabled.", "success");
    }),
    exact("reload", (_, ctx) => {
      reloadBifrostConfig(state, ctx, true);
    }),

    spaced("validate", (args, ctx) => handleDiagnosticsCommand("validate", args, ctx, state)),
    spaced("inspect", (args, ctx) => handleDiagnosticsCommand("inspect", args, ctx, state)),
    spaced("config", (args, ctx) => handleConfigCommand(args, ctx, state)),
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
        logImportant(ctx, "No models available", "The model registry is empty.", "warning");
        return;
      }
      clearBifrostWidgets(ctx);
      uiBusy(ctx, `Probing ${available.length} models...`);
      log(ctx, `Probing ${available.length} model(s) with "${PROBE_PROMPT_TEXT}"...`);

      let okCount = 0;
      let errCount = 0;
      let probeRun: Awaited<ReturnType<typeof runProbe>>;
      try {
        probeRun = await runProbe(ctx, {
          ...probeOptionsFromConfig(state.config.probe),
          signal: ctx.signal,
          onProgress: (done, total, last) => {
            if (last.status === "ok") okCount++;
            else if (last.status === "error" || last.status === "timeout") errCount++;
            setProbeProgress(ctx, { done, total, okCount, errCount });
          },
        });
      } finally {
        // Clear on every exit: a cancelled or thrown probe must not leave a
        // frozen progress bar that still reads as "probing".
        uiDone(ctx);
        if (ctx.hasUI) ctx.ui.setWidget("bifrost-probe", []);
      }
      if (probeRun.cancelled || ctx.signal?.aborted) {
        logImportant(ctx, "Probe cancelled", "Partial results were not saved.", "info");
        return;
      }
      const { results, path } = probeRun;
      state.reliabilityStore.applyOutcomes(
        results.map((r) =>
          r.status === "ok"
            ? { model: `${r.provider}/${r.model}`, ok: true as const, source: "probe" }
            : {
                model: `${r.provider}/${r.model}`,
                ok: false as const,
                source: "probe",
                reason: r.error ?? r.status,
              },
        ),
        Date.now(),
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

      const notWorking = results.length - ok.length;
      // Group failures by the existing reason classifier: the card should explain
      // *why* models failed, not list 400 near-duplicate errors. Raw per-model
      // errors stay in .pi/bifrost-probe.json.
      const failureReasons = new Map<string, { count: number; models: string[] }>();
      for (const r of [...errs, ...timeouts]) {
        const reason = failureDetails(r)?.reason ?? "unknown";
        const entry = failureReasons.get(reason) ?? { count: 0, models: [] };
        entry.count++;
        entry.models.push(`${r.provider}/${r.model}`);
        failureReasons.set(reason, entry);
      }
      const sortedReasons = [...failureReasons.entries()].sort((a, b) => b[1].count - a[1].count);
      const topReasons = sortedReasons.slice(0, 5);
      const countWidth = String(Math.max(0, ...sortedReasons.map(([, r]) => r.count))).length;
      const labelWidth = Math.max(
        ...topReasons.map(([reason]) => (REASON_LABELS[reason] ?? reason).length),
      );
      const details = [
        `${errs.length} failed · ${timeouts.length} timed out${
          skipped.length > 0 ? ` · ${skipped.length} skipped` : ""
        }`,
        ...topReasons.map(([reason, r]) => {
          // Small groups: name every model (the names are the answer). Large
          // groups: the count is the answer; per-model names stay in the file.
          const names = r.count <= 3 ? ` — ${r.models.join(", ")}` : "";
          return `${(REASON_LABELS[reason] ?? reason).padEnd(labelWidth)} ×${String(r.count).padStart(countWidth)}${names}`;
        }),
        ...(sortedReasons.length > topReasons.length
          ? [`${sortedReasons.length - topReasons.length} more failure reasons`]
          : []),
        "full errors: .pi/bifrost-probe.json",
      ];
      // Expanded view (ctrl+o): every failure group with its complete model list.
      const expandedDetails = [
        `${errs.length} failed · ${timeouts.length} timed out${
          skipped.length > 0 ? ` · ${skipped.length} skipped` : ""
        }`,
        ...sortedReasons.flatMap(([reason, r]) => [
          `${REASON_LABELS[reason] ?? reason} ×${r.count}`,
          ...r.models.map((m) => `· ${m}`),
        ]),
        "full errors: .pi/bifrost-probe.json",
      ];
      if (ok.length === 0) {
        logImportant(
          ctx,
          "No usable models",
          `0 of ${results.length} models are working`,
          "error",
          details,
          expandedDetails,
        );
      } else if (notWorking > 0) {
        logImportant(
          ctx,
          "Probe finished with failures",
          `${ok.length} of ${results.length} models are working`,
          "warning",
          details,
          expandedDetails,
        );
      } else if (ok.length > 0) {
        logImportant(ctx, "Probe complete", `All ${ok.length} models are working.`, "success");
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
      logImportant(
        ctx,
        "Cache cleared",
        "All cached classification entries were removed.",
        "success",
      );
    }),

    // Classifier
    exact("classifier test", (_, ctx) => handleClassifierTest(ctx, state)),
    exact("classifier", (_, ctx) => handleClassifierChoose(ctx, state)),
    exact("classifier on", (_, ctx) => {
      if (state.classifierRuntimeStateIssue) {
        logImportant(
          ctx,
          "Classifier enable blocked",
          "Runtime state is invalid. Repair .pi/bifrost-state.json, then run /bifrost reload.",
          "error",
        );
        return;
      }
      const effective = state.effectiveClassifierBackend(state.config, ctx);
      const errors = classifierConfigErrors(state.config, effective.backend, true);
      if (errors.length > 0) {
        logImportant(
          ctx,
          "Classifier enable blocked",
          `Configuration is invalid: ${errors.join(" ")}`,
          "error",
        );
        return;
      }
      state.setClassifierSessionOverride(ctx.sessionManager, true);
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: true, persistence: "session" });
      logImportant(
        ctx,
        "Classifier enabled",
        `Backend ${effective.backend} can receive current prompts; configuration was not changed.`,
        "success",
      );
    }),
    exact("classifier off", (_, ctx) => {
      state.setClassifierSessionOverride(ctx.sessionManager, false);
      syncBifrostModeStatus(ctx, state);
      debug("command", "classifier_toggle", { enabled: false, persistence: "session" });
      logImportant(
        ctx,
        "Classifier disabled",
        "Disabled for this Pi session; configuration was not changed.",
        "info",
      );
    }),
    exact("classifier inherit", (_, ctx) => {
      state.setClassifierSessionOverride(ctx.sessionManager, undefined);
      const enablement = classifierEnablementFor(state, ctx);
      syncBifrostModeStatus(ctx, state);
      if (enablement.source === "legacy-conflict" && enablement.legacyConflict) {
        logImportant(
          ctx,
          "Classifier override cleared",
          classifierConflictNote(enablement.legacyConflict, enablement.source) + ".",
          "warning",
        );
      } else if (enablement.runtimeStateIssue) {
        logImportant(
          ctx,
          "Classifier remains disabled",
          "Runtime state is invalid. Repair .pi/bifrost-state.json, then run /bifrost reload.",
          "error",
        );
      } else {
        logImportant(
          ctx,
          "Classifier override cleared",
          `Classifier now follows configuration for this session (${enablement.enabled ? "enabled" : "disabled"}).`,
          "info",
        );
      }
    }),
    exact("classifier status", (_, ctx) => {
      const rawModel = state.config.classifier?.model;
      const modelId = Array.isArray(rawModel) ? rawModel.join(", ") : (rawModel ?? "none");
      const classifier = state.config.classifier;
      const effective = state.effectiveClassifierBackend(state.config, ctx);
      const backend = effective.backend;
      const label = effective.auto ? `auto: ${backend} (${effective.reason})` : backend;
      const credential =
        backend === CLASSIFIER_BACKEND_IDS.typesafe ? resolveTypeSafeApiKey().source : undefined;
      const fallback =
        classifier?.fallback ??
        (backend === CLASSIFIER_BACKEND_IDS.typesafe
          ? "prompt"
          : modelId === "none"
            ? "regex"
            : "prompt");
      const detail =
        backend === CLASSIFIER_BACKEND_IDS.typesafe
          ? `backend=${label} model=${classifier?.typesafe?.model ?? TYPE_SAFE_MODEL} endpoint=${TYPE_SAFE_ENDPOINT} minConfidence=${classifier?.minConfidence ?? 0.8} credential=${credential} fallback=${fallback} fallbackModel=${fallback === "regex" ? "none" : modelId}`
          : backend === CLASSIFIER_BACKEND_IDS.piNative
            ? `backend=${label} model=${classifier?.piNative?.model ?? "catalog default"} minConfidence=${classifier?.minConfidence ?? 0.8} fallback=${fallback} fallbackModel=${fallback === "regex" ? "none" : modelId}`
            : `backend=${label} model=${modelId} endpoint=${classifier?.endpoint ?? "registry"} method=${classifier?.method ?? "auto"}`;
      const metrics = state.classifierMetricsStore.snapshot();
      const runtime = classifierEnablementFor(state, ctx);
      const errors = classifierConfigErrors(state.config, backend, runtime.enabled);
      const conflict = runtime.legacyConflict;
      const lines = [
        `classifier: enabled=${runtime.enabled} (${runtime.source})`,
        `configured=${classifier?.enabled === false ? "off" : "on"}`,
        ...(conflict
          ? [
              `legacy saved classifierEnabled=${conflict.saved} conflicts with configured=${conflict.configured}; ${classifierConflictNote(conflict, runtime.source)}`,
            ]
          : []),
        ...(runtime.runtimeStateIssue
          ? [
              `runtime-state=invalid (${runtime.runtimeStateIssue}); classification is paused. Repair .pi/bifrost-state.json: it must be a JSON object, and enabled and classifierEnabled must be booleans if present. Then run /bifrost reload.`,
            ]
          : []),
        `readiness=${runtime.runtimeStateIssue ? "blocked" : !runtime.enabled ? "inactive" : errors.length > 0 ? "blocked" : "ready"}`,
        ...errors.map((message) => `error=${message}`),
        detail,
        ...(backend !== CLASSIFIER_BACKEND_IDS.prompt
          ? [
              `observations=${metrics.total} (persisted aggregate)`,
              `outcomes=${JSON.stringify(metrics.outcomes)}`,
            ]
          : []),
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
        `classifierEnabled: ${classifierEnablementFor(state, ctx).enabled}`,
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
        logImportant(
          ctx,
          "Bifrost status",
          `enabled=${state.enabled} pinned=${state.pinned} current=${modelKey(ctx.model)}`,
          "info",
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
      logImportant(ctx, "Unknown command", `/bifrost ${trimmed}`, "warning");
      return;
    }

    const selected = await pickBifrostCommand(ctx);
    if (!selected) return;

    if (selected.argumentHint) {
      ctx.ui.setEditorText(`/bifrost ${selected.value} `);
      logImportant(
        ctx,
        "Command drafted",
        `/bifrost ${selected.value} — add its arguments in the editor.`,
        "info",
      );
      return;
    }

    const route = routes.find((entry) => entry.value === selected.value);
    if (!route) return;

    debug("command", "dispatch", { command: route.value });
    await route.handler(route.value, ctx);
  };
}
