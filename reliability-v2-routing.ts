import {
  validateReliabilityV2State,
  type ReliabilityV2Config,
  type ReliabilityV2Scope,
  type ReliabilityV2State,
} from "./reliability-v2.ts";
import type { ReliabilityState } from "./reliability.ts";

const MAX_EPOCH = 8.64e15;

function immutableCopy(state: ReliabilityState): Readonly<ReliabilityState> {
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(state);
  return state;
}

function isLiveLease(scope: ReliabilityV2Scope, now: number): boolean {
  const lease = scope.lease;
  return !!lease && lease.expiresAt > now && lease.generation === scope.generation;
}

/** Project validated v2 state to a frozen, model-only v1 circuit view for advisory routing. */
export function projectReliabilityV2ForRouting(
  stateValue: unknown,
  config: ReliabilityV2Config,
  now: number,
): Readonly<ReliabilityState> {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_EPOCH
    || !validateReliabilityV2State(stateValue, config)) {
    throw new Error("Invalid reliability v2 routing snapshot.");
  }
  const state = stateValue as ReliabilityV2State;
  const models: ReliabilityState["models"] = Object.create(null) as ReliabilityState["models"];
  for (const [scopeKey, scope] of Object.entries(state.scopes)) {
    const match = /^model:(\d+):(.+)$/.exec(scopeKey);
    const model = match?.[2];
    if (!model || Number(match?.[1]) !== model.length) throw new Error("Invalid reliability v2 model scope key.");
    models[model] = {
      failures: [...scope.failures],
      ...(scope.openUntil === undefined ? {} : { openUntil: scope.openUntil }),
      ...(scope.cooldownMultiplier === undefined ? {} : { cooldownMultiplier: scope.cooldownMultiplier }),
      trialActive: isLiveLease(scope, now),
    };
  }
  return immutableCopy({ version: 1, models });
}
