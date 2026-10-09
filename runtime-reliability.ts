import { dispatchTrialPolicy, type DispatchIntent } from "./virtual-routing.ts";
import type { FailureObservation } from "./failure-observations.ts";

interface AssistantOutcome {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function outcomeModelKey(message: AssistantOutcome): string | undefined {
  if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
  return `${message.provider}/${message.model}`;
}

/** Tracks one Bifrost-routed agent run across Pi's internal retries. */
export interface RuntimeFailure {
  model: string;
  outcome: "success" | "failure" | "abandoned";
  reason?: string;
  failureObservation?: FailureObservation;
}

const SUCCESS_STOP_REASONS = new Set(["stop", "length", "toolUse"]);

/** Result of a half-open trial claim attempt. */
export interface TrialClaim {
  allowed: boolean;
  claimed: boolean;
}

/**
 * Per-request dispatch ownership. A dispatch releases only the trial claim and
 * ledger entry it recorded itself — onDispatchFailed can never steal another
 * dispatch's bookkeeping for the same model.
 */
export interface DispatchOwnershipDeps {
  claimTrial: (modelKey: string) => TrialClaim;
  abandonTrial: (modelKey: string) => void;
  begin: (modelKey: string) => void;
  release: (modelKey: string) => void;
}

export function createDispatchOwnership(deps: DispatchOwnershipDeps) {
  let ownedTrialKey: string | undefined;
  let begunKey: string | undefined;
  return {
    claim(modelKey: string, intent: DispatchIntent, onTrial?: (claim: TrialClaim) => void): TrialClaim {
      const trial = deps.claimTrial(modelKey);
      onTrial?.(trial);
      if (trial.claimed) ownedTrialKey = modelKey;
      // Sticky/degrade are documented continuity exceptions; only an explicit
      // selection is fail-closed on trial contention.
      if (!trial.allowed && dispatchTrialPolicy(intent) === "fail-closed") {
        throw new Error(`Bifrost: half-open trial unavailable for ${modelKey}`);
      }
      deps.begin(modelKey);
      begunKey = modelKey;
      return trial;
    },
    fail(modelKey: string): void {
      if (begunKey === modelKey) {
        deps.release(modelKey);
        begunKey = undefined;
      }
      if (ownedTrialKey === modelKey) {
        deps.abandonTrial(modelKey);
        ownedTrialKey = undefined;
      }
    },
  };
}

/**
 * Ledger of models dispatched within one agent run. One run can dispatch
 * several models (queued user turns drain before one agent_settled), so a
 * single slot would lose ownership of earlier claimed half-open trials and
 * wedge them. Every dispatched model settles individually.
 */
export class RuntimeReliabilityTracker {
  private pending = new Map<string, RuntimeFailure>();

  begin(selectedModel: string): void {
    // A newer dispatch must not inherit an earlier success if it later settles
    // without a matching assistant response. Same-model dispatch IDs remain a
    // separate ledger concern; this model-keyed tracker fails conservatively.
    this.pending.set(selectedModel, { model: selectedModel, outcome: "abandoned" });
  }

  /** Drop one dispatch (e.g. dispatch bookkeeping failed before the request). */
  release(selectedModel: string): void {
    this.pending.delete(selectedModel);
  }

  observe(
    messages: readonly AssistantOutcome[],
    classifyFailure?: (model: string, message: AssistantOutcome) => FailureObservation | undefined,
  ): void {
    for (const model of this.pending.keys()) {
      let last: AssistantOutcome | undefined;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === "assistant" && outcomeModelKey(message) === model) {
          last = message;
          break;
        }
      }
      if (!last) continue;
      if (last.stopReason === "error") {
        let failureObservation: FailureObservation | undefined;
        try {
          const candidate = classifyFailure?.(model, last);
          if (candidate?.modelKey === model && candidate.category === "allowance_exhausted"
            && candidate.source === "runtime" && candidate.scope.kind === "model"
            && candidate.scope.modelKey === model) failureObservation = candidate;
        } catch { /* failure classification cannot change host settlement */ }
        this.pending.set(model, {
          model,
          outcome: "failure",
          reason: "provider request failed",
          ...(failureObservation ? { failureObservation } : {}),
        });
      } else if (typeof last.stopReason === "string" && SUCCESS_STOP_REASONS.has(last.stopReason)) {
        this.pending.set(model, { model, outcome: "success" });
      } else {
        this.pending.set(model, { model, outcome: "abandoned" });
      }
    }
  }

  /** Returns each tracked model with explicit success, failure, or abandonment. */
  settle(): RuntimeFailure[] {
    const settled = [...this.pending.values()];
    this.pending.clear();
    return settled;
  }
}
