import { createHash, randomUUID } from "node:crypto";
import { modelScopeKey, type ReliabilityV2LeaseReference, type ReliabilityV2State } from "./reliability-v2.ts";
import { ReliabilityV2Store, ReliabilityV2StoreError } from "./reliability-v2-store.ts";
import type { ReliabilityState } from "./reliability.ts";

const PROVIDER_KEY_PREFIX = "bifrost-provider-";
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,200}$/;
const MAX_PAUSE_MS = 1_000_000 * 60_000;
const MAX_RATE_PAUSE_MS = 5 * 60 * 1000;

export interface ProviderTrialClaim {
  readonly ownerStore: ProviderCooldownStore;
  providerId: string;
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  leases: ReliabilityV2LeaseReference[];
  recoveredScopes: Array<{ modelKey: string; generation: number }>;
  renewalFailed?: boolean;
  finalizing?: boolean;
  finalized?: boolean;
}

export interface ProviderCooldownView {
  providerId: string;
  openUntil?: number;
  trialActive: boolean;
  recoveryPending: boolean;
}

export interface LegacyAllowanceMarker {
  providerId: string;
  modelKey: string;
  sourceId: string;
  openUntil: number;
}

export function providerScopeModelKey(kind: "usage" | "rate" | "trial", providerId: string): string {
  if (!PROVIDER_ID.test(providerId)) throw new Error("Invalid provider id for reliability scope.");
  return `${PROVIDER_KEY_PREFIX}${kind}/${providerId}`;
}

function scope(state: ReliabilityV2State, key: string): ReliabilityV2State["scopes"][string] | undefined {
  return state.scopes[modelScopeKey(key)];
}

export class ProviderCooldownStore {
  readonly store: ReliabilityV2Store;
  private readonly cooldownMs: number;
  private readonly trialOperations = new WeakMap<ProviderTrialClaim, Promise<void>>();

