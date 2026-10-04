import { dispatchTrialPolicy, type DispatchIntent } from "./virtual-routing.ts";

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
  reason: string | undefined;
}

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
  private pending = new Map<string, string | undefined>();

  begin(selectedModel: string): void {
    if (!this.pending.has(selectedModel)) this.pending.set(selectedModel, undefined);
  }

  /** Drop one dispatch (e.g. dispatch bookkeeping failed before the request). */
  release(selectedModel: string): void {
    this.pending.delete(selectedModel);
  }

  observe(messages: readonly AssistantOutcome[]): void {
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
      this.pending.set(
        model,
        last.stopReason === "error"
          ? (typeof last.errorMessage === "string" ? last.errorMessage : "provider request failed")
          : undefined,
      );
    }
  }

  /** Returns every dispatch on both success and failure. reason undefined = clean settle. */
  settle(): RuntimeFailure[] {
    const settled = [...this.pending.entries()].map(([model, reason]) => ({ model, reason }));
    this.pending.clear();
    return settled;
  }
}
