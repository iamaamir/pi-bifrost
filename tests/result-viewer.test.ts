import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isEscapeKey, showBifrostResult, wrapResultLines } from "../result-viewer.ts";

describe("result viewer", () => {
  it("wraps long lines without dropping text", () => {
    const source = "selected: provider/very-long-model-name-with-every-detail";
    const lines = wrapResultLines([source], 12);

    assert(lines.length > 1);
    assert.equal(lines.join(""), source);
    assert(lines.every((line) => line.length <= 12));
  });

  it("wraps at whitespace while preserving whitespace and long identifiers", () => {
    const source = "alpha beta gamma provider/long-identifier";
    const lines = wrapResultLines([source], 10);
    assert.deepEqual(lines.slice(0, 2), ["alpha ", "beta "]);
    assert.equal(lines.join(""), source);
    assert(lines.every((line) => visibleWidth(line) <= 10));
  });

  it("uses available overlay height", async () => {
    let viewer: { render(width: number): string[] } | undefined;
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: Function) => {
      viewer = factory({ terminal: { rows: 36 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
    } } };
    await showBifrostResult(ctx as never, "Inspection", Array.from({ length: 30 }, (_, i) => `fact ${i}`));
    assert(viewer);
    const output = viewer.render(40);
    assert.equal(output.length, 28);
    assert(output.some((line) => line.includes("fact 23")));
  });

  it("preserves wide and combining characters at terminal cell boundaries", () => {
    const source = "路径/e\u0301/模型🚀";
    const lines = wrapResultLines([source], 4);
    assert.equal(lines.join(""), source);
    assert(lines.every((line) => visibleWidth(line) <= 4));
  });

  it("fits framed output at narrow widths and supports scrolling", async () => {
    let viewer: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: Function) => {
      viewer = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
    } } };
    await showBifrostResult(ctx as never, "Inspection", Array.from({ length: 20 }, (_, i) => `路径${i}`));
    assert(viewer);
    for (const width of [0, 1, 2, 3, 4, 5, 6, 12, 40]) assert(viewer.render(width).every((line) => visibleWidth(line) <= width));
    assert.equal(viewer.render(5)[2], "路径0");
    assert.equal(viewer.render(4)[2], "路径");
    assert.deepEqual(viewer.render(3).slice(2, 4), ["路 ", "径0"]);
    assert.equal(viewer.render(1).join(""), "Resize wider");
    assert.equal(viewer.render(5)[2], "路径0");
    const before = viewer.render(12);
    assert.equal(before[3], "│ 路径0    │");
    viewer.handleInput("j");
    const after = viewer.render(12);
    assert.equal(after[3], "│ 路径1    │");
    assert.deepEqual(after.slice(3, 12), before.slice(4, 13));
  });

  it("reaches the final fact within Pi's height cap after resize", async () => {
    let viewer: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    const terminal = { rows: 24 };
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: Function) => {
      viewer = factory({ terminal, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
    } } };
    await showBifrostResult(ctx as never, "Inspection", Array.from({ length: 20 }, (_, i) => `fact ${i}`));
    assert(viewer);
    viewer.render(20);
    terminal.rows = 10;
    for (let i = 0; i < 30; i++) { viewer.render(20); viewer.handleInput("j"); }
    const output = viewer.render(20);
    assert(output.length <= 8);
    assert(output.some((line) => line.includes("fact 19")));
    terminal.rows = 6;
    viewer.render(20);
    for (let i = 0; i < 30; i++) { viewer.handleInput("j"); viewer.render(20); }
    assert(viewer.render(20).some((line) => line.includes("fact 19")));
  });

  it("keeps blank lines between result sections", () => {
    assert.deepEqual(wrapResultLines(["tier: frontier", "", "candidates:"], 40), [
      "tier: frontier",
      "",
      "candidates:",
    ]);
  });

  it("recognizes terminal escape encodings", () => {
    assert.equal(isEscapeKey("\x1b"), true);
    assert.equal(isEscapeKey("\x1b[27u"), true);
    assert.equal(isEscapeKey("\x1b[27;1u"), true);
    assert.equal(isEscapeKey("\x1b[27;1;27~"), true);
    assert.equal(isEscapeKey("j"), false);
  });
});
