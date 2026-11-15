import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn } from "@earendil-works/pi-tui";
import { ExpandableRows, type ExpandableRow } from "./expandable-rows.ts";
import type { CostReportData, CostTotals } from "./cost-report.ts";
import { wrapApprovalLines } from "./config-approval.ts";

function cost(usage: CostTotals): string {
  if (!usage.count || usage.count === usage.unknownCost) return "unavailable";
  const known = `$${usage.cost.toFixed(6)}`;
  return usage.unknownCost ? `${known} known + unknown (${usage.unknownCost})` : known;
}

function details(id: string, usage: CostTotals): ExpandableRow[] {
  const suffix = usage.usageValid ? "" : " (partial)";
  return [
    { id: `${id}-records`, label: `${usage.count} records${usage.unknownCost ? ` · ${usage.unknownCost} cost unavailable` : ""}` },
    { id: `${id}-input`, label: `Input ${usage.input.toLocaleString()} · Output ${usage.output.toLocaleString()}${suffix}` },
    { id: `${id}-cache`, label: `Provider cache read ${usage.cacheRead.toLocaleString()} · write ${usage.cacheWrite.toLocaleString()}${suffix}` },
  ];
}

function modelRow(id: string, model: string, usage: CostTotals): ExpandableRow {
  return { id, label: model, detail: cost(usage), children: details(id, usage) };
}

function about(): ExpandableRow {
  return { id: "about", label: "About these numbers", children: [
    { id: "about-scope", label: "Requests are derived from user-message boundaries; ambiguous activity may not map to a request." },
    { id: "about-history", label: "Session history can include copied forks and alternate branches." },
    { id: "about-estimate", label: "Pi-reported cost is an estimate, not a bill; zero does not prove free usage." },
    { id: "about-routing", label: "Routing reasons are not recorded here; classifier and probe costs may be missing." },
    { id: "about-savings", label: "No baseline is available to determine savings." },
  ] };
}

function requestRows(data: CostReportData): ExpandableRow[] {
  const groups = data.activeBranch.groups.map((group, index) => {
    const id = `request-${index}`;
    return { id, label: `Request ${index + 1}* · ${group.totals.count} records`, detail: cost(group.totals), children: group.responses.map((response, n) => modelRow(`${id}-model-${n}`, response.model, response.usage)) };
  }).reverse();
  const rows: ExpandableRow[] = [...groups];
  if (data.unassigned.count) rows.push(modelRow("unassigned", "Unassigned assistant usage", data.unassigned));
  rows.push(...data.activeBranch.auxiliary.map(({ label, usage }, n) => modelRow(`other-${n}`, `Other: ${label}`, usage)));
  rows.push(about());
  return rows;
}

function modelRows(data: CostReportData): ExpandableRow[] {
  return [...data.activeBranch.responses.map(({ model, usage }, n) => modelRow(`model-${n}`, model, usage)),
    ...data.activeBranch.auxiliary.map(({ label, usage }, n) => modelRow(`other-${n}`, `Other: ${label}`, usage)), about()];
}

export function formatCostText(data: CostReportData): string[] {
  const lines = ["Bifrost cost · Pi-recorded estimates", `Current branch: ${cost(data.activeBranch.totals)}${data.activeBranch.malformed ? " + unknown" : ""}`, `All retained: ${cost(data.allRetained.totals)}${data.allRetained.totals.incomplete && !data.allRetained.totals.unknownCost ? " · partial" : ""}`, "", "Requests (derived from user-message boundaries)"];
  const append = (rows: readonly ExpandableRow[], depth = 0) => {
    for (const row of rows) {
      lines.push(`${"  ".repeat(depth)}${row.label}${row.detail ? ` · ${row.detail}` : ""}`);
      if (row.children) append(row.children, depth + 1);
    }
  };
  append(requestRows(data));
  return lines;
}

export class CostView {
  private view: "requests" | "models" = "requests";
  private readonly requests: ExpandableRows;
  private readonly models: ExpandableRows;
  private readonly data: CostReportData;
  private readonly size: () => { columns: number; rows: number };
  private readonly theme: Pick<ExtensionContext["ui"]["theme"], "fg">;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private bodyHeight = 1;

  constructor(data: CostReportData, size: () => { columns: number; rows: number }, theme: Pick<ExtensionContext["ui"]["theme"], "fg">, done: () => void, requestRender: () => void) {
    this.data = data; this.size = size; this.theme = theme; this.done = done; this.requestRender = requestRender;
    const available = () => ({ ...this.size(), rows: this.bodyHeight + 2 });
    this.requests = new ExpandableRows(requestRows(data), theme, available, () => {}, requestRender);
    this.models = new ExpandableRows(modelRows(data), theme, available, () => {}, requestRender);
  }

  invalidate(): void { this.requests.invalidate(); this.models.invalidate(); }

  render(width: number): string[] {
    const fit = (text: string) => sliceByColumn(text, 0, Math.max(0, width), true);
    if (width < 20 || this.size().rows < 9) return [fit("Resize terminal · Esc closes")];
    const selected = this.view === "requests" ? this.requests : this.models;
    const partial = this.data.activeBranch.malformed ? " + unknown" : "";
    const header = ["Bifrost cost · Pi-recorded estimates", `Current branch  ${cost(this.data.activeBranch.totals)}${partial}`, `All retained    ${cost(this.data.allRetained.totals)}${this.data.allRetained.totals.incomplete && !this.data.allRetained.totals.unknownCost ? " · partial" : ""}`, this.view === "requests" ? "[Requests]  Models" : " Requests  [Models]"].flatMap((line) => wrapApprovalLines(line, width));
    const footer = wrapApprovalLines("↑↓ move · Enter expand · Tab view · Esc close", width);
    this.bodyHeight = Math.floor(this.size().rows * 0.8) - header.length - footer.length - 2;
    if (this.bodyHeight < 1) return [fit("Resize terminal · Esc closes")];
    return [this.theme.fg("accent", header[0]!), ...header.slice(1), ...selected.render(width), ...footer];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "tab")) { this.view = this.view === "requests" ? "models" : "requests"; this.requestRender(); return; }
    (this.view === "requests" ? this.requests : this.models).handleInput(data);
  }
}

export async function showCostView(ctx: ExtensionContext, data: CostReportData): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") return false;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new CostView(data, () => tui.terminal, theme, done, () => tui.requestRender()),
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "top-center", margin: 1 } });
  return true;
}
