import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug } from "../debug.ts";
import { getMetrics } from "./cost-store.ts";
import { isCostWidgetEnabled } from "./cost-config.ts";

export interface CostUIOptions {
  enabled?: boolean;
  showOnMiss?: boolean;
  minMissTokens?: number;
  minMissCost?: number;
}

const DEFAULT_OPTIONS: CostUIOptions = {
  enabled: true,
  showOnMiss: true,
  minMissTokens: 20000,
  minMissCost: 0.1,
};

export function updateWidget(ctx: ExtensionContext, options: CostUIOptions = DEFAULT_OPTIONS): void {
  if (!options.enabled || !isCostWidgetEnabled()) {
    if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget("bifrost-cost", []);
    return;
  }
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  
  const metrics = getMetrics(ctx.sessionManager);
  if (!metrics) {
    debug("cost", "widget_missing_metrics", { session: ctx.sessionManager });
    return;
  }

  const total = metrics.totalInput;
  const read = metrics.totalRead;
  const eff = total > 0 && read <= total ? Math.round((read / total) * 100) : 0;
  const saved = total - read;

  debug("cost", "widget_update", { total, read, eff, missed: metrics.missedTokens });

  const lines = [
    `Tokens: Read ${read.toLocaleString()} / Total ${total.toLocaleString()}`,
    `Efficiency: ${eff}% saved`,
    `Net Input: ${saved.toLocaleString()} tokens billed`,
  ];
  
  if (options.showOnMiss && (metrics.missedTokens > (options.minMissTokens ?? 20000) || metrics.missedCost > (options.minMissCost ?? 0.1))) {
    lines.push(`Cache Miss: ${metrics.missedTokens.toLocaleString()} tokens re-billed`);
  }
  
  ctx.ui.setWidget("bifrost-cost", lines);
}
