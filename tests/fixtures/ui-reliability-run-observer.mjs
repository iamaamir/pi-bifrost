// Test-only native Pi lifecycle observer. No routing hooks or state writes.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function messageRow(entry) {
  const message = entry.message;
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    return { id: entry.id, role: "user", text };
  }
  return { id: entry.id, role: message.role, provider: message.provider,
    model: message.model, stopReason: message.stopReason };
}

export default function (pi) {
  const sessions = new WeakMap();
  function emit(type, ctx, detail = {}) {
    let session = sessions.get(ctx.sessionManager);
    if (!session) {
      session = { id: randomUUID(), run: 0 };
      sessions.set(ctx.sessionManager, session);
    }
    if (type === "start") session.run++;
    appendFileSync(join(process.cwd(), ".pi", "ui-run.jsonl"), JSON.stringify({
      type, session: session.id, run: session.run, at: Date.now(), ...detail,
    }) + "\n");
  }
  pi.on("agent_start", (_event, ctx) => emit("start", ctx));
  pi.on("turn_end", (event, ctx) => emit("turn", ctx, {
    entryId: event.messageEntryId, provider: event.message.provider,
    model: event.message.model, stopReason: event.message.stopReason,
  }));
  pi.on("agent_settled", (_event, ctx) => emit("settled", ctx, {
    messages: ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").map(messageRow),
  }));
}
