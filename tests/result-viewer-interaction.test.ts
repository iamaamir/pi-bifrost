import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InitReview, ResultViewer } from "../result-viewer.ts";

describe("result viewer interaction", () => {
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

  it("reaches every wrapped review detail row at normal and narrow widths", () => {
    for (const width of [80, 18]) assertWrappedRowsReachable(width);
  });

  function assertWrappedRowsReachable(width: number) {
      const details = ["abcdefghijklmnopQRST", "row-two", "row-three", "row-four", "row-five", "row-six"];
      const expected = width === 18
        ? ["abcdefghijklmnop", "QRST", ...details.slice(1)] : details;
      const review = new InitReview([], details, ["Keep", "Merge", "Defaults"], { fg: (_color, text) => text }, () => {}, () => {});
      review.handleInput("\x0f");
      const observed: string[] = [];
      for (let i = 0; i < expected.length; i++) {
        const line = review.render(width)[2];
        if (observed.at(-1) !== line) observed.push(line);
        review.handleInput("j");
      }
      observed.push(...review.render(width).slice(3, 6));
      assert.deepEqual(observed, expected);

  }

  it("pages by four rows and clamps at both boundaries", () => {
    const review = new InitReview(Array.from({ length: 10 }, (_, i) => `row-${i}`), [], ["OK"], { fg: (_color, text) => text }, () => {}, () => {});
    const first = () => review.render(80)[2];
    assert.equal(first(), "row-0");
    review.handleInput("\x1b[6~");
    assert.equal(first(), "row-4");
    review.handleInput("\x1b[6~");
    assert.equal(first(), "row-6");
    review.handleInput("k");
    assert.equal(first(), "row-5");
    review.handleInput("\x1b[5~");
    assert.equal(first(), "row-1");
    review.handleInput("\x1b[5~");
    assert.equal(first(), "row-0");
    review.handleInput("j");
    assert.equal(first(), "row-1");
  });

  it("shows and confirms every selected action at normal and narrow widths", () => {
    const actions = ["Keep my models", "Merge new models", "Bifrost defaults"];
    for (const width of [80, 18]) {
      assertSelectedActionsVisible(width, actions);
    }
  });

  function assertSelectedActionsVisible(width: number, actions: string[]) {
    for (let selected = 0; selected < actions.length; selected++) {
      let result = "";
      const review = new InitReview([], [], actions, { fg: (_color, text) => text }, (value) => { result = value; }, () => {});
      for (let i = 0; i < selected; i++) review.handleInput("\x1b[B");
      const rows = review.render(width);
      const markers = rows.flatMap((line, index) => line.startsWith("❯ ") ? [index] : []);
      assert.equal(markers.length, 1);
      const selectedLabel = rows.slice(markers[0], markers[0] + 2).map((line) => line.replace(/^❯?\s*/, "")).join("").replace(/\s/g, "");
      assert.ok(selectedLabel.startsWith(actions[selected].replace(/\s/g, "")));
      const actionStart = rows.indexOf("") + 1;
      const visibleActions = rows.slice(actionStart, -1).map((line) => line.replace(/^❯?\s*/, "")).join("").replace(/\s/g, "");
      for (const action of actions) assert.ok(visibleActions.includes(action.replace(/\s/g, "")), `${action} visible at width ${width}`);
      review.handleInput("\r");
      assert.equal(result, actions[selected]);
    }
  }

  it("fails closed when terminal cannot render selected action marker and label", () => {
    let result = "";
    const review = new InitReview([], [], ["Approve"], { fg: (_color, text) => text }, (value) => { result = value; }, () => {});
    review.render(3);
    review.handleInput("\r");
    assert.equal(result, "");
  });

  it("keeps exact details and action approval in one pinned-Pi custom interaction", () => {
    const details = ["Setup preview", ...Array.from({ length: 12 }, (_, i) => `tier-${i}: provider/model-${i}`)];
    let result: string | undefined;
    const review = new InitReview(
      ["Setup preview", "12 model pools will change"],
      details,
      ["Keep my models", "Merge new models", "Bifrost defaults"],
      { fg: (_color, text) => text },
      (value) => { result = value; },
      () => {},
    );
    assert.ok(review.render(80).some((line) => line.includes("Ctrl+O full details")));
    review.handleInput("\x0f");
    assert.ok(review.render(80).some((line) => line.includes("Ctrl+O summary")));
    for (let i = 0; i < 20 && !review.render(80).some((line) => line.includes("tier-11: provider/model-11")); i++) review.handleInput("j");
    assert.ok(review.render(80).some((line) => line.includes("tier-11: provider/model-11")));
    review.handleInput("\x1b[B");
    review.handleInput("\r");
    assert.equal(result, "Merge new models");

    let cancelled: string | undefined = "not-cancelled";
    const cancelReview = new InitReview([], details, ["Approve", "Cancel"], { fg: (_color, text) => text }, (value) => { cancelled = value; }, () => {});
    cancelReview.handleInput("\x1b");
    assert.equal(cancelled, "");
  });

});
