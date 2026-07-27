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
}

export class RuntimeReliabilityTracker {
  private selectedModel: string | undefined;
  private pendingFailure: string | undefined;

  begin(selectedModel: string): void {
    this.selectedModel = selectedModel;
    this.pendingFailure = undefined;
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
    this.pendingFailure = last.stopReason === "error"
      ? (typeof last.errorMessage === "string" ? last.errorMessage : "provider request failed")
      : undefined;
  }

  /** Returns model on both success and failure. reason undefined = clean settle. */
  settle(): RuntimeFailure | undefined {
    const failure = this.pendingFailure;
    const model = this.selectedModel;
    this.selectedModel = undefined;
    this.pendingFailure = undefined;
    if (!model) return undefined;
    return { model, reason: failure };
  }
}