  constructor(store: ReliabilityV2Store, cooldownMs: number) {
    this.store = store;
    this.cooldownMs = cooldownMs;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > MAX_PAUSE_MS) {
      throw new Error("Provider cooldown is outside the configured reliability bounds.");
    }
  }

  read(providerId: string, includeUsagePause = true, now = Date.now()): ProviderCooldownView {
    const state = this.store.readSnapshot();
    const usage = includeUsagePause ? scope(state, providerScopeModelKey("usage", providerId)) : undefined;
    const rate = scope(state, providerScopeModelKey("rate", providerId));
    const trial = scope(state, providerScopeModelKey("trial", providerId));
    const activeUntil = [usage?.openUntil, rate?.openUntil]
      .filter((until): until is number => typeof until === "number" && until > now)
      .reduce<number | undefined>((latest, until) => Math.max(latest ?? 0, until), undefined);
    const recoveryPending = [usage?.openUntil, rate?.openUntil]
      .some((until) => until !== undefined && until <= now);
    return {
      providerId,
      ...(activeUntil === undefined ? {} : { openUntil: activeUntil }),
      trialActive: !!trial?.lease && trial.lease.generation === trial.generation && trial.lease.expiresAt > now,
      recoveryPending,
    };
  }

  list(now = Date.now()): ProviderCooldownView[] {
    const state = this.store.readSnapshot();
    const providers = new Set<string>();
    for (const key of Object.keys(state.scopes)) {
      const decoded = /^model:\d+:bifrost-provider-(?:usage|rate|trial)\/([A-Za-z0-9][A-Za-z0-9._:+@-]{0,200})$/.exec(key);
      if (decoded) providers.add(decoded[1]!);
    }
    return [...providers].map((providerId) => {
      const usage = scope(state, providerScopeModelKey("usage", providerId));
      const rate = scope(state, providerScopeModelKey("rate", providerId));
      const trial = scope(state, providerScopeModelKey("trial", providerId));
      const openUntil = [usage?.openUntil, rate?.openUntil]
        .filter((until): until is number => typeof until === "number" && until > now)
        .reduce<number | undefined>((latest, until) => Math.max(latest ?? 0, until), undefined);
      const recoveryPending = [usage?.openUntil, rate?.openUntil]
        .some((until) => until !== undefined && until <= now);
      return {
        providerId,
        ...(openUntil === undefined ? {} : { openUntil }),
        trialActive: !!trial?.lease && trial.lease.generation === trial.generation && trial.lease.expiresAt > now,
        recoveryPending,
      };
    })
      .filter((item) => item.openUntil !== undefined || item.trialActive || item.recoveryPending)
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async pauseUsage(providerId: string, now = Date.now()): Promise<number> {
    return this.pause(providerScopeModelKey("usage", providerId), now, this.cooldownMs);
  }

  async importLegacyAllowance(marker: LegacyAllowanceMarker, now = Date.now()): Promise<boolean> {
    if (!PROVIDER_ID.test(marker.providerId) || marker.modelKey.length > 256
      || !Number.isSafeInteger(marker.openUntil) || marker.openUntil <= now || marker.openUntil > 8.64e15
      || marker.sourceId.length < 1 || marker.sourceId.length > 512) {
      throw new Error("Invalid legacy allowance marker.");
    }
    const digest = createHash("sha256").update(`${marker.providerId}\0${marker.sourceId}`).digest("hex");
    const result = await this.store.importProviderAllowance(
      providerScopeModelKey("usage", marker.providerId),
      `bifrost-provider-import/${digest}`,
      marker.openUntil,
    );
    if (result.status !== "settled") throw new ReliabilityV2StoreError("state_write_failed", "Legacy provider cooldown import could not be confirmed.");
    return result.reason === "imported";
  }

  async pauseRate(providerId: string, retryAt?: number, now = Date.now()): Promise<number> {
    const delay = Number.isSafeInteger(retryAt) && retryAt! > now ? Math.min(retryAt! - now, MAX_RATE_PAUSE_MS) : 5_000;
    const acceptedRetryAt = now + delay;
    return this.pause(providerScopeModelKey("rate", providerId), now, acceptedRetryAt - now);
  }

  async claimTrial(providerId: string, includeUsagePause = true, now = Date.now()): Promise<
    { allowed: true; claim?: ProviderTrialClaim } | { allowed: false }
  > {
    const current = this.store.readSnapshot();
    const usage = includeUsagePause ? scope(current, providerScopeModelKey("usage", providerId)) : undefined;
    const rate = scope(current, providerScopeModelKey("rate", providerId));
    const trial = scope(current, providerScopeModelKey("trial", providerId));
    if ([usage?.openUntil, rate?.openUntil].some((until) => until !== undefined && until > now)) return { allowed: false };
    if (trial?.lease && trial.lease.generation === trial.generation && trial.lease.expiresAt > now) return { allowed: false };
    if (![usage?.openUntil, rate?.openUntil].some((until) => until !== undefined && until <= now)) return { allowed: true };
    const ownerToken = randomUUID();
    const dispatchId = randomUUID();
    const outcomeId = randomUUID();
    const cooldownModelKeys = [
      providerScopeModelKey("rate", providerId),
      ...(includeUsagePause ? [providerScopeModelKey("usage", providerId)] : []),
    ];
    const result = await this.store.claimScopeTrial({
      ownerToken, dispatchId, outcomeId,
      modelKey: providerScopeModelKey("trial", providerId),
      cooldownModelKeys,
    });
    if (result.status === "blocked") return { allowed: false };
    if (result.status !== "admitted") throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown admission could not be confirmed.");
    const leases = result.leases ?? [];
    if (leases.length === 0) return { allowed: true };
    const admittedAt = result.state.dispatches[dispatchId]?.admittedAt ?? now;
    return {
      allowed: true,
      claim: {
        ownerStore: this,
        providerId, ownerToken, dispatchId, outcomeId, leases,
        recoveredScopes: cooldownModelKeys.flatMap((key) => {
          const recovered = scope(result.state, key);
          return recovered?.openUntil !== undefined && recovered.openUntil <= admittedAt
            ? [{ modelKey: key, generation: recovered.generation }] : [];
        }),
      },
    };
  }

  async settleTrial(claim: ProviderTrialClaim): Promise<void> {
    if (claim.finalized || claim.finalizing) return;
    claim.finalizing = true;
    await this.withTrialOperation(claim, async () => {
      const result = await this.store.settleScopeTrial({
        ownerToken: claim.ownerToken,
        dispatchId: claim.dispatchId,
        outcomeId: claim.outcomeId,
        settlement: { kind: "success" },
      }, claim.recoveredScopes);
      if (result.status !== "settled" && result.status !== "duplicate") {
        throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown trial settlement could not be confirmed.");
      }
    }).finally(() => { claim.finalized = true; });
  }

  async renewTrial(claim: ProviderTrialClaim): Promise<void> {
    if (claim.finalizing || claim.finalized) return;
    await this.withTrialOperation(claim, async () => {
      if (claim.finalizing || claim.finalized) return;
      const result = await this.store.renew({
        ownerToken: claim.ownerToken,
        dispatchId: claim.dispatchId,
        outcomeId: claim.outcomeId,
        leaseReferences: claim.leases,
        ttlMs: 120_000,
      });
      if (result.status !== "renewed" || !result.leases) {
        claim.renewalFailed = true;
        throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown trial renewal could not be confirmed.");
      }
      claim.leases = result.leases;
    });
  }

  async releaseTrial(claim: ProviderTrialClaim): Promise<void> {
    if (claim.finalized || claim.finalizing) return;
    claim.finalizing = true;
    await this.withTrialOperation(claim, async () => {
      const result = await this.store.abandon({
        ownerToken: claim.ownerToken,
        dispatchId: claim.dispatchId,
        outcomeId: claim.outcomeId,
        leaseReferences: claim.leases,
      });
      if (result.status !== "abandoned" && result.status !== "duplicate") {
        throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown trial release could not be confirmed.");
      }
    }).finally(() => { claim.finalized = true; });
  }

  private async withTrialOperation<T>(claim: ProviderTrialClaim, operation: () => Promise<T>): Promise<T> {
    const previous = this.trialOperations.get(claim) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.trialOperations.set(claim, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.trialOperations.get(claim) === current) this.trialOperations.delete(claim);
    }
  }

  async reset(providerId: string): Promise<"reset" | "already_clear" | "trial_active"> {
    const result = await this.store.clearScopeCooldowns(
      [providerScopeModelKey("usage", providerId), providerScopeModelKey("rate", providerId)],
      providerScopeModelKey("trial", providerId),
    );
    if (result.status === "blocked" && result.reason === "trial_active") return "trial_active";
    if (result.status !== "settled") throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown reset could not be confirmed.");
    return result.reason === "already_clear" ? "already_clear" : "reset";
  }

  private async pause(key: string, now: number, durationMs: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15
      || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_PAUSE_MS
      || now + durationMs > 8.64e15) throw new Error("Invalid provider cooldown time.");
    const openUntil = now + durationMs;
    const result = await this.store.setScopeCooldown(key, openUntil);
    if (result.status !== "settled") throw new ReliabilityV2StoreError("state_write_failed", "Provider cooldown could not be saved.");
    return openUntil;
  }
}

/** Ephemeral route projection; the provider state remains in its shared sidecar. */
export function projectProviderCooldownsForRouting(
  state: Readonly<ReliabilityState>,
  providerStore: ProviderCooldownStore,
  models: readonly { provider: string; id: string }[],
  includeUsagePause: boolean,
  now = Date.now(),
): ReliabilityState {
  const projected: ReliabilityState["models"] = Object.assign(Object.create(null), state.models);
  const providers = new Map<string, ProviderCooldownView>();
  for (const model of models) {
    if (!providers.has(model.provider)) providers.set(model.provider, providerStore.read(model.provider, includeUsagePause, now));
  }
  for (const model of models) {
    const view = providers.get(model.provider)!;
    if (view.openUntil === undefined && !view.trialActive) continue;
    const key = `${model.provider}/${model.id}`;
    const current = projected[key] ?? { failures: [] };
    projected[key] = {
      ...current,
      ...(view.openUntil === undefined ? {} : { openUntil: Math.max(current.openUntil ?? 0, view.openUntil) }),
      trialActive: current.trialActive === true || view.trialActive,
    };
  }
  return { version: 1, models: projected };
}
