import {
  emptyEconomicSnapshot,
  publishEconomicObservation,
  type EconomicDiagnostic,
  type EconomicScope,
  type EconomicSignal,
  type EconomicSnapshot,
  type EconomicSource,
  type ReservePolicy,
} from "./economic-signals.ts";
import type { EconomicConfig } from "./config.ts";

export interface EconomicSnapshotReconciliation {
  readonly snapshot: EconomicSnapshot;
  readonly diagnostics: readonly EconomicDiagnostic[];
  readonly policy?: ReservePolicy;
  /** Last active binding used only to reconcile facts across a disabled period. */
  readonly historyPolicy?: ReservePolicy;
  readonly quarantinedSourceRevisions: ReadonlyMap<string, number>;
}

/** Remove config-only observation data and freeze a core policy DTO copy. */
export function normalizeEconomicPolicy(config: EconomicConfig | undefined): ReservePolicy | undefined {
  if (!config) return undefined;
  return deepFreeze({
    mode: config.mode,
    scopes: Object.fromEntries(Object.entries(config.scopes).map(([key, scope]) => [key, { ...scope }])),
    sources: config.sources.map((source) => ({ ...source })),
    ...(config.preference ? { preference: { ...config.preference } } : {}),
    ...(config.sourceOrder ? { sourceOrder: Object.fromEntries(Object.entries(config.sourceOrder).map(([key, value]) => [key, [...value]])) } : {}),
    admission: config.admission.map((rule) => ({ ...rule })),
    ...(config.tierOverrides ? { tierOverrides: cloneTierOverrides(config.tierOverrides) } : {}),
  });
}

/**
 * Keep facts only while their source and scope binding remain compatible.
 * Retain compatible window watermarks even when a binding changes, so an old
 * configured observation cannot become current again on reload.
 */
export function reconcileEconomicSnapshot(
  previous: EconomicSnapshot | undefined,
  previousPolicy: ReservePolicy | undefined,
  nextConfig: EconomicConfig | undefined,
  previousQuarantine: ReadonlyMap<string, number> = new Map(),
): EconomicSnapshotReconciliation {
  const prior = previous ?? emptyEconomicSnapshot();
  const policy = normalizeEconomicPolicy(nextConfig);
  if (!policy) {
    return {
      snapshot: prior,
      diagnostics: [],
      quarantinedSourceRevisions: previousQuarantine,
      ...(previousPolicy ? { historyPolicy: previousPolicy } : {}),
    };
  }

  const diagnostics: EconomicDiagnostic[] = [];
  const quarantinedSourceRevisions = new Map(previousQuarantine);
  const compatibleSource = (source: EconomicSource): boolean => {
    const oldSource = previousPolicy?.sources.find((candidate) => candidate.id === source.id && candidate.scopeRef === source.scopeRef);
    if (!oldSource) return false;
    const oldScope = previousPolicy?.scopes[source.scopeRef];
    const nextScope = policy.scopes[source.scopeRef];
    return oldSource.authority === source.authority && sameScope(oldScope, nextScope);
  };
  const compatibleSources = new Set(policy.sources.filter(compatibleSource).map((source) => source.id));
  for (const source of policy.sources) {
    const oldSource = previousPolicy?.sources.find((candidate) => candidate.id === source.id);
    if (oldSource && !compatibleSource(source)) {
      const oldRevision = Math.max(0, ...prior.signals.filter((signal) => signal.sourceId === source.id).map((signal) => signal.revision));
      if (oldRevision > (quarantinedSourceRevisions.get(source.id) ?? -1)) quarantinedSourceRevisions.set(source.id, oldRevision);
      if (prior.signals.some((signal) => signal.sourceId === source.id)) {
        diagnostics.push({ code: "observation.binding_invalidated", severity: "warning", sourceId: source.id, scopeRef: source.scopeRef, repair: "Provide a fresh observation for the changed source or scope binding." });
      }
    }
  }
  const nextSignals = prior.signals.filter((signal) => {
    const source = policy.sources.find((candidate) => candidate.id === signal.sourceId && candidate.scopeRef === signal.scopeRef);
    const keep = Boolean(source && compatibleSources.has(source.id));
    return keep;
  }).map(cloneSignal);
  const nextSourceKeys = new Set(policy.sources.map((source) => `${source.id}\u0000${source.scopeRef}`));
  const watermarks = prior.watermarks
    .filter((item) => nextSourceKeys.has(`${item.sourceId}\u0000${item.scopeRef}`))
    .map((item) => ({ ...item }));
  let snapshot: EconomicSnapshot = deepFreeze({ revision: prior.revision, signals: nextSignals, watermarks: [...watermarks] });

  for (const observation of nextConfig?.observations ?? []) {
    const quarantineRevision = quarantinedSourceRevisions.get(observation.sourceId);
    if (quarantineRevision !== undefined && observation.revision <= quarantineRevision) {
      diagnostics.push({ code: "observation.binding_invalidated", severity: "warning", sourceId: observation.sourceId, scopeRef: observation.scopeRef, repair: "Provide a fresh observation for the changed source or scope binding." });
      continue;
    }
    const result = publishEconomicObservation(snapshot, policy, observation as EconomicSignal);
    if (result.accepted) {
      snapshot = result.snapshot;
      quarantinedSourceRevisions.delete(observation.sourceId);
    }
    else if (result.code !== "observation_duplicate") diagnostics.push(...result.diagnostics);
  }
  return { snapshot, diagnostics, policy, historyPolicy: policy, quarantinedSourceRevisions };
}

function sameScope(left: EconomicScope | undefined, right: EconomicScope | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  if (left.kind === "model" && right.kind === "model") return left.model === right.model;
  if (left.kind === "provider" && right.kind === "provider") return left.provider === right.provider;
  return left.kind === "account" && right.kind === "account"
    && left.provider === right.provider && left.accountRef === right.accountRef && left.epoch === right.epoch;
}

function cloneTierOverrides(
  overrides: NonNullable<EconomicConfig["tierOverrides"]>,
): NonNullable<ReservePolicy["tierOverrides"]> {
  return Object.fromEntries(Object.entries(overrides).map(([tier, rules]) => [
    tier,
    Object.fromEntries(Object.entries(rules).map(([rule, value]) => [rule, { ...value }])),
  ]));
}

function cloneSignal(signal: EconomicSignal): EconomicSignal {
  return {
    ...signal,
    windows: signal.windows.map((window) => ({ ...window, period: { ...window.period } })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
