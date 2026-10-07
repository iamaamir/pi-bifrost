import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateConfig, type BifrostConfig } from "./config.ts";
import { findCandidates, modelKey } from "./routing.ts";
import { getCircuitState, type ReliabilityConfig, type ReliabilityState } from "./reliability.ts";
import { isVirtualModel } from "./virtual-model.ts";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface BifrostDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly repair: string;
  readonly path?: string;
  readonly tier?: string;
  readonly entryIndex?: number;
  readonly ruleIndex?: number;
  readonly model?: string;
}

export interface DiagnosticRegistry {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  find(provider: string, modelId: string): Model<Api> | undefined;
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
}

export interface ValidateDiagnosticsInput {
  /** The effective, already-loaded config. Disk edits appear after reload. */
  readonly config: BifrostConfig;
  readonly registry?: DiagnosticRegistry;
}

export interface ValidateDiagnosticsReport {
  readonly version: 1;
  readonly kind: "validation";
  readonly configSource: "loaded-effective-config";
  readonly diagnostics: readonly BifrostDiagnostic[];
}

export type AuthObservability = "configured" | "not_configured" | "unknown";
export type CandidateCircuit = "disabled" | "open" | "trial_active" | "half_open" | "closed" | "unknown";

export interface InspectedCandidate {
  readonly model: string;
  readonly available: boolean | "unknown";
  readonly auth: AuthObservability;
  readonly circuit: CandidateCircuit;
  readonly openUntil?: number;
}

export interface InspectedTier {
  readonly tier: string;
  readonly configuredEntryCount: number;
  readonly candidates: readonly InspectedCandidate[];
}

export interface InspectDiagnosticsInput {
  readonly config: BifrostConfig;
  readonly registry: DiagnosticRegistry;
  readonly reliabilityState: ReliabilityState;
  readonly reliabilityConfig?: ReliabilityConfig;
  readonly now?: number;
  /** Bifrost's local refresh completion time, not a provider-data timestamp. */
  readonly lastRegistryRefreshAt?: number;
}

export interface InspectDiagnosticsReport {
  readonly version: 1;
  readonly kind: "inspection";
  readonly observedAt: number;
  readonly registry: {
    readonly knownModelCount: number | "unknown";
    readonly availableModelCount: number | "unknown";
    readonly bifrostLastRefreshAgeMs?: number;
  };
  readonly tiers: readonly InspectedTier[];
  readonly diagnostics: readonly BifrostDiagnostic[];
}

const CONFIG_REPAIR = "Review the active configuration and run validation again.";
const REFERENCE_REPAIR = "Check this pool entry against Pi's current model registry.";

const configIssueMap: Readonly<Record<string, { code: string; repair: string }>> = {
  "config.schema_version_unsupported": { code: "config.schema_version_unsupported", repair: "Set schemaVersion to a supported version." },
  "config.tier_policies_requires_v2": { code: "config.tier_policies_requires_v2", repair: "Set schemaVersion to 2 or remove tierPolicies." },
  "config.tier_policies_invalid": { code: "config.tier_policies_invalid", repair: "Set tierPolicies to an object keyed by configured tier." },
  "config.tier_policy_invalid": { code: "config.tier_policy_invalid", repair: "Set each tier policy to an object with a fallbackTiers array." },
  "config.tier_policy_unknown_field": { code: "config.tier_policy_unknown_field", repair: "Remove unsupported fields from this tier policy." },
  "config.tier_policy_unknown_tier": { code: "config.tier_policy_unknown_tier", repair: "Use a tier name that exists in models." },
  "config.tier_policy_fallback_invalid": { code: "config.tier_policy_fallback_invalid", repair: "Set fallbackTiers to an array of tier names." },
  "config.tier_policy_unknown_fallback": { code: "config.tier_policy_unknown_fallback", repair: "Use fallback tier names that exist in models." },
  "config.tier_policy_self_fallback": { code: "config.tier_policy_self_fallback", repair: "Remove the tier from its own fallback list." },
  "config.tier_policy_duplicate_fallback": { code: "config.tier_policy_duplicate_fallback", repair: "List each fallback tier only once." },
  "config.tier_policy_cycle": { code: "config.tier_policy_cycle", repair: "Remove a fallback edge to break the cycle." },
};

