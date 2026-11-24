import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InitReview, ResultViewer, wrapResultLines } from "../result-viewer.ts";

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
      const detail = `detail-${"abcdefghij".repeat(24)}-tail`;
      const review = new InitReview([], [detail], ["Keep", "Merge", "Defaults"], { fg: (_color, text) => text }, () => {}, () => {});
      const seen = new Set<string>();
      review.handleInput("\x0f");
      let rendered = review.render(width);
      const collect = () => {
        for (const line of rendered.slice(2, 6)) if (line.trim()) seen.add(line.trim());
      };
      collect();
      for (let offset = 0; offset < wrapResultLines([detail], width - 2).length; offset++) {
        review.handleInput("j");
        rendered = review.render(width);
        collect();
      }
      const expectedRows = wrapResultLines([detail], width - 2);
      assert.ok([...seen].some((line) => line.includes("-tail")), `tail reachable at width ${width}`);
      for (const expected of expectedRows) assert.ok(seen.has(expected), `wrapped row reachable at width ${width}: ${expected}`);
  }

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
      assert.ok(rows.some((line) => line.startsWith("❯ ")), `selection marker visible at width ${width}`);
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
