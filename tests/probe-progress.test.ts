import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeProgressComponent, setProbeProgress } from "../ui/probe-progress.ts";

describe("init probe progress presentation", () => {
  it("renders counts without provider details", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const output = probeProgressComponent(theme, { done: 2, total: 4, okCount: 1, errCount: 1 }).render(80).join("\n");
    assert.match(output, /2\/4/);
    assert.match(output, /50%/);
    assert.match(output, /1 working/);
    assert.match(output, /1 failed/);
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
