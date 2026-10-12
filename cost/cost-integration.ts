import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug } from "../debug.ts";
import { buildTurn, recordTurnAsync, persistSessionCost, flushPendingTurns, shouldCheckpoint } from "./cost-store.ts";
import { updateWidget } from "./cost-ui.ts";
import { isCostCollectionEnabled } from "./cost-config.ts";

export function trackCost(ctx: ExtensionContext): void {
  if (!isCostCollectionEnabled()) return;
  debug("cost", "event_fired", { session: ctx.sessionManager });

  try {
    const branch = ctx.sessionManager.getBranch();
    const latestAssistant = branch
      .filter((entry: any): entry is any => entry.type === "message" && entry.message?.role === "assistant")
      .at(-1);

    if (latestAssistant) {
      const msg = latestAssistant.message as any;
      const cost = msg.cost;
      const usage = msg.usage;
      debug("cost", "settlement_cost_check", {
        hasCost: !!cost,
        hasUsage: !!usage,
        keys: Object.keys(msg),
      });

      const finalCost = cost || usage;
      if (finalCost) {
        const input = finalCost.input ?? finalCost.prompt_tokens ?? finalCost.input_tokens ?? 0;
        const output = finalCost.output ?? finalCost.completion_tokens ?? finalCost.output_tokens ?? 0;
        const read =
          finalCost.cacheRead ??
          finalCost.prompt_cache_read_tokens ??
          finalCost.cache_read ??
          finalCost.cached_tokens ??
          finalCost.cache_read_input_tokens ??
          (finalCost.prompt_tokens_details?.cached_tokens) ??
          0;
        const write =
          finalCost.cacheWrite ??
          finalCost.prompt_cache_write_tokens ??
          finalCost.cache_write ??
          finalCost.cache_write_input_tokens ??
          0;

        const breakdown = { input, output, cacheRead: read, cacheWrite: write };
        const turn = buildTurn(ctx.sessionManager, msg, finalCost, breakdown);
        recordTurnAsync(ctx.sessionManager, turn);
        queueMicrotask(() => updateWidget(ctx));

        // Periodic checkpoint
        if (shouldCheckpoint(ctx.sessionManager)) {
          persistSessionCost(ctx.sessionManager, process.cwd()).catch((e) => 
            debug("cost", "checkpoint_error", { error: String(e) })
          );
        }
      }
    } else {
      debug("cost", "no_assistant_message_found");
    }
  } catch (e) {
    debug("cost", "error", { error: String(e) });
  }
}

export function registerCostTracking(pi: any): void {
  pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
    trackCost(ctx);
  });

  pi.on("compaction_end", async (_event: any, ctx: ExtensionContext) => {
    debug("cost", "compaction_detected", { session: ctx.sessionManager });
    persistSessionCost(ctx.sessionManager, process.cwd()).catch((e) => 
      debug("cost", "compaction_save_error", { error: String(e) })
    );
  });
}

/** Persist session cost metrics on shutdown (no-op unless cost.persist enabled). */
export async function shutdownCostTracking(ctx: ExtensionContext, cwd: string): Promise<void> {
  await flushPendingTurns(ctx.sessionManager);
  await persistSessionCost(ctx.sessionManager, cwd);
}
