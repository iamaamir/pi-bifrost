// Generated-boundary properties for the receipt-owned reliability v2 state machine.
//
// An independent reference model predicts the exact observable result (status
// plus reason, and the bounded single-scope/no-observation persisted projection:
// scope generations, cooldowns,
// leases, dispatch receipts and settled outcomes) after every generated
// admit/renew/settle/abandon/time/duplicate/stale operation. Production must
// match the model after each step; any drift fails. A real ReliabilityV2Store
// restart then continues meaningful operations against the same model. No
// production validator or stored value is used as the oracle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import * as v2Production from "../reliability-v2.ts";
import {
  abandonReliabilityV2Dispatch,
  admitReliabilityV2Dispatch,
  clearReliabilityV2ScopeCooldown,
  emptyReliabilityV2State,
  renewReliabilityV2Leases,
  setReliabilityV2ScopeCooldown,
  settleReliabilityV2Dispatch,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "../reliability-v2.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";

const CONFIG: ReliabilityV2Config = {
  failureThreshold: 2,
  windowMs: 60_000,
  cooldownMs: 60_000,
  leaseTtlMs: 30_000,
  maxDispatchLifetimeMs: 120_000,
  dedupRetentionMs: 300_000,
  maxDedupEntries: 100,
  maxDispatchReceipts: 100,
};

const MODELS = ["openai/gpt-5.4", "anthropic/claude-sonnet-4"] as const;
const OWNERS = ["owner-a", "owner-b"] as const;
const DISPATCHES = ["d1", "d2", "d3"] as const;
const ORIGIN = Date.UTC(2026, 0, 1, 12, 0, 0);

function scopeKeyOf(modelKey: string): string {
  return `model:${modelKey.length}:${modelKey}`;
}

// ── Independent reference model ────────────────────────────────────────────

interface RefLease {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  leaseId: string;
  generation: number;
  expiresAt: number;
  maxExpiresAt: number;
}

interface RefScope {
  generation: number;
  failures: number[];
  openUntil?: number;
  cooldownMultiplier?: number;
  lease?: RefLease;
}

interface RefDispatch {
  ownerToken: string;
  outcomeId: string;
  admittedAt: number;
  proofUntil: number;
  settledAt?: number;
  settledKind?: "success" | "failure" | "cancelled";
  scopeKey: string;
  scopeGeneration: number;
  modelKey: string;
  lease?: RefLease;
}

interface RefOutcome {
  expiresAt: number;
}

/**
 * A transition outcome. `commits` records whether the durable state changes.
 *
 * Production separates these: `admitReliabilityV2Dispatch` returns the empty
 * state on some refusals (the caller discards it), and the store only writes
 * when the transition actually commits. The model therefore tracks the durable
 * state itself and reports `commits` independently of the returned object.
 */
type RefResult = { status: string; reason?: string; commits?: boolean; emptyResult?: boolean };

class Reference {
  now = ORIGIN;
  /** Durable state revision; exactly one commit increments it by one. */
  revision = 0;
  readonly scopes = new Map<string, RefScope>();
  readonly dispatches = new Map<string, RefDispatch>();
  readonly outcomes = new Map<string, RefOutcome>();

  /** Deep-enough copy so a discarded prune can be rolled back. */
  private snapshotMaps() {
    return {
      scopes: new Map([...this.scopes.entries()].map(([k, v]) => [k, {
        generation: v.generation, failures: [...v.failures], openUntil: v.openUntil,
        cooldownMultiplier: v.cooldownMultiplier, lease: v.lease ? { ...v.lease } : undefined,
      }])),
      dispatches: new Map([...this.dispatches.entries()].map(([k, v]) => [k, { ...v }])),
      outcomes: new Map([...this.outcomes.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }

  private restoreMaps(snapshot: ReturnType<Reference["snapshotMaps"]>): void {
    this.scopes.clear();
    this.dispatches.clear();
    this.outcomes.clear();
    for (const [k, v] of snapshot.scopes) this.scopes.set(k, v);
    for (const [k, v] of snapshot.dispatches) this.dispatches.set(k, v);
    for (const [k, v] of snapshot.outcomes) this.outcomes.set(k, v);
  }

  private scope(scopeKey: string): RefScope {
    let entry = this.scopes.get(scopeKey);
    if (!entry) {
      entry = { generation: 0, failures: [] };
      this.scopes.set(scopeKey, entry);
    }
    return entry;
  }

  /**
   * Expired receipts are deleted and their dead trial leases are released from
   * the scope, exactly as the production prune does before any reuse.
   */
  private prune(now: number): void {
    for (const [id, d] of [...this.dispatches]) {
      if (d.proofUntil < now) {
        const scope = this.scopes.get(d.scopeKey);
        if (scope && d.lease && scope.lease
          && scope.lease.leaseId === d.lease.leaseId
          && scope.lease.expiresAt <= now
          && scope.lease.generation === d.lease.generation
          && scope.lease.expiresAt === d.lease.expiresAt
          && scope.lease.maxExpiresAt === d.lease.maxExpiresAt) {
          delete scope.lease;
        }
        this.dispatches.delete(id);
      }
    }
    for (const [id, o] of [...this.outcomes]) if (o.expiresAt < now) this.outcomes.delete(id);
  }

  private liveLease(d: RefDispatch, now: number): boolean {
    if (!d.lease) return false;
    const scope = this.scopes.get(d.scopeKey);
    return !!scope && !!scope.lease && scope.lease.leaseId === d.lease.leaseId
      && scope.lease.generation === d.lease.generation && scope.generation === d.lease.generation
      && scope.lease.expiresAt === d.lease.expiresAt && scope.lease.expiresAt > now;
  }

  private refLease(d: RefDispatch) {
    return d.lease ? [{
      scopeKey: d.scopeKey, generation: d.lease.generation, leaseId: d.lease.leaseId,
      expiresAt: d.lease.expiresAt, maxExpiresAt: d.lease.maxExpiresAt,
    }] : [];
  }

  // ops ───────────────────────────────────────────────────────────────────

  cooldown(modelKey: string, openUntil: number): RefResult {
    if (openUntil <= this.now) return { status: "invalid", reason: "invalid_scope_cooldown", commits: false };
    const scopeKey = scopeKeyOf(modelKey);
    const scope = this.scope(scopeKey);
    scope.generation += 1;
    scope.openUntil = Math.max(scope.openUntil ?? 0, openUntil);
    delete scope.lease; // a cooldown bump invalidates an in-flight trial lease
    this.revision += 1;
    return { status: "settled", commits: true };
  }

  clearCooldown(modelKey: string): RefResult {
    const scopeKey = scopeKeyOf(modelKey);
    const scope = this.scopes.get(scopeKey);
    if (!scope) return { status: "settled", reason: "already_clear", commits: false };
    if (scope.lease && scope.lease.expiresAt > this.now && scope.lease.generation === scope.generation) {
      return { status: "blocked", reason: "trial_active", commits: false };
    }
    scope.generation += 1;
    delete scope.openUntil;
    delete scope.lease;
    delete scope.cooldownMultiplier;
    this.revision += 1;
    return { status: "settled", commits: true };
  }

  admit(ownerToken: string, dispatchId: string, outcomeId: string, modelKey: string): RefResult {
    const scopeKey = scopeKeyOf(modelKey);
    // Production prunes inside the admission attempt but discards that prune
    // unless the admission actually commits, so snapshot before pruning.
    const snapshot = this.snapshotMaps();
    this.prune(this.now);
    if (this.dispatches.has(dispatchId) || this.outcomes.has(outcomeId)
      || [...this.dispatches.values()].some((d) => d.outcomeId === outcomeId)) {
      this.restoreMaps(snapshot);
      return { status: "duplicate", reason: "dispatch_or_outcome_id_exists" };
    }
    if (this.dispatches.size >= CONFIG.maxDispatchReceipts) {
      this.restoreMaps(snapshot);
      return { status: "capacity", reason: "dispatch_receipt_capacity" };
    }
    const scope = this.scope(scopeKey);
    if (scope.openUntil !== undefined && scope.openUntil > this.now) {
      this.restoreMaps(snapshot);
      return { status: "blocked", reason: `${scopeKey}:open` };
    }
    const halfOpen = scope.openUntil !== undefined && scope.openUntil <= this.now;
    if (halfOpen && scope.lease && scope.lease.generation === scope.generation && scope.lease.expiresAt > this.now) {
      this.restoreMaps(snapshot);
      return { status: "blocked", reason: `${scopeKey}:lease_owned` };
    }
    const maxExpiresAt = this.now + CONFIG.maxDispatchLifetimeMs;
    const lease = halfOpen ? {
      // The scope key disambiguates leases within one dispatch, so production
      // derives the lease identity from the dispatch ID.
      ownerToken, dispatchId, outcomeId, leaseId: dispatchId, generation: scope.generation,
      expiresAt: Math.min(this.now + CONFIG.leaseTtlMs, maxExpiresAt), maxExpiresAt,
    } : undefined;
    if (lease) scope.lease = { ...lease };
    this.dispatches.set(dispatchId, {
      ownerToken, outcomeId, admittedAt: this.now, proofUntil: maxExpiresAt,
      scopeKey, scopeGeneration: scope.generation, modelKey,
      lease: lease ? { ...lease } : undefined,
    });
    this.revision += 1;
    return { status: "admitted", commits: true };
  }

  renew(ownerToken: string, dispatchId: string, outcomeId: string, ttlMs?: number): RefResult {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken || d.outcomeId !== outcomeId || !d.lease) {
      // The pure transition hands back an empty sentinel state, but the store
      // never commits an invalid result, so the durable history is untouched.
      return { status: "invalid", reason: "invalid_lease_renewal", commits: false, emptyResult: true };
    }
    if (this.now > d.proofUntil) return { status: "expired", reason: "dispatch_proof_horizon_expired", commits: false };
    if (this.now < d.admittedAt) return { status: "stale", reason: "clock_before_admission", commits: false };
    if (this.now >= d.lease.maxExpiresAt) return { status: "expired", reason: "maximum_dispatch_lifetime_expired", commits: false };
    const ttl = ttlMs ?? CONFIG.leaseTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > CONFIG.leaseTtlMs) return { status: "invalid", reason: "invalid_lease_ttl", commits: false };
    if (!this.liveLease(d, this.now)) return { status: "stale", reason: "lease_owner_or_generation_changed", commits: false };
    const scope = this.scopes.get(d.scopeKey)!;
    scope.lease!.expiresAt = Math.min(this.now + ttl, scope.lease!.maxExpiresAt);
    d.lease.expiresAt = scope.lease!.expiresAt;
    this.revision += 1;
    return { status: "renewed", commits: true };
  }

  settle(ownerToken: string, dispatchId: string, outcomeId: string, kind: "success" | "failure" | "cancelled"): RefResult {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken || d.outcomeId !== outcomeId) {
      return { status: "stale", reason: "admission_receipt_missing_or_owner_mismatch" };
    }
    if (this.now > d.proofUntil) return { status: "expired", reason: "dispatch_proof_horizon_expired" };
    if (this.now < d.admittedAt) return { status: "stale", reason: "clock_before_admission" };
    const prior = this.outcomes.get(outcomeId);
    if (prior && prior.expiresAt >= this.now) return { status: "duplicate", reason: "outcome_already_settled" };
    if (d.settledAt !== undefined) return { status: "duplicate", reason: "dispatch_already_settled" };
    if (this.outcomes.size >= CONFIG.maxDedupEntries) return { status: "capacity", reason: "outcome_dedup_capacity" };
    if (kind === "cancelled" && d.lease && !this.liveLease(d, this.now)) {
      return { status: "stale", reason: "lease_owner_or_generation_changed" };
    }
    const staleSuccess = kind === "success" && !!d.lease && !this.liveLease(d, this.now);

    this.prune(this.now);
    const scope = this.scopes.get(d.scopeKey);
    if (kind === "success" && d.lease && !staleSuccess) {
      scope!.generation += 1;
      scope!.failures = [];
      delete scope!.openUntil;
      delete scope!.lease;
      delete scope!.cooldownMultiplier;
    } else if (kind === "cancelled" && d.lease && !staleSuccess) {
      delete scope!.lease;
    } else if (kind === "failure") {
      const admittedTrial = d.lease !== undefined && this.liveLease(d, this.now);
      scope!.generation += 1;
      const cutoff = Math.max(0, this.now - CONFIG.windowMs);
      const failures = [...scope!.failures.filter((f) => f >= cutoff && f <= this.now), this.now].slice(-CONFIG.failureThreshold);
      let openUntil = scope!.openUntil;
      if (admittedTrial) {
        scope!.cooldownMultiplier = Math.min((scope!.cooldownMultiplier ?? 1) * 2, 1_000_000);
        openUntil = Math.max(openUntil ?? 0, this.now + CONFIG.cooldownMs * scope!.cooldownMultiplier);
      } else if (failures.length >= CONFIG.failureThreshold || (openUntil !== undefined && openUntil <= this.now)) {
        openUntil = Math.max(openUntil ?? 0, this.now + CONFIG.cooldownMs);
      }
      scope!.failures = failures;
      if (openUntil !== undefined) scope!.openUntil = openUntil;
      delete scope!.lease;
    }
    d.settledAt = this.now;
    d.settledKind = kind;
    this.outcomes.set(outcomeId, { expiresAt: Math.max(d.proofUntil, this.now + CONFIG.dedupRetentionMs) });
    if (staleSuccess) {
      // A stale success still records settlement; it only releases an expired lease.
      if (d.lease && d.lease.expiresAt <= this.now && scope?.lease?.leaseId === d.lease.leaseId) {
        delete scope.lease;
      }
      this.revision += 1;
      return { status: "stale", reason: "success_did_not_own_current_generation", commits: true };
    }
    this.revision += 1;
    return { status: "settled", commits: true };
  }

  abandon(ownerToken: string, dispatchId: string, outcomeId: string): RefResult {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken || d.outcomeId !== outcomeId) {
      // The pure transition hands back an empty sentinel state, but the store
      // never commits an invalid result, so the durable history is untouched.
      return { status: "invalid", reason: "invalid_abandon_request", commits: false, emptyResult: true };
    }
    if (this.now > d.proofUntil) return { status: "expired", reason: "dispatch_proof_horizon_expired", commits: false };
    if (d.settledAt !== undefined) return { status: "duplicate", reason: "dispatch_already_settled", commits: false };
    if (d.lease && !this.liveLease(d, this.now)) return { status: "stale", reason: "lease_owner_or_generation_changed", commits: false };
    this.prune(this.now);
    const scope = this.scopes.get(d.scopeKey);
    if (d.lease) delete scope!.lease;
    d.settledAt = this.now;
    d.settledKind = "cancelled";
    this.outcomes.set(outcomeId, { expiresAt: Math.max(d.proofUntil, this.now + CONFIG.dedupRetentionMs) });
    this.revision += 1;
    return { status: "abandoned", commits: true };
  }

  // projection ────────────────────────────────────────────────────────────

  /** Independent expected projection of the modeled persisted surface. */
  projection(): unknown {
    return {
      version: 2,
      revision: this.revision,
      scopes: Object.fromEntries([...this.scopes.entries()].map(([k, s]) => [k, {
        generation: s.generation,
        failures: [...s.failures],
        openUntil: s.openUntil ?? null,
        cooldownMultiplier: s.cooldownMultiplier ?? null,
        lease: s.lease ? { ownerToken: s.lease.ownerToken, dispatchId: s.lease.dispatchId, outcomeId: s.lease.outcomeId, leaseId: s.lease.leaseId, generation: s.lease.generation, expiresAt: s.lease.expiresAt, maxExpiresAt: s.lease.maxExpiresAt } : null,
      }])),
      dispatches: Object.fromEntries([...this.dispatches.entries()].map(([k, d]) => [k, {
        key: k,
        dispatchId: k,
        ownerToken: d.ownerToken,
        outcomeId: d.outcomeId,
        admittedAt: d.admittedAt,
        proofUntil: d.proofUntil,
        settledAt: d.settledAt ?? null,
        settledKind: d.settledKind ?? null,
        scopeKey: d.scopeKey,
        scopeGeneration: d.scopeGeneration,
        scopeModelKey: d.modelKey,
        lease: d.lease ? { ownerToken: d.lease.ownerToken, dispatchId: d.lease.dispatchId, outcomeId: d.lease.outcomeId, leaseId: d.lease.leaseId, generation: d.lease.generation, expiresAt: d.lease.expiresAt, maxExpiresAt: d.lease.maxExpiresAt } : null,
      }])),
      settledOutcomes: Object.fromEntries([...this.outcomes.entries()].map(([k, o]) => [k, { expiresAt: o.expiresAt }])),
    };
  }

  /** Model-owned lease references for renew/abandon, derived from the receipt. */
  leaseRefs(dispatchId: string): Array<{ scopeKey: string; generation: number; leaseId: string; expiresAt: number; maxExpiresAt: number }> {
    const d = this.dispatches.get(dispatchId);
    return d ? this.refLease(d) : [];
  }
}

