interface AssistantOutcome {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function modelKey(message: AssistantOutcome): string | undefined {
  if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
  return `${message.provider}/${message.model}`;
}

/** Tracks one Bifrost-routed agent run across Pi's internal retries. */
export interface RuntimeFailure {
  model: string;
  reason?: string;
  aborted?: boolean;
  unknown?: boolean;
}

export class RuntimeReliabilityTracker {
  private selectedModel: string | undefined;
  private pendingFailure: string | undefined;
  private pendingAborted = false;
  private pendingObserved = false;

  begin(selectedModel: string): void {
    this.selectedModel = selectedModel;
    this.pendingFailure = undefined;
    this.pendingAborted = false;
    this.pendingObserved = false;
  }

  observe(messages: readonly AssistantOutcome[]): void {
    if (!this.selectedModel) return;
    let last: AssistantOutcome | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && modelKey(message) === this.selectedModel) {
        last = message;
        break;
      }
    }
    if (!last) return;
    this.pendingObserved = true;
    this.pendingAborted = last.stopReason === "aborted";
    this.pendingFailure = last.stopReason === "error" ? "provider_error" : undefined;
  }

  /** Return the selected model, including an unobserved terminal outcome. */
  settle(): RuntimeFailure | undefined {
    const failure = this.pendingFailure;
    const aborted = this.pendingAborted;
    const observed = this.pendingObserved;
    const model = this.selectedModel;
    this.selectedModel = undefined;
    this.pendingFailure = undefined;
    this.pendingAborted = false;
    this.pendingObserved = false;
    if (!model) return undefined;
    if (aborted) return { model, aborted: true };
    if (failure) return { model, reason: failure };
    return observed ? { model, reason: undefined } : { model, unknown: true };
  }

  /** Clear a stale run during a session switch and return its model. */
  discard(): string | undefined {
    const model = this.selectedModel;
    this.selectedModel = undefined;
    this.pendingFailure = undefined;
    this.pendingAborted = false;
    this.pendingObserved = false;
    return model;
  }
}
