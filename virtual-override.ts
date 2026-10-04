// Input runs before Pi queues/creates user messages; virtual route() runs when
// a message is dispatched. Hold only turn-local text. Steering messages take
// priority over follow-ups, matching Pi's delivery order.
//
// Matching: trimmed exact text, best delivery priority, FIFO within priority.
// Unrelated or transform-mutated text consumes nothing and never errors — the
// dispatch decision degrades to normal classification instead. Entries that
// never route are dropped at session_start and agent_settled. Nothing is
// persisted.
// Identity limit (accepted residual): no turn id exists on input events, so
// two queued prompts with identical stripped text but different tiers resolve
// in queue order. A transform-mutated dispatch can also leak its entry to a
// later identical prompt (a failed match consumes nothing); such a mis-tier is
// visible in the "Bifrost auto:" decision line.
//
// Consume-then-fail (documented residual, issue #17): take() consumes the
// matched entry before dispatch, so a select() failure loses that turn's hint.
// No re-consumption path needs protection: prompts are never replayed, Pi's
// retry/continuation dispatches are sticky and never read overrides, and a
// re-sent prompt re-enters through input with a fresh entry.
type Delivery = "steer" | "followUp" | undefined;

function priorityRank(delivery: Delivery): number {
  return delivery === undefined ? 0 : delivery === "steer" ? 1 : 2;
}

export class VirtualOverride {
  private pending: { tier?: string; prompt: string; delivery: Delivery }[] = [];

  prepare(tier: string | undefined, prompt: string, delivery?: Delivery): void {
    this.pending.push({ tier, prompt: prompt.trim(), delivery });
  }

  /** Consume the best matching entry; unknown text consumes nothing. */
  take(prompt: string): string | undefined {
    const text = prompt.trim();
    let match = -1;
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending[i].prompt !== text) continue;
      if (match === -1 || priorityRank(this.pending[i].delivery) < priorityRank(this.pending[match].delivery)) {
        match = i;
      }
    }
    if (match === -1) return undefined;
    return this.pending.splice(match, 1)[0].tier;
  }

  clear(): void {
    this.pending = [];
  }
}