// ── Production projection (independent of the reference) ───────────────────

function productionProjection(state: ReliabilityV2State): unknown {
  return {
    version: state.version,
    revision: state.revision,
    scopes: Object.fromEntries(Object.entries(state.scopes).map(([k, s]) => [k, {
      generation: s.generation,
      failures: [...s.failures],
      openUntil: s.openUntil ?? null,
      cooldownMultiplier: s.cooldownMultiplier ?? null,
      lease: s.lease ? { ownerToken: s.lease.ownerToken, dispatchId: s.lease.dispatchId, outcomeId: s.lease.outcomeId, leaseId: s.lease.leaseId, generation: s.lease.generation, expiresAt: s.lease.expiresAt, maxExpiresAt: s.lease.maxExpiresAt } : null,
    }])),
    dispatches: Object.fromEntries(Object.entries(state.dispatches).map(([k, d]) => [k, {
      key: k,
      dispatchId: d.dispatchId,
      ownerToken: d.ownerToken,
      outcomeId: d.outcomeId,
      admittedAt: d.admittedAt,
      proofUntil: d.proofUntil,
      settledAt: d.settledAt ?? null,
      settledKind: d.settledKind ?? null,
      scopeKey: d.scopes[0]?.scopeKey,
      scopeGeneration: d.scopes[0]?.generation,
      scopeModelKey: d.scopes[0]?.modelKey,
      lease: d.scopes[0]?.leaseId !== undefined
        ? {
          ownerToken: d.ownerToken, dispatchId: d.dispatchId, outcomeId: d.outcomeId,
          leaseId: d.scopes[0].leaseId, generation: d.scopes[0].generation,
          expiresAt: d.scopes[0].expiresAt, maxExpiresAt: d.scopes[0].maxExpiresAt,
        }
        : null,
    }])),
    settledOutcomes: Object.fromEntries(Object.entries(state.settledOutcomes).map(([k, o]) => [k, { expiresAt: o.expiresAt }])),
  };
}

