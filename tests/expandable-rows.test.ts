import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExpandableRows, type ExpandableRow } from "../ui/expandable-rows.ts";

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

  it("wraps prose between words when it fits", () => {
    const h = harness([{ id: "about", label: "Some activity can fall outside them." }], { columns: 24, rows: 10 });
    const lines = h.viewer.render(20).join("\n");
    assert.match(lines, /Some activity\n/);
    assert.match(lines, /can fall outside\n/);
    assert.doesNotMatch(lines, /activ\n|outsid\n/);
  });

  it("scrolls through every wrapped line of a selected row at the end", () => {
    const value = "third-row-value-that-wraps-across-many-lines";
    const h = harness([
      { id: "first", label: "first" },
      { id: "second", label: "second" },
      { id: "third", label: value },
    ], { columns: 24, rows: 5 });
    h.viewer.render(12);
    h.viewer.handleInput("\x1b[B");
    h.viewer.handleInput("\x1b[B");
    let last: string[] = [];
    for (let i = 0; i < 20; i++) {
      last = h.viewer.render(12);
      h.viewer.handleInput("\x1b[B");
    }
    assert(last.some((line) => line.includes("ines")));
  });

  it("shows both lines of a selected row that fits the viewport", () => {
    const h = harness([{ id: "a", label: "first" }, { id: "b", label: "second" }, { id: "c", label: "abcdefghijEND" }]);
    h.viewer.render(12);
    h.viewer.handleInput("\x1b[B");
    h.viewer.render(12);
    h.viewer.handleInput("\x1b[B");
    const screen = h.viewer.render(12).join("\n");
    assert.match(screen, /abcdef/);
    assert.match(screen, /END/);
  });

  it("scrolls through a single selected row longer than the viewport", () => {
    const value = "one-row-value-that-is-far-longer-than-the-viewport";
    const h = harness([{ id: "only", label: value }], { columns: 24, rows: 5 });
    let last: string[] = [];
    for (let i = 0; i < 20; i++) {
      last = h.viewer.render(12);
      h.viewer.handleInput("\x1b[B");
    }
    assert(last.some((line) => line.includes("rt")));
  });

  it("styles only viewport rows when navigating a large list", () => {
    let styled = 0;
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `${i}`, label: `request ${i}` }));
    const viewer = new ExpandableRows(rows, { fg: (_color, text) => { styled++; return text; } },
      () => ({ columns: 30, rows: 6 }), () => {}, () => {});
    assert.match(viewer.render(30)[0]!, /request 0/);
    viewer.handleInput("\x1b[B");
    const next = viewer.render(30);
    assert.match(next[1]!, /› .*request 1/);
    assert.equal(styled, 8);
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
