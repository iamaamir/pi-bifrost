// Input runs before Pi queues/creates user messages; virtual route() runs when
// message is dispatched. Hold only turn-local text. Steering messages take
// priority over follow-ups, matching Pi's delivery order.
// Identity limit (accepted residual): matching is (delivery priority, FIFO,
// exact stripped text) — no turn id exists on input events. Two queued prompts
// with identical stripped text but different tiers resolve in queue order;
// different raw text stripping to the same prompt is the theoretical
// misassociation case. Nothing is persisted.
type Delivery = "steer" | "followUp" | undefined;

export class VirtualOverride {
  private pending: { tier?: string; prompt: string; delivery: Delivery }[] = [];

  prepare(tier: string | undefined, prompt: string, delivery?: Delivery): void {
    this.pending.push({ tier, prompt, delivery });
  }

  take(prompt: string): string | undefined {
    const priority = (delivery: Delivery) => delivery === undefined ? 0 : delivery === "steer" ? 1 : 2;
    let next = 0;
    for (let i = 1; i < this.pending.length; i++) {
      if (priority(this.pending[i].delivery) < priority(this.pending[next].delivery)) next = i;
    }
    const pending = this.pending.splice(next, 1)[0];
    if (!pending) return undefined;
    if (pending.prompt !== prompt) {
      this.clear();
      throw new Error("Bifrost inline override mismatch; request not routed");
    }
    return pending.tier;
  }

  clear(): void {
    this.pending = [];
  }
}