/** Projection of the empty sentinel state a pure transition may return. */
function emptyProjection(): unknown {
  return { version: 2, revision: 0, scopes: {}, dispatches: {}, settledOutcomes: {} };
}

// ── Generated operations ───────────────────────────────────────────────────

type Op =
  | { kind: "advance"; ms: number }
  | { kind: "cooldown"; model: number; ms: number }
  | { kind: "clearCooldown"; model: number }
  | { kind: "admit"; owner: number; dispatch: number; model: number }
  | { kind: "renew"; owner: number; dispatch: number; ttlMs?: number }
  | { kind: "settle"; owner: number; dispatch: number; kind2: "success" | "failure" | "cancelled" }
  | { kind: "settleWrongOutcome"; dispatch: number }
  | { kind: "abandon"; owner: number; dispatch: number }
  | { kind: "duplicateSettle"; dispatch: number };

const ADVANCE = [0, 1, 1000, 30_000, 30_001, 60_000, 119_999, 120_000, 120_001, 300_000];

function toCommand(op: Op): fc.Command<Run, Rng> {
  return {
    check: () => true,
    run: (m, r) => applyOp(m, r, op),
    toString: () => describeOp(op),
  };
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case "advance": return `advance(+${op.ms}ms)`;
    case "cooldown": return `cooldown(${MODELS[op.model]}, +${op.ms}ms)`;
    case "clearCooldown": return `clearCooldown(${MODELS[op.model]})`;
    case "admit": return `admit(${OWNERS[op.owner]}, ${DISPATCHES[op.dispatch]}, ${MODELS[op.model]})`;
    case "renew": return `renew(${OWNERS[op.owner]}, ${DISPATCHES[op.dispatch]}${op.ttlMs === undefined ? "" : `, ttl=${op.ttlMs}`})`;
    case "settle": return `settle(${OWNERS[op.owner]}, ${DISPATCHES[op.dispatch]}, ${op.kind2})`;
    case "settleWrongOutcome": return `settleWrongOutcome(${DISPATCHES[op.dispatch]})`;
    case "abandon": return `abandon(${OWNERS[op.owner]}, ${DISPATCHES[op.dispatch]})`;
    case "duplicateSettle": return `duplicateSettle(${DISPATCHES[op.dispatch]})`;
  }
}

