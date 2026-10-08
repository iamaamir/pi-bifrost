import { randomUUID } from "node:crypto";
import { resolveStoragePath } from "./storage.ts";
import type { ReliabilityConfig } from "./reliability.ts";
import type { ReliabilityV2Config, ReliabilityV2LeaseReference } from "./reliability-v2.ts";
import { ReliabilityV2Store } from "./reliability-v2-store.ts";
import type { FailureObservation } from "./failure-observations.ts";

export const V2_LEASE_TTL_MS = 120_000;
export const V2_RENEW_INTERVAL_MS = 40_000;
export const V2_MAX_DISPATCH_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const V2_STATE_RELATIVE_PATH = ".pi/bifrost-reliability-v2.json";

export function reliabilityV2Path(cwd: string): string {
  return resolveStoragePath(cwd, undefined, V2_STATE_RELATIVE_PATH);
}

export function reliabilityV2Config(config?: ReliabilityConfig): ReliabilityV2Config {
  return {
    failureThreshold: config?.failureThreshold ?? 3,
    windowMs: (config?.windowMinutes ?? 5) * 60_000,
    cooldownMs: (config?.cooldownMinutes ?? 60) * 60_000,
    cooldownOnAllowanceExhausted: config?.cooldownOnAllowanceExhausted ?? true,
    leaseTtlMs: V2_LEASE_TTL_MS,
    maxDispatchLifetimeMs: V2_MAX_DISPATCH_LIFETIME_MS,
    dedupRetentionMs: V2_MAX_DISPATCH_LIFETIME_MS,
    maxDedupEntries: 50_000,
    maxDispatchReceipts: 10_000,
  };
}

export function createReliabilityV2Store(cwd: string, config?: ReliabilityConfig): ReliabilityV2Store {
  return new ReliabilityV2Store({ path: reliabilityV2Path(cwd), config: reliabilityV2Config(config), requireInitialized: true });
}

export type V2ReceiptOutcome = "success" | "failure" | "cancelled" | undefined;

export interface AutoDispatchReceipt {
  readonly store: ReliabilityV2Store;
  readonly ownerToken: string;
  readonly dispatchId: string;
  readonly outcomeId: string;
  readonly sessionId: string;
  readonly userEntryId: string;
  readonly userMessage: WeakRef<object>;
  readonly branchEpoch: number;
  readonly configGeneration: number;
  readonly manualGeneration: number;
  readonly modelKey: string;
  readonly tier: string;
  readonly observationsEnabled: boolean;
  readonly affinityEligible: boolean;
  readonly retryEligible: boolean;
  readonly admittedAt: number;
  proofUntil: number;
  leases: ReliabilityV2LeaseReference[];
  outcome: V2ReceiptOutcome;
  failureObservation?: FailureObservation;
  assistantEntryId?: string;
  successObservedAt?: number;
  renewalFailed: boolean;
  finalizing: boolean;
  finalized: boolean;
  timer?: ReturnType<typeof setInterval>;
  operation: Promise<unknown>;
}

export interface SessionReceipts {
  readonly ownerToken: string;
  readonly receipts: Map<string, AutoDispatchReceipt>;
  branchEpoch: number;
  manualGeneration: number;
}

/** Content-free in-memory receipt ownership. Prompt objects are held through WeakRef only. */
export class AutoDispatchReceiptBook {
  private readonly sessions = new WeakMap<object, SessionReceipts>();
  private readonly known = new Set<WeakRef<object>>();

  forSession(session: object): SessionReceipts {
    let current = this.sessions.get(session);
    if (!current) {
      current = { ownerToken: randomUUID(), receipts: new Map(), branchEpoch: 0, manualGeneration: 0 };
      this.sessions.set(session, current);
      this.known.add(new WeakRef(session));
    }
    return current;
  }

  advanceBranch(session: object): void {
    this.forSession(session).branchEpoch += 1;
  }

  advanceManual(session: object): void {
    this.forSession(session).manualGeneration += 1;
  }

  create(input: {
    session: object;
    sessionId: string;
    userEntryId: string;
    userMessage: object;
    configGeneration: number;
    modelKey: string;
    tier: string;
    observationsEnabled: boolean;
    affinityEligible: boolean;
    retryEligible: boolean;
    admittedAt: number;
    proofUntil: number;
    leases: ReliabilityV2LeaseReference[];
    store: ReliabilityV2Store;
  }): AutoDispatchReceipt {
    const owner = this.forSession(input.session);
    const receipt: AutoDispatchReceipt = {
      store: input.store,
      ownerToken: owner.ownerToken,
      dispatchId: randomUUID(),
      outcomeId: randomUUID(),
      sessionId: input.sessionId,
      userEntryId: input.userEntryId,
      userMessage: new WeakRef(input.userMessage),
      branchEpoch: owner.branchEpoch,
      configGeneration: input.configGeneration,
      manualGeneration: owner.manualGeneration,
      modelKey: input.modelKey,
      tier: input.tier,
      observationsEnabled: input.observationsEnabled,
      affinityEligible: input.affinityEligible,
      retryEligible: input.retryEligible,
      admittedAt: input.admittedAt,
      proofUntil: input.proofUntil,
      leases: input.leases,
      outcome: undefined,
      renewalFailed: false,
      finalizing: false,
      finalized: false,
      operation: Promise.resolve(),
    };
    owner.receipts.set(input.userEntryId, receipt);
    return receipt;
  }

  find(session: object, entryId: string, message: object): AutoDispatchReceipt | undefined {
    const receipt = this.forSession(session).receipts.get(entryId);
    if (!receipt || receipt.userMessage.deref() !== message || receipt.finalized) return undefined;
    return receipt;
  }

  receipts(session: object): AutoDispatchReceipt[] {
    return [...this.forSession(session).receipts.values()];
  }

  knownSessions(): object[] {
    const live: object[] = [];
    for (const reference of this.known) {
      const session = reference.deref();
      if (session) live.push(session);
      else this.known.delete(reference);
    }
    return live;
  }

  remove(session: object, receipt: AutoDispatchReceipt): void {
    const owner = this.forSession(session);
    if (owner.receipts.get(receipt.userEntryId) === receipt) owner.receipts.delete(receipt.userEntryId);
    receipt.finalized = true;
    if (receipt.timer) clearInterval(receipt.timer);
    receipt.timer = undefined;
  }

  clearSession(session: object): AutoDispatchReceipt[] {
    const owner = this.forSession(session);
    const receipts = [...owner.receipts.values()];
    owner.receipts.clear();
    owner.branchEpoch += 1;
    for (const receipt of receipts) {
      receipt.finalized = true;
      if (receipt.timer) clearInterval(receipt.timer);
      receipt.timer = undefined;
    }
    return receipts;
  }
}

/** Queue lease transitions so heartbeat, continuation and settlement never race stale refs. */
export function serializeReceiptOperation<T>(receipt: AutoDispatchReceipt, operation: () => Promise<T>): Promise<T> {
  const next = receipt.operation.then(operation, operation);
  receipt.operation = next.then(() => undefined, () => undefined);
  return next;
}
