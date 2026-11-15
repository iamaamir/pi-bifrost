import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCostReportData } from "../../cost-report.ts";
import { showCostView } from "../../cost-view.ts";

const entries = [
  { type: "message", message: { role: "user", content: [{ type: "text", text: "synthetic fixture" }] } },
  { type: "message", message: { role: "assistant", provider: "fake", model: "healthy", usage: { input: 123, output: 45, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } },
] as any;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cost-test", { description: "Show synthetic cost data", handler: async (_args, ctx) => {
    await showCostView(ctx, getCostReportData(entries, entries));
  } });
}