interface Run { state: ReliabilityV2State }
interface Rng { ref: Reference; label: string }

/** Applies one operation to production and to the model, then compares both. */
function applyOp(run: Run, rng: Rng, op: Op): void {
  const { ref } = rng;
  const label = `${rng.label}: ${describeOp(op)}`;
  const now = ref.now;
  let result: { status: string; reason?: string; state: ReliabilityV2State };
  let expected: RefResult;

  switch (op.kind) {
    case "advance":
      ref.now += op.ms;
      return;
    case "cooldown": {
      const modelKey = MODELS[op.model];
      const openUntil = now + op.ms;
      result = setReliabilityV2ScopeCooldown(run.state, modelKey, openUntil, CONFIG, now);
      expected = ref.cooldown(modelKey, openUntil);
      break;
    }
    case "clearCooldown": {
      const modelKey = MODELS[op.model];
      result = clearReliabilityV2ScopeCooldown(run.state, modelKey, CONFIG, now);
      expected = ref.clearCooldown(modelKey);
      break;
    }
    case "admit": {
      const owner = OWNERS[op.owner];
      const dispatchId = DISPATCHES[op.dispatch];
      const modelKey = MODELS[op.model];
      const outcomeId = `${dispatchId}-${owner}`;
      result = admitReliabilityV2Dispatch(run.state, { ownerToken: owner, dispatchId, outcomeId, modelKeys: [modelKey], now }, CONFIG);
      expected = ref.admit(owner, dispatchId, outcomeId, modelKey);
      break;
    }
    case "renew": {
      const owner = OWNERS[op.owner];
      const dispatchId = DISPATCHES[op.dispatch];
      const refs = ref.leaseRefs(dispatchId);
      const outcomeId = ref.dispatches.get(dispatchId)?.outcomeId ?? `${dispatchId}-${owner}`;
      result = renewReliabilityV2Leases(run.state, {
        ownerToken: owner, dispatchId, outcomeId, leaseReferences: refs, now,
        ...(op.ttlMs === undefined ? {} : { ttlMs: op.ttlMs }),
      }, CONFIG);
      expected = ref.renew(owner, dispatchId, outcomeId, op.ttlMs);
      break;
    }
    case "settle": {
      const owner = OWNERS[op.owner];
      const dispatchId = DISPATCHES[op.dispatch];
      const outcomeId = ref.dispatches.get(dispatchId)?.outcomeId ?? `${dispatchId}-${owner}`;
      result = settleReliabilityV2Dispatch(run.state, {
        ownerToken: owner, dispatchId, outcomeId, settlement: { kind: op.kind2 }, now,
      }, CONFIG);
      expected = ref.settle(owner, dispatchId, outcomeId, op.kind2);
      break;
    }
    case "settleWrongOutcome": {
      const dispatchId = DISPATCHES[op.dispatch];
      result = settleReliabilityV2Dispatch(run.state, {
        ownerToken: OWNERS[0], dispatchId, outcomeId: `${dispatchId}-wrong`, settlement: { kind: "success" as const }, now,
      }, CONFIG);
      expected = { status: "stale", reason: "admission_receipt_missing_or_owner_mismatch" };
      break;
    }
    case "abandon": {
      const owner = OWNERS[op.owner];
      const dispatchId = DISPATCHES[op.dispatch];
      const refs = ref.leaseRefs(dispatchId);
      const outcomeId = ref.dispatches.get(dispatchId)?.outcomeId ?? `${dispatchId}-${owner}`;
      result = abandonReliabilityV2Dispatch(run.state, { ownerToken: owner, dispatchId, outcomeId, leaseReferences: refs, now }, CONFIG);
      expected = ref.abandon(owner, dispatchId, outcomeId);
      break;
    }
    case "duplicateSettle": {
      const dispatchId = DISPATCHES[op.dispatch];
      const d = ref.dispatches.get(dispatchId);
      const outcomeId = d?.outcomeId ?? `${dispatchId}-${OWNERS[0]}`;
      result = settleReliabilityV2Dispatch(run.state, {
        ownerToken: d?.ownerToken ?? OWNERS[0], dispatchId, outcomeId, settlement: { kind: "success" as const }, now,
      }, CONFIG);
      // Production prioritises a retained settled outcome over the receipt flag.
      expected = ref.settle(d?.ownerToken ?? OWNERS[0], dispatchId, outcomeId, "success");
      break;
    }
  }

  // P3: reasons are compared unconditionally, so an unexpected reason on an
  // otherwise correct status cannot survive.
  assert.equal(result.status, expected.status, `${label}: status drift`);
  assert.equal(result.reason, expected.reason, `${label}: reason drift`);

  if (expected.emptyResult) {
    // The pure transition returns an empty sentinel for an unusable request.
    // That sentinel is not committed, so the caller must retain the prior
    // effective state; the store contract is asserted separately below.
    assert.deepEqual(
      productionProjection(result.state),
      emptyProjection(),
      `${label}: unusable request must return the empty sentinel state`,
    );
  } else {
    assert.deepEqual(
      productionProjection(result.state),
      ref.projection(),
      `${label}: persisted state drift`,
    );
    run.state = result.state;
  }
}

