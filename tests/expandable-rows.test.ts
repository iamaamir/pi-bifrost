import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExpandableRows, type ExpandableRow } from "../expandable-rows.ts";

function harness(rows: ExpandableRow[], dimensions = { columns: 24, rows: 5 }) {
  const selected: string[] = [];
  let renders = 0;
  const viewer = new ExpandableRows(rows, { fg: (_color, text) => text }, () => dimensions,
    (row) => selected.push(row.id), () => { renders += 1; });
  return { viewer, selected, renders: () => renders, resize: (columns: number, height: number) => {
    dimensions = { columns, rows: height };
    viewer.invalidate();
  } };
}

describe("expandable rows", () => {
  it("navigates, toggles hierarchy, and selects a leaf", () => {
    const h = harness([{ id: "group", label: "Requests", children: [{ id: "leaf", label: "request details" }] }]);
    assert.match(h.viewer.render(24)[0]!, /▸ Requests/);
    h.viewer.handleInput("\r");
    assert.match(h.viewer.render(24)[0]!, /▾ Requests/);
    h.viewer.handleInput("\x1b[B");
    h.viewer.handleInput("\r");
    assert.deepEqual(h.selected, ["leaf"]);
    assert.equal(h.renders(), 2);
  });

  it("wraps long values, scrolls, and retains the selected row after resize", () => {
    const h = harness([
      { id: "long", label: "provider/model-identifier-that-is-long" },
      { id: "next", label: "next" },
    ], { columns: 24, rows: 20 });
    const narrow = h.viewer.render(12);
    assert(narrow.join("").replaceAll(" ", "").includes("provider/model-identifier-that-is-long"));
    h.viewer.handleInput("\x1b[B");
    h.resize(30, 8);
    h.viewer.render(30);
    h.viewer.handleInput("\r");
    assert.deepEqual(h.selected, ["next"]);
  });

  it("collapses with left and leaves escape for the overlay owner", () => {
    const h = harness([{ id: "group", label: "group", children: [{ id: "leaf", label: "leaf" }] }]);
    h.viewer.handleInput("\x1b[C");
    assert.match(h.viewer.render(24)[0]!, /▾ group/);
    h.viewer.handleInput("\x1b[D");
    assert.match(h.viewer.render(24)[0]!, /▸ group/);
    h.viewer.handleInput("\x1b");
    assert.equal(h.selected.length, 0);
  });
});
