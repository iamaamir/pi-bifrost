import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getCostReportData } from "../cost-report.ts";
import { CostView, formatCostText } from "../ui/cost-view.ts";

it("shows branch totals and expands mixed-model requests without exposing content", () => {
  const usage = (cost: number | undefined) => ({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: cost === undefined ? undefined : { total: cost } });
  const branch = [
    { type: "message", message: { role: "user", content: "PROMPT-CANARY" } },
    { type: "message", message: { role: "assistant", provider: "p", model: "a", usage: usage(0.02) } },
    { type: "message", message: { role: "assistant", provider: "p", model: "b", usage: usage(undefined) } },
  ] as any;
  const retained = [...branch, { type: "message", message: { role: "assistant", provider: "p", model: "c", usage: usage(0.03) } }] as any;
  const data = getCostReportData(branch, retained);
  let closed = false;
  const size = { columns: 80, rows: 30 };
  const view = new CostView(data, () => size, { fg: (_color, value) => value }, () => { closed = true; }, () => {});
  const framed = view.render(70);
  assert(framed.every((line) => visibleWidth(line) === 70));
  assert.match(framed[0]!, /╭─+╮/);
  assert.match(framed.at(-1)!, /╰─+╯/);
  let screen = view.render(70).join("\n");
  assert.match(screen, /Session usage · Pi-recorded estimates/);
  assert.match(screen, /Current branch\s+\$0\.020000 known \+ unknown/);
  assert.match(screen, /All retained\s+\$0\.050000 known \+ unknown/);
  assert.doesNotMatch(screen, /p\/a|PROMPT-CANARY/);
  view.handleInput("\r");
  screen = view.render(70).join("\n");
  assert.match(screen, /p\/a/);
  assert.match(screen, /p\/b/);
  assert.doesNotMatch(screen, /p\/c|PROMPT-CANARY/);
  size.columns = 28;
  screen = view.render(28).join("\n");
  assert.match(screen, /0\.020000/);
  view.handleInput("\t");
  assert.match(view.render(28).join("\n"), /\[Models\]/);
  view.handleInput("\x1b");
  assert.equal(closed, true);
  const text = formatCostText(data).join("\n");
  assert.match(text, /Session usage · Pi-recorded estimates/);
  assert.doesNotMatch(text, /PROMPT-CANARY/);
});

it("does not report an invented zero subtotal when every price is missing", () => {
  const entries = [{ type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } }] as any;
  const text = formatCostText(getCostReportData(entries, entries)).join("\n");
  assert.match(text, /Current branch: unavailable/);
  assert.doesNotMatch(text, /\$0\.000000/);
});

it("shows aggregated current-branch model totals in plain text", () => {
  const usage = (cost: number) => ({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(0.1) } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(0.2) } },
  ] as any;
  const text = formatCostText(getCostReportData(branch, branch)).join("\n");
  assert.match(text, /Models \(current branch\)[\s\S]*p\/m · \$0\.300000/);
});

it("marks partial token data even when another record has unknown cost", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "p", model: "a", usage: { input: 1, output: 0, cacheRead: 0, cost: { total: 0.1 } } } },
    { type: "message", message: { role: "assistant", provider: "p", model: "b", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", message: null },
  ] as any;
  const data = getCostReportData(entries, entries);
  const text = formatCostText(data).join("\n");
  assert.match(text, /Current branch: .*partial/);
  assert.match(text, /All retained: .*unknown \(1 unpriced\) · partial/);
  const view = new CostView(data, () => ({ columns: 100, rows: 30 }), { fg: (_color, value) => value }, () => {}, () => {});
  const screen = view.render(90).join("\n");
  assert.match(screen, /Current branch .*partial/);
  assert.match(screen, /All retained .*partial/);
  const tokensOnly = formatCostText(getCostReportData(entries.slice(0, 1), entries.slice(0, 1))).join("\n");
  assert.match(tokensOnly, /Current branch: \$0\.100000 · partial/);
});

it("preserves independent expanded request and model trees across tab switches", () => {
  const entries = [{ type: "message", message: { role: "user" } }, { type: "message", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } }] as any;
  const view = new CostView(getCostReportData(entries, entries), () => ({ columns: 100, rows: 40 }), { fg: (_color, value) => value }, () => {}, () => {});
  view.handleInput("\r");
  assert.match(view.render(90).join("\n"), /p\/m/);
  view.handleInput("\t");
  view.handleInput("\r");
  assert.match(view.render(90).join("\n"), /Input 1/);
  view.handleInput("\t");
  assert.match(view.render(90).join("\n"), /p\/m/);
  view.handleInput("\t");
  assert.match(view.render(90).join("\n"), /Input 1/);
});