// ── Scenario runner ────────────────────────────────────────────────────────

/** Builds the oracle used for a run; a faulty model is injected by control only. */
type ModelFactory = () => Reference;

function runScenario(commands: Iterable<fc.Command<Run, Rng>>, model: ModelFactory = () => new Reference()): void {
  const rng: Rng = { ref: model(), label: "scenario" };
  fc.modelRun(() => ({ model: { state: emptyReliabilityV2State() }, real: rng }), commands);
}

/**
 * Faulty model control: it forgets to advance the scope generation on a
 * failure settlement, so it drifts from production on the first such step.
 */
function faultyGenerationModel(): Reference {
  const model = new Reference();
  const settle = model.settle.bind(model);
  model.settle = (ownerToken, dispatchId, outcomeId, kind) => {
    const result = settle(ownerToken, dispatchId, outcomeId, kind);
    if (kind === "failure") {
      const d = model.dispatches.get(dispatchId);
      const scope = d ? model.scopes.get(d.scopeKey) : undefined;
      if (scope && scope.generation > 0) scope.generation -= 1;
    }
    return result;
  };
  return model;
}

const SEQUENCE_SEED = 20260101;
const SWEEP_SEED = 20260102;
const FAULT_SEED = 20260103;

function scenarioCommands(maxCommands: number, replayPath?: string): fc.Arbitrary<Iterable<fc.Command<Run, Rng>>> {
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constantFrom(...ADVANCE).map((ms) => ({ kind: "advance" as const, ms })),
    fc.tuple(fc.nat({ max: MODELS.length - 1 }), fc.constantFrom(...ADVANCE)).map(([model, ms]) => ({ kind: "cooldown" as const, model, ms })),
    fc.nat({ max: MODELS.length - 1 }).map((model) => ({ kind: "clearCooldown" as const, model })),
    fc.tuple(fc.nat({ max: OWNERS.length - 1 }), fc.nat({ max: DISPATCHES.length - 1 }), fc.nat({ max: MODELS.length - 1 })).map(([owner, dispatch, model]) => ({ kind: "admit" as const, owner, dispatch, model })),
    fc.tuple(fc.nat({ max: OWNERS.length - 1 }), fc.nat({ max: DISPATCHES.length - 1 })).map(([owner, dispatch]) => ({ kind: "renew" as const, owner, dispatch })),
    fc.tuple(fc.nat({ max: OWNERS.length - 1 }), fc.nat({ max: DISPATCHES.length - 1 }), fc.integer({ min: 1, max: CONFIG.leaseTtlMs })).map(([owner, dispatch, ttlMs]) => ({ kind: "renew" as const, owner, dispatch, ttlMs })),
    fc.tuple(fc.nat({ max: OWNERS.length - 1 }), fc.nat({ max: DISPATCHES.length - 1 }), fc.constantFrom("success", "failure", "cancelled")).map(([owner, dispatch, kind2]) => ({ kind: "settle" as const, owner, dispatch, kind2 })),
    fc.nat({ max: DISPATCHES.length - 1 }).map((dispatch) => ({ kind: "settleWrongOutcome" as const, dispatch })),
    fc.tuple(fc.nat({ max: OWNERS.length - 1 }), fc.nat({ max: DISPATCHES.length - 1 })).map(([owner, dispatch]) => ({ kind: "abandon" as const, owner, dispatch })),
    fc.nat({ max: DISPATCHES.length - 1 }).map((dispatch) => ({ kind: "duplicateSettle" as const, dispatch })),
  );
  return fc.commands(Array.from({ length: 10 }, () => opArb.map(toCommand)), { maxCommands, ...(replayPath ? { replayPath } : {}) });
}

