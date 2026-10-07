import { appendFileSync } from "node:fs";

export default function handleEarlierInputWithUnrelatedTurn(pi) {
  let extensionTurnQueued = false;
  if (process.env.BIFROST_DISPATCH_IDENTITY_GENERATE === "1") {
    pi.on("agent_end", (_event, ctx) => {
      if (extensionTurnQueued) return;
      extensionTurnQueued = true;
      const report = process.env.BIFROST_DISPATCH_IDENTITY_REPORT;
      const priorUserEntryIds = ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id);
      if (report) appendFileSync(report, `${JSON.stringify({ type: "extension_turn_attempt", priorUserEntryIds })}\n`);
      let accepted = false;
      try {
        pi.sendUserMessage("unrelated-extension-turn", { deliverAs: "followUp" });
        accepted = true;
      } catch {
        // Do not expose error text or prompt content in the fixture report.
      }
      if (report) appendFileSync(report, `${JSON.stringify({ type: "extension_turn_requested", accepted })}\n`);
    });
  }

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") {
      return;
    }
    const handleInput = process.env.BIFROST_DISPATCH_IDENTITY_NEGATIVE === "1"
      && event.text === "handled-identity-fixture";
    if (!handleInput) return;

    const priorUserEntryIds = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.id);
    const report = process.env.BIFROST_DISPATCH_IDENTITY_REPORT;
    if (report && handleInput) appendFileSync(report, `${JSON.stringify({
      type: "later_input_handled",
      source: event.source,
      priorUserEntryIds,
    })}\n`);
    void ctx;
    return { action: "handled" };
  });
}
