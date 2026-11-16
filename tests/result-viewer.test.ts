import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEscapeKey, showBifrostResult, wrapResultLines } from "../ui/result-viewer.ts";

describe("result viewer", () => {
  it("wraps long lines without dropping text", () => {
    const source = "selected: provider/very-long-model-name-with-every-detail";
    const lines = wrapResultLines([source], 12);

    assert(lines.length > 1);
    assert.equal(lines.join(""), source);
    assert(lines.every((line) => line.length <= 12));
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

  it("uses the shared frame for preview results", async () => {
    let rendered: string[] = [];
    const ctx = { hasUI: true, mode: "tui", ui: { custom: async (factory: any) => {
      const viewer = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
      rendered = viewer.render(40);
    } } } as any;
    assert.equal(await showBifrostResult(ctx, "Bifrost preview", ["tier: general"]), true);
    assert.match(rendered[0]!, /^╭─+╮$/);
    assert.match(rendered[1]!, /│ Bifrost preview/);
    assert(rendered.some((line) => line.includes("tier: general")));
    assert.match(rendered.at(-1)!, /^╰─+╯$/);
  });
});