describe("reliability v2 state machine", () => {
  it("matches the independent model across generated operation sequences", () => {
    fc.assert(fc.property(scenarioCommands(25), (commands) => runScenario(commands)), { seed: SEQUENCE_SEED, numRuns: 500 });
  });

  it("matches the independent model across a wider generated sample", () => {
    fc.assert(fc.property(scenarioCommands(12), (commands) => runScenario(commands)), { seed: SWEEP_SEED, numRuns: 400 });
  });

  it("matches the independent model with the campaign default seed", (t) => {
    const result = fc.check(fc.property(scenarioCommands(25), (commands) => runScenario(commands)), { numRuns: 500 });
    assert.equal(result.failed, false, fc.defaultReportMessage(result) ?? "the exploratory model must match");
    if (process.env.FC_SEED !== undefined && process.env.FC_SEED !== "") {
      assert.equal(result.seed, Number(process.env.FC_SEED), "campaign seed must drive the exploratory sample");
    }
    t.diagnostic(`campaign exploratory seed=${result.seed}`);
  });

  it("releases an expired receipt lease when pruning during unrelated admission", () => {
    // Reviewer sequence: cooldown model 0 +1000; advance 1000; admit owner-a/d1/model 0
    // (half-open trial); advance 120001 (past the receipt proof horizon); admit owner-b/d2/model 1.
    const first = MODELS[0];
    const second = MODELS[1];
    const firstScope = scopeKeyOf(first);
    const ref = new Reference();
    let state = emptyReliabilityV2State();

    ref.now = ORIGIN;
    state = setReliabilityV2ScopeCooldown(state, first, ORIGIN + 1000, CONFIG, ORIGIN).state;
    assert.equal(ref.cooldown(first, ORIGIN + 1000).status, "settled");

    ref.now = ORIGIN + 1000;
    let result = admitReliabilityV2Dispatch(state, {
      ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", modelKeys: [first], now: ORIGIN + 1000,
    }, CONFIG);
    assert.equal(result.status, ref.admit(OWNERS[0], "d1", "d1-owner-a", first).status);
    state = result.state;
    assert.equal(state.scopes[firstScope]!.lease!.leaseId, "d1", "the trial must be leased before the prune");

    // Prune runs during this unrelated admission and must free the dead lease.
    ref.now = ORIGIN + 121001;
    result = admitReliabilityV2Dispatch(state, {
      ownerToken: OWNERS[1], dispatchId: "d2", outcomeId: "d2-owner-b", modelKeys: [second], now: ORIGIN + 121001,
    }, CONFIG);
    assert.equal(result.status, ref.admit(OWNERS[1], "d2", "d2-owner-b", second).status);
    state = result.state;

    assert.equal(state.scopes[firstScope]!.lease, undefined, "pruning must release the expired receipt lease");
    assert.equal(state.dispatches["d1"], undefined, "pruning must drop the expired receipt");
    assert.ok(state.dispatches["d2"], "the unrelated receipt must survive the prune");
    assert.deepEqual(productionProjection(state), ref.projection(), "pruned state must match the model");
  });

  it("keeps durable history after an invalid owner operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-v2-history-"));
    try {
      const path = join(dir, "v2.json");
      let clock = ORIGIN;
      const store = new ReliabilityV2Store({ path, config: CONFIG, now: () => clock });
      await store.setScopeCooldown(MODELS[0], ORIGIN + 1000);
      clock = ORIGIN + 1000;
      const admitted = await store.admit({
        ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", modelKeys: [MODELS[0]],
      });
      assert.equal(admitted.status, "admitted");

      // A wrong owner must be refused without disturbing the durable state.
      clock = ORIGIN + 2000;
      const wrong = await store.renew({
        ownerToken: OWNERS[1], dispatchId: "d1", outcomeId: "d1-owner-a",
        leaseReferences: admitted.leases ?? [],
      });
      assert.equal(wrong.status, "invalid");
      assert.equal(wrong.reason, "invalid_lease_renewal");
      const afterInvalid = new ReliabilityV2Store({ path, config: CONFIG, now: () => clock }).readSnapshot();
      assert.deepEqual(Object.keys(afterInvalid.dispatches), ["d1"], "a refused operation must preserve the receipt");
      assert.equal(afterInvalid.revision, admitted.state.revision, "a refused operation must not advance the revision");

      // The real owner must still renew and settle its own trial afterwards.
      clock = ORIGIN + 3000;
      const renewed = await store.renew({
        ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a",
        leaseReferences: admitted.leases ?? [],
      });
      assert.equal(renewed.status, "renewed");
      clock = ORIGIN + 4000;
      const settled = await store.settle({
        ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", settlement: { kind: "success" },
      });
      assert.equal(settled.status, "settled");
      const final = new ReliabilityV2Store({ path, config: CONFIG, now: () => clock }).readSnapshot();
      assert.equal(final.dispatches["d1"]!.settledKind, "success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shrinks and replays a faulty model control to a minimal sequence", () => {
    const faulty = fc.property(scenarioCommands(12), (commands) => runScenario(commands, faultyGenerationModel));
    const rejected = fc.check(faulty, { seed: FAULT_SEED, numRuns: 400 });
    assert.equal(rejected.failed, true, "a faulty model must be rejected by the comparison");
    assert.ok(rejected.numShrinks > 0, "the faulty control must shrink to a minimal sequence");
    assert.ok((rejected.counterexamplePath ?? "").length > 0, "a rejected control must report a replay path");
    assert.ok(rejected.counterexample, "the rejected control must report its counterexample");

    // The reported seed and path must replay to the same shrunk sequence.
    const replayPath = String(rejected.counterexample[0]).match(/replayPath="([^"]+)"/)?.[1];
    assert.ok(replayPath, "generated commands must expose their replay path");
    const replay = fc.check(
      fc.property(scenarioCommands(12, replayPath), (commands) => runScenario(commands, faultyGenerationModel)),
      { seed: rejected.seed, path: rejected.counterexamplePath ?? undefined, numRuns: 400 },
    );
    assert.equal(replay.failed, true, "the replayed seed and path must still fail");
    assert.equal(replay.counterexamplePath, rejected.counterexamplePath, "replay must reproduce the same path");
    assert.deepEqual(
      [...replay.counterexample![0]].map(String),
      [...rejected.counterexample[0]].map(String),
      "the replayed seed and path must reproduce the same shrunk operation sequence",
    );

    // The unmutated model accepts exactly the same operations.
    assert.doesNotThrow(
      () => runScenario(rejected.counterexample![0]),
      "the production machine must accept the sequence that rejected the faulty model",
    );
  });

  it("predicts exact half-open lease expiry boundaries", () => {
    const modelKey = MODELS[0];
    const scopeKey = scopeKeyOf(modelKey);
    const model = new Reference();
    const ref = model;
    let state = emptyReliabilityV2State();

    // Open, then admit exactly at the half-open edge.
    state = setReliabilityV2ScopeCooldown(state, modelKey, ORIGIN, CONFIG, ORIGIN - 1000).state;
    ref.now = ORIGIN - 1000;
    ref.cooldown(modelKey, ORIGIN);
    ref.now = ORIGIN;
    const admitted = admitReliabilityV2Dispatch(state, {
      ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", modelKeys: [modelKey], now: ORIGIN,
    }, CONFIG);
    assert.equal(admitted.status, "admitted");
    assert.equal(ref.admit(OWNERS[0], "d1", "d1-owner-a", modelKey).status, "admitted");
    const lease = admitted.state.scopes[scopeKey]!.lease!;
    assert.equal(lease.expiresAt, ORIGIN + CONFIG.leaseTtlMs);
    assert.equal(lease.maxExpiresAt, ORIGIN + CONFIG.maxDispatchLifetimeMs);

    // One millisecond before lease expiry the lease is still owned; at the edge it is not.
    const before = ORIGIN + CONFIG.leaseTtlMs - 1;
    const atEdge = ORIGIN + CONFIG.leaseTtlMs;
    for (const [now, owned] of [[before, true], [atEdge, false]] as const) {
      const res = settleReliabilityV2Dispatch(admitted.state, {
        ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", settlement: { kind: "cancelled" as const }, now,
      }, CONFIG);
      if (owned) assert.equal(res.status, "settled", `cancel at ${now} should be settled`);
      else assert.equal(res.status, "stale", `cancel at ${now} should be stale`);
    }
  });

  it("continues meaningful operations after a real v2 store restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-v2-restart-"));
    try {
      const path = join(dir, "v2.json");
      const ref = new Reference();
      const modelKey = MODELS[0];
      const store = new ReliabilityV2Store({ path, config: CONFIG, now: () => ref.now });

      // Seed: an open cooldown, then a half-open trial that is admitted.
      ref.now = ORIGIN;
      const cooled = await store.setScopeCooldown(modelKey, ORIGIN + 1000);
      assert.equal(cooled.status, "settled");
      ref.cooldown(modelKey, ORIGIN + 1000);

      ref.now = ORIGIN + 1000;
      const admitted = await store.admit({ ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", modelKeys: [modelKey] });
      assert.equal(admitted.status, "admitted");
      ref.admit(OWNERS[0], "d1", "d1-owner-a", modelKey);

      // Restart: a fresh store reads the durable state.
      const restarted = new ReliabilityV2Store({ path, config: CONFIG, now: () => ref.now });
      const snapshot = restarted.readSnapshot();
      assert.deepEqual(productionProjection(snapshot), ref.projection(), "restarted durable state must match the model");

      // Continue a meaningful renewal on the restarted store, against the model.
      const refs = ref.leaseRefs("d1");
      ref.now = ORIGIN + 2000;
      const renewed = await restarted.renew({
        ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", leaseReferences: refs,
      });
      assert.equal(renewed.status, "renewed");
      assert.equal(ref.renew(OWNERS[0], "d1", "d1-owner-a").status, "renewed");
      assert.deepEqual(productionProjection(renewed.state), ref.projection(), "renewed durable state must match the model");

      // Continue a settlement on the restarted store.
      ref.now = ORIGIN + 3000;
      const settled = await restarted.settle({ ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", settlement: { kind: "success" as const } });
      assert.equal(settled.status, "settled");
      assert.equal(ref.settle(OWNERS[0], "d1", "d1-owner-a", "success").status, "settled");
      assert.deepEqual(productionProjection(settled.state), ref.projection(), "settled durable state must match the model");

      // The final durable state on disk equals the model projection.
      const finalStore = new ReliabilityV2Store({ path, config: CONFIG, now: () => ref.now });
      assert.deepEqual(productionProjection(finalStore.readSnapshot()), ref.projection(), "final durable state must match the model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Controlled fault sensitivity ───────────────────────────────────────────
//
// Each fault rewrites a private scratch copy of the production transition
// source, runs the same oracle comparison against it, and requires the
// comparison to fail on the intended assertion. The scratch copy is deleted,
// so production source is never mutated.

interface FaultPlan {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

const FAULTS: readonly FaultPlan[] = [
  {
    name: "settleFailureSkipsGenerationBump",
    from: "      const generation = increment(previous.generation);\n      if (generation === undefined) return noChange(\"overflow\", \"scope_generation_overflow\", checked.state);\n      const failures = [...recentFailures(previous, checked.now, checked.config.windowMs), checked.now]",
    to: "      const generation = previous.generation;\n      const failures = [...recentFailures(previous, checked.now, checked.config.windowMs), checked.now]",
  },
  {
    name: "leaseMaximumLifetimeIgnored",
    from: "  if (refs.some((reference) => now >= reference.maxExpiresAt)) return noChange(\"expired\", \"maximum_dispatch_lifetime_expired\", checked.state);",
    to: "  if (refs.some((reference) => now >= reference.maxExpiresAt && false)) return noChange(\"expired\", \"maximum_dispatch_lifetime_expired\", checked.state);",
  },
  {
    name: "settledOutcomeDedupLedgerDropped",
    from: "  next.settledOutcomes[receipt.outcomeId] = {\n    expiresAt: expiry,\n    ...(observation === undefined ? {} : { observation }),\n  };",
    to: "  void expiry;\n  void observation;",
  },
  {
    // Reviewer mutant that previously survived every submitted test.
    name: "revisionSkipsTwo",
    from: "function commit(state: ReliabilityV2State): ReliabilityV2State | undefined {\n  const revision = increment(state.revision);",
    to: "function commit(state: ReliabilityV2State): ReliabilityV2State | undefined {\n  const revision = increment(state.revision + 1);",
  },
  {
    // Reviewer mutant that previously survived every submitted test.
    name: "unexpectedAdmissionReason",
    from: "  return committed\n    ? { status: \"admitted\", state: committed, leases: leaseReferences(next.dispatches[dispatchId]!) }",
    to: "  return committed\n    ? { status: \"admitted\", state: committed, reason: \"unexpected_reason\", leases: leaseReferences(next.dispatches[dispatchId]!) }",
  },
];

const PRODUCTION_SOURCE = new URL("../reliability-v2.ts", import.meta.url);

/** Writes a faulted private copy of the production module into scratch. */
async function loadFaultedModule(fault: FaultPlan, dir: string): Promise<typeof import("../reliability-v2.ts")> {
  const original = readFileSync(PRODUCTION_SOURCE, "utf8");
  assert.ok(original.includes(fault.from), `fault anchor for ${fault.name} no longer matches the production source`);
  const faulted = original
    .replace(fault.from, fault.to)
    // Repoint the sibling import so the scratch copy resolves the real helpers.
    .replace('from "./failure-observations.ts"', `from ${JSON.stringify(fileURLToPath(new URL("../failure-observations.ts", import.meta.url)))}`);
  assert.notEqual(faulted, original, `fault ${fault.name} must actually change the source`);
  const file = join(dir, `faulted-${fault.name}.ts`);
  writeFileSync(file, faulted, "utf8");
  return import(pathToFileURL(file).href) as Promise<typeof import("../reliability-v2.ts")>;
}

/** Runs one fixed scenario against a module and returns the model's projection. */
function runFixedScenario(v2: typeof import("../reliability-v2.ts")): unknown {
  const modelKey = MODELS[0];
  const ref = new Reference();
  let state = v2.emptyReliabilityV2State();

  ref.now = ORIGIN;
  state = v2.setReliabilityV2ScopeCooldown(state, modelKey, ORIGIN + 1000, CONFIG, ORIGIN).state;
  ref.cooldown(modelKey, ORIGIN + 1000);

  ref.now = ORIGIN + 1000;
  let result = v2.admitReliabilityV2Dispatch(state, {
    ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", modelKeys: [modelKey], now: ORIGIN + 1000,
  }, CONFIG);
  const admitted = ref.admit(OWNERS[0], "d1", "d1-owner-a", modelKey);
  // Status AND reason are compared unconditionally, so an unexpected reason on a
  // correct status cannot survive.
  assert.equal(result.status, admitted.status, "half-open admission status");
  assert.equal(result.reason, admitted.reason, "half-open admission reason");
  assert.deepEqual(productionProjection(result.state), ref.projection(), "half-open admission state");
  state = result.state;

  // Renew exactly at the maximum dispatch lifetime: production must refuse.
  ref.now = ORIGIN + 1000 + CONFIG.maxDispatchLifetimeMs;
  const refs = ref.leaseRefs("d1");
  result = v2.renewReliabilityV2Leases(state, {
    ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", leaseReferences: refs, now: ref.now,
  }, CONFIG);
  const expectedRenew = ref.renew(OWNERS[0], "d1", "d1-owner-a");
  assert.equal(result.status, expectedRenew.status, "renewal at maximum lifetime status");
  assert.equal(result.reason, expectedRenew.reason, "renewal at maximum lifetime reason");

  // Settle the trial as a failure, then settle the same dispatch again.
  ref.now = ORIGIN + 2000;
  result = v2.settleReliabilityV2Dispatch(state, {
    ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", settlement: { kind: "failure" }, now: ref.now,
  }, CONFIG);
  const expectedSettle = ref.settle(OWNERS[0], "d1", "d1-owner-a", "failure");
  assert.equal(result.status, expectedSettle.status, "failure settlement status");
  assert.deepEqual(productionProjection(result.state), ref.projection(), "failure settlement state");

  const beforeDouble = result.state;
  const expectedDouble = ref.settle(OWNERS[0], "d1", "d1-owner-a", "failure");
  result = v2.settleReliabilityV2Dispatch(beforeDouble, {
    ownerToken: OWNERS[0], dispatchId: "d1", outcomeId: "d1-owner-a", settlement: { kind: "failure" }, now: ref.now,
  }, CONFIG);
  assert.equal(result.status, expectedDouble.status, "double settlement status");
  assert.deepEqual(productionProjection(result.state), ref.projection(), "double settlement state");

  return productionProjection(result.state);
}

describe("reliability v2 controlled fault sensitivity", () => {
  it("accepts the unmodified production transitions", () => {
    assert.doesNotThrow(() => runFixedScenario(v2Production), "the real production module must satisfy the oracle");
  });

  for (const fault of FAULTS) {
    it(`rejects the ${fault.name} control`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "bifrost-v2-fault-"));
      try {
        const faulted = await loadFaultedModule(fault, dir);
        assert.throws(
          () => runFixedScenario(faulted),
          assert.AssertionError,
          `controlled fault ${fault.name} went undetected`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});