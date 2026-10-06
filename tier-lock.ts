/** Cross-extension tier lock over `pi.events`, for callers such as plan mode that must stay on one tier. */

export const BIFROST_LOCK_EVENT = "bifrost:lock";
export const BIFROST_RELEASE_EVENT = "bifrost:release";

export interface TierLock {
  readonly tier: string;
  readonly owner: string;
}

export type PinSource = "manual" | "delegate";

export type LockReply =
  | { readonly ok: true; readonly tier: string; readonly model?: string }
  | { readonly ok: false; readonly reason: string };

export type ReleaseReply = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LockRequest extends TierLock {
  readonly reply?: (result: LockReply) => void;
}

export interface ReleaseRequest {
  readonly owner: string;
  readonly reply?: (result: ReleaseReply) => void;
}

export interface LockState {
  readonly enabled: boolean;
  readonly pinned: boolean;
  readonly pinSource?: PinSource;
  readonly lock?: TierLock;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function replyFn<T>(value: unknown): ((result: T) => void) | undefined {
  return typeof value === "function" ? (value as (result: T) => void) : undefined;
}

export function parseLockRequest(data: unknown): LockRequest | { readonly invalid: string; readonly reply?: (result: LockReply) => void } {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const reply = replyFn<LockReply>(record.reply);
  if (!nonEmptyString(record.tier)) return { invalid: "lock request needs a tier", reply };
  if (!nonEmptyString(record.owner)) return { invalid: "lock request needs an owner", reply };
  return { tier: record.tier, owner: record.owner, reply };
}

export function parseReleaseRequest(data: unknown): ReleaseRequest | { readonly invalid: string; readonly reply?: (result: ReleaseReply) => void } {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const reply = replyFn<ReleaseReply>(record.reply);
  if (!nonEmptyString(record.owner)) return { invalid: "release request needs an owner", reply };
  return { owner: record.owner, reply };
}

/** Decide whether a lock can be taken. A new lock clears a manual pin but never a delegate pin. */
export function acquireLock(state: LockState, request: TierLock, tiers: readonly string[]):
  | { readonly ok: true; readonly next: LockState }
  | { readonly ok: false; readonly reason: string } {
  if (!state.enabled) return { ok: false, reason: "Bifrost routing is off" };
  if (state.pinSource === "delegate") return { ok: false, reason: "delegate sessions stay pinned to the model they were launched with" };
  if (!tiers.includes(request.tier)) return { ok: false, reason: `unknown tier "${request.tier}"` };
  if (state.lock && state.lock.owner !== request.owner) {
    return { ok: false, reason: `tier is locked to ${state.lock.tier} by ${state.lock.owner}` };
  }
  return {
    ok: true,
    next: { ...state, pinned: false, pinSource: undefined, lock: { tier: request.tier, owner: request.owner } },
  };
}

export function releaseLock(state: LockState, owner: string):
  | { readonly ok: true; readonly next: LockState }
  | { readonly ok: false; readonly reason: string } {
  if (!state.lock) return { ok: true, next: state };
  if (state.lock.owner !== owner) return { ok: false, reason: `lock is held by ${state.lock.owner}` };
  return { ok: true, next: { ...state, lock: undefined } };
}

/** ACP marks every delegate child with PI_ACP_DELEGATE_DEPTH >= 1. */
export function isDelegateSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const depth = Number(env.PI_ACP_DELEGATE_DEPTH ?? "0");
  return Number.isFinite(depth) && depth >= 1;
}
