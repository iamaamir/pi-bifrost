import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEscapeKey, ResultViewer, wrapResultLines } from "../result-viewer.ts";

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

  it("keeps every preview line reachable in scrollable viewer, including long previews", () => {
    const preview = ["◆ Bifrost · Setup preview", ...Array.from({ length: 12 }, (_, i) => `  tier-${i}: [provider/model-${i}]`)];
    const rendered: string[] = [];
    const viewer = new ResultViewer(
      "Bifrost · Setup preview",
      preview,
      { fg: (_color, text) => text },
      () => {},
      () => {},
    );
    rendered.push(...viewer.render(80));
    for (let i = 0; i < 12; i++) {
      viewer.handleInput("\x1b[B");
      rendered.push(...viewer.render(80));
    }
    assert.ok(rendered.some((line) => line.includes("tier-11: [provider/model-11]")));

    const longLine = `  classifier: ${"provider/model-detail ".repeat(200)}TAIL-DETAIL`;
    const longViewer = new ResultViewer(
      "Bifrost · Setup preview",
      ["◆ Bifrost · Setup preview", longLine],
      { fg: (_color, text) => text },
      () => {},
      () => {},
    );
    let longRendered = longViewer.render(40).join("\n");
    assert.ok(longRendered.includes("provider/model-detail"));
    assert.ok(longRendered.includes("↑↓/jk scroll"));
    for (let i = 0; i < 200; i++) {
      longViewer.handleInput("\x1b[B");
      longRendered = longViewer.render(40).join("\n");
    }
    assert.ok(longRendered.includes("TAIL-DETAIL"));
  });

  it("recognizes terminal escape encodings", () => {
    assert.equal(isEscapeKey("\x1b"), true);
    assert.equal(isEscapeKey("\x1b[27u"), true);
    assert.equal(isEscapeKey("\x1b[27;1u"), true);
    assert.equal(isEscapeKey("\x1b[27;1;27~"), true);
    assert.equal(isEscapeKey("j"), false);
  });
});