function safeConfigIssuePath(value: unknown): string | undefined {
  if (value === "schemaVersion" || value === "tierPolicies") return value;
  if (value === "tierPolicies.*" || value === "tierPolicies.*.fallbackTiers") return value;
  if (typeof value !== "string" || value.length > 280) return undefined;
  const match = /^tierPolicies\.([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})(?:\.fallbackTiers)?$/.exec(value);
  return match ? value : undefined;
}

function modelPoolEntries(config: BifrostConfig, tier: string): readonly string[] {
  const raw = config.models?.[tier];
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return entries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function registryContext(registry: DiagnosticRegistry): ExtensionContext {
  return { modelRegistry: registry } as unknown as ExtensionContext;
}

function knownModelSnapshot(registry: DiagnosticRegistry, knownModels: readonly Model<Api>[]): DiagnosticRegistry {
  const models = [...knownModels];
  return {
    getAll: () => models,
    // Routing's existing substring expander uses `getAvailable`. For offline
    // inventory, give it the frozen known-model set and report availability
    // separately; this does not change runtime routing semantics.
    getAvailable: () => models,
    find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
    getProviderAuthStatus: (provider) => registry.getProviderAuthStatus(provider),
  };
}

function issueDiagnostics(config: BifrostConfig): BifrostDiagnostic[] {
  try {
    return validateConfig(config).map((issue) => {
      // Messages can contain user regexes, names, or arbitrary invalid values.
      // Only consume static codes and separately sanitized field paths.
      const metadata = issue as typeof issue & { readonly code?: unknown; readonly path?: unknown };
      const mapped = typeof metadata.code === "string" ? configIssueMap[metadata.code] : undefined;
      const path = mapped ? safeConfigIssuePath(metadata.path) : undefined;
      return {
        code: mapped?.code ?? (issue.severity === "error" ? "config.invalid" : "config.warning"),
        severity: issue.severity,
        repair: mapped?.repair ?? CONFIG_REPAIR,
        ...(path ? { path } : {}),
      };
    });
  } catch {
    return [{ code: "config.validation_unavailable", severity: "error", repair: CONFIG_REPAIR }];
  }
}

function registryPoolDiagnostics(config: BifrostConfig, registry: DiagnosticRegistry): BifrostDiagnostic[] {
  const diagnostics: BifrostDiagnostic[] = [];
  const ctx = registryContext(registry);
  for (const [tier, rawPool] of Object.entries(config.models ?? {})) {
    const rawEntries = Array.isArray(rawPool) ? rawPool : rawPool === undefined ? [] : [rawPool];
    const entries = modelPoolEntries(config, tier);
    if (entries.length === 0) {
      diagnostics.push({ code: "pool.empty", severity: "warning", tier, repair: "Add a model pattern to this tier or leave it intentionally unused." });
      continue;
    }
    for (let entryIndex = 0; entryIndex < rawEntries.length; entryIndex += 1) {
      const pattern = rawEntries[entryIndex];
      if (typeof pattern !== "string" || pattern.trim().length === 0) continue;
      const candidates = findCandidates(ctx, pattern);
      if (candidates.length > 0) continue;
      const exact = pattern.includes("/");
      diagnostics.push({
        code: exact ? "model.reference_unresolved" : "pool.pattern_unresolved",
        severity: "warning",
        tier,
        entryIndex,
        repair: REFERENCE_REPAIR,
      });
    }
  }
  for (let ruleIndex = 0; ruleIndex < (config.rules ?? []).length; ruleIndex += 1) {
    const model = config.rules?.[ruleIndex]?.model;
    if (typeof model !== "string" || model.trim().length === 0) continue;
    if (Object.hasOwn(config.models ?? {}, model) || findCandidates(ctx, model).length > 0) continue;
    diagnostics.push({
      code: "rule.target_unresolved",
      severity: "warning",
      ruleIndex,
      repair: "Check this rule target against configured tiers and Pi's current model registry.",
    });
  }
  return diagnostics;
}

/** Validate only the active merged snapshot and synchronous registry reads. */
export function validateDiagnostics(input: ValidateDiagnosticsInput): ValidateDiagnosticsReport {
  const diagnostics = issueDiagnostics(input.config);
  if (!input.registry) {
    diagnostics.push({ code: "registry.unavailable", severity: "info", repair: "Registry reference checks are unavailable until Pi exposes its local registry snapshot." });
  } else {
    try {
      const knownModels = input.registry.getAll().filter((model) => !isVirtualModel(model));
      diagnostics.push(...registryPoolDiagnostics(input.config, knownModelSnapshot(input.registry, knownModels)));
    } catch {
      diagnostics.push({ code: "registry.snapshot_unavailable", severity: "warning", repair: "Refresh Pi's model registry explicitly, then validate again." });
    }
  }
  return {
    version: 1,
    kind: "validation",
    configSource: "loaded-effective-config",
    diagnostics,
  };
}

function authStatus(registry: DiagnosticRegistry, provider: string): AuthObservability {
  try {
    const status = registry.getProviderAuthStatus(provider);
    if (!status || typeof status.configured !== "boolean") return "unknown";
    return status.configured ? "configured" : "not_configured";
  } catch {
    return "unknown";
  }
}

function circuitStatus(
  reliabilityState: ReliabilityState,
  reliabilityConfig: ReliabilityConfig | undefined,
  key: string,
  now: number,
): { status: CandidateCircuit; openUntil?: number } {
  if (reliabilityConfig?.enabled === false) return { status: "disabled" };
  try {
    const state = getCircuitState(reliabilityState, key, now, reliabilityConfig);
    if (state.open) return { status: "open", ...(state.openUntil ? { openUntil: state.openUntil } : {}) };
    if (state.trialActive) return { status: "trial_active" };
    if (state.halfOpen) return { status: "half_open", ...(state.openUntil ? { openUntil: state.openUntil } : {}) };
    return { status: "closed" };
  } catch {
    return { status: "unknown" };
  }
}

/** Build an offline snapshot without route selection, random ranking, or reservation. */
export function inspectDiagnostics(input: InspectDiagnosticsInput): InspectDiagnosticsReport {
  const now = input.now ?? Date.now();
  let knownModels: Model<Api>[] | undefined;
  let availableModels: Model<Api>[] | undefined;
  const diagnostics: BifrostDiagnostic[] = [];
  try {
    knownModels = input.registry.getAll().filter((model) => !isVirtualModel(model));
    availableModels = input.registry.getAvailable().filter((model) => !isVirtualModel(model));
  } catch {
    diagnostics.push({ code: "registry.snapshot_unavailable", severity: "warning", repair: "Refresh Pi's model registry explicitly, then inspect again." });
  }
  const availableKeys = new Set(availableModels?.map(modelKey) ?? []);
  const snapshot = knownModelSnapshot(input.registry, knownModels ?? []);
  const authByProvider = new Map<string, AuthObservability>();
  const tiers: InspectedTier[] = [];
  for (const [tier, pattern] of Object.entries(input.config.models ?? {})) {
    let candidates: Model<Api>[] = [];
    try {
      candidates = findCandidates(registryContext(snapshot), pattern);
    } catch {
      diagnostics.push({ code: "registry.snapshot_unavailable", severity: "warning", tier, repair: "Refresh Pi's model registry explicitly, then inspect again." });
    }
    const inspected: InspectedCandidate[] = candidates.map((model) => {
      const key = modelKey(model);
      const circuit = circuitStatus(input.reliabilityState, input.reliabilityConfig, key, now);
      let auth = authByProvider.get(model.provider);
      if (auth === undefined) {
        auth = authStatus(input.registry, model.provider);
        authByProvider.set(model.provider, auth);
      }
      return {
        model: key,
        available: availableModels ? availableKeys.has(key) : "unknown",
        auth,
        circuit: circuit.status,
        ...(circuit.openUntil !== undefined ? { openUntil: circuit.openUntil } : {}),
      };
    });
    tiers.push({ tier, configuredEntryCount: modelPoolEntries(input.config, tier).length, candidates: inspected });
  }
  return {
    version: 1,
    kind: "inspection",
    observedAt: now,
    registry: {
      knownModelCount: knownModels?.length ?? "unknown",
      availableModelCount: availableModels?.length ?? "unknown",
      ...(input.lastRegistryRefreshAt !== undefined && Number.isFinite(input.lastRegistryRefreshAt)
        ? { bifrostLastRefreshAgeMs: Math.max(0, now - input.lastRegistryRefreshAt) }
        : {}),
    },
    tiers,
    diagnostics,
  };
}
