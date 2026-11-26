import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearProbeProgress, probeProgressComponent, setProbeProgress } from "../ui/probe-progress.ts";

describe("init probe progress presentation", () => {
  it("renders neutral preparation without a percentage or counts", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const output = probeProgressComponent(theme, { phase: "preparing" }).render(80).join("\n");
    assert.match(output, /Refreshing model catalog/);
    assert.match(output, /━─{19}/);
    assert.doesNotMatch(output, /%|working|failed|\d+\/\d+/);
  });

  it("renders preparation without advertising unavailable cancellation", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const output = probeProgressComponent(theme, { phase: "preparing" }).render(80).join("\n");
    assert.match(output, /Refreshing model catalog/);
    assert.doesNotMatch(output, /Esc to cancel/);
  });

  it("renders counts without provider details", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const output = probeProgressComponent(theme, { done: 2, total: 4, okCount: 1, errCount: 1 }).render(80).join("\n");
    assert.match(output, /2\/4/);
    assert.match(output, /50%/);
    assert.match(output, /1 working/);
    assert.match(output, /1 failed/);
  });

  it("shows cancellation only when enabled and animates until cleared", async () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    let widget: any;
    let renders = 0;
    const ctx = { hasUI: true, mode: "tui", ui: { setWidget: (_id: string, value: any) => {
      widget = typeof value === "function" ? value({ requestRender: () => renders++ }, theme) : value;
    } } };
    setProbeProgress(ctx as never, { phase: "preparing" }, true);
    const first = widget.render(80).join("\n");
    assert.match(first, /Esc to cancel/);
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.ok(renders > 0);
    assert.notEqual(widget.render(80).join("\n"), first);
    clearProbeProgress(ctx as never);
    const stopped = renders;
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(renders, stopped);
    assert.deepEqual(widget, []);
    assert.match(probeProgressComponent(theme, { done: 0, total: 1, okCount: 0, errCount: 0 }, true).render(80).join("\n"), /Esc to cancel/);
  });

  it("renders plain progress for non-TUI UI hosts", () => {
    let lines: unknown;
    const ctx = { hasUI: true, mode: "rpc", ui: { setWidget: (_id: string, value: unknown) => { lines = value; } } };
    setProbeProgress(ctx as never, { done: 1, total: 2, okCount: 1, errCount: 0 });
    assert.deepEqual(lines, ["Probing models: 1/2", "  ok: 1  errors: 0"]);
  });

  it("does not create a widget on older or headless hosts", () => {
    let writes = 0;
    const ctx = { hasUI: false, ui: { setWidget: () => writes++ } };
    setProbeProgress(ctx as never, { done: 1, total: 1, okCount: 1, errCount: 0 });
    assert.equal(writes, 0);
  });
});
