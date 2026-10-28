import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { approveConfig, ConfigApproval, wrapApprovalLines } from "../config-approval.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function fixture() {
  const size = { columns: 40, rows: 8 };
  const results: boolean[] = [];
  const message = Array.from({ length: 23 }, (_, i) => `change-${i}`).join("\n");
  const viewer = new ConfigApproval("Exact proposal", message, () => size, (v) => results.push(v), () => {});
  const render = () => viewer.render(size.columns);
  return { size, results, viewer, render };
}

function traverse(f: ReturnType<typeof fixture>) {
  const seen: string[] = [];
  for (let i = 0; i < 100; i++) {
    const lines = f.render();
    seen.push(...lines);
    assert.ok(lines.length <= f.size.rows);
    assert.ok(lines.every((line) => visibleWidth(line) <= f.size.columns));
    if (lines.at(-1)?.includes("a Apply")) return seen;
    f.viewer.handleInput("n");
  }
  throw new Error("review did not reach final page");
}

describe("configuration approval viewport", () => {
  it("requires rendered sequential pages and explicit apply", () => {
    const f = fixture();
    f.viewer.handleInput("a");
    f.render();
    for (const key of ["a", "\r", "\n", "\x1b[F", "\x1b[6~"]) f.viewer.handleInput(key);
    assert.deepEqual(f.results, []);
    f.viewer.handleInput("n");
    for (let i = 0; i < 100; i++) f.viewer.handleInput("n");
    assert.match(f.render()[0]!, /review 2\//, "queued keys cannot skip unrendered pages");
    const seen = traverse(f).join("\n");
    assert.match(seen, /change-22/);
    assert.deepEqual(f.results, []);
    f.viewer.handleInput("a");
    assert.deepEqual(f.results, [true]);
  });

  it("resets traversal on resize and rejects approval before resize renders", () => {
    const f = fixture();
    traverse(f);
    f.size.rows = 10;
    f.viewer.handleInput("a");
    assert.deepEqual(f.results, []);
    assert.match(f.render()[0]!, /review 1\//);
    f.viewer.handleInput("a");
    assert.deepEqual(f.results, []);
    traverse(f);
    f.size.columns = 45;
    assert.match(f.render()[0]!, /review 1\//);
    f.viewer.handleInput("a");
    assert.deepEqual(f.results, []);
  });

  it("invalidates approval on resize events even if dimensions return before rendering", async () => {
    const size = { columns: 40, rows: 8 };
    const outcomes: boolean[] = [];
    const before = process.stdout.listenerCount("resize");
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: async (factory: Function) => {
        const viewer = factory({ terminal: size, requestRender() {} }, {}, {}, (value: boolean) => outcomes.push(value)) as ConfigApproval;
        for (let i = 0; i < 100; i++) {
          if (viewer.render(40).at(-1)?.includes("a Apply")) break;
          viewer.handleInput("n");
        }
        size.rows = 9;
        process.stdout.emit("resize");
        size.rows = 8;
        process.stdout.emit("resize");
        viewer.handleInput("a");
        assert.deepEqual(outcomes, [], "resize events must invalidate the prior review");
        assert.match(viewer.render(40)[0]!, /review 1\//);
        return false;
      } },
    } as unknown as ExtensionContext;
    assert.equal(await approveConfig(ctx, "title", Array(20).fill("change").join("\n")), false);
    assert.equal(process.stdout.listenerCount("resize"), before);
  });

  it("fails closed in tiny viewports and cancels at every stage", () => {
    for (const size of [{ columns: 39, rows: 8 }, { columns: 40, rows: 7 }]) {
      const f = fixture();
      Object.assign(f.size, size);
      assert.match(f.render().join(""), /Resize/);
      for (const key of ["n", "a", "\r"]) f.viewer.handleInput(key);
      assert.deepEqual(f.results, []);
      f.viewer.handleInput("\x1b");
      assert.deepEqual(f.results, [false]);
    }
    for (const key of ["\x1b", "\x1b[27u", "\x03"]) {
      const f = fixture();
      traverse(f);
      f.viewer.handleInput(key);
      assert.deepEqual(f.results, [false]);
    }
  });

  it("wraps exact text by terminal cells without dropping whitespace", () => {
    const source = "  wide 界界 e\u0301 😀 end  ";
    const lines = wrapApprovalLines(source, 9);
    assert.equal(lines.join(""), source);
    assert.ok(lines.every((line) => visibleWidth(line) <= 9));
    assert.deepEqual(wrapApprovalLines("a\n\nb", 9), ["a", "", "b"]);
    assert.throws(() => wrapApprovalLines("x", 0));
  });

  it("detects a controlled approve-before-review fault", () => {
    const assertBlocked = (viewer: ConfigApproval, results: boolean[]) => {
      viewer.render(40);
      viewer.handleInput("a");
      assert.deepEqual(results, [], "unreviewed proposal must not be approved");
    };
    const good = fixture();
    assertBlocked(good.viewer, good.results);
    const faulty = fixture();
    faulty.viewer.handleInput = () => { faulty.results.push(true); };
    assert.throws(() => assertBlocked(faulty.viewer, faulty.results), /unreviewed proposal must not be approved/);
  });
});
