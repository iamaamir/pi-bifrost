// Deterministic coverage for the terminal-screen parser that renders Bifrost's
// UI snapshots. The parser is Python, so each case replays a small ANSI fixture
// through the real `scripts/ui-smoke.py` Screen class; Pillow is imported by
// that module, and CI installs it for the UI smoke job already.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WIDTH = 12;

const RENDER = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ui_smoke", "scripts/ui-smoke.py")
module = importlib.util.module_from_spec(spec)
sys.modules["ui_smoke"] = module
spec.loader.exec_module(module)
screen = module.Screen(int(sys.argv[1]), int(sys.argv[2]))
screen.parse(sys.stdin.buffer.read().decode("utf-8", "replace"))
print("\\n".join(screen.lines()), end="")
`;

/** Replay ANSI bytes through the real capture parser and return its rows. */
function render(ansi, height = 4) {
  return execFileSync("python3", ["-B", "-c", RENDER, String(WIDTH), String(height)], {
    cwd: ROOT, input: ansi, encoding: "utf8",
  }).split("\n");
}

/** A row padded to the terminal width, exactly how Pi emits a frame line. */
const padded = (text) => `${text}${" ".repeat(Math.max(0, WIDTH - text.length))}`;

/** One full frame: home the cursor, then emit both padded rows. */
const frame = `\x1b[H${"R".repeat(WIDTH)}\r\n${padded("anchor")}\r\n`;

describe("ui-smoke screen parser", () => {
  it("defers the wrap at the terminal edge", () => {
    const rows = render(`${"A".repeat(WIDTH)}\r\n${"B"}`);
    assert.equal(rows[0], "A".repeat(WIDTH));
    assert.equal(rows[1], "B", "the row after a full-width line keeps its place");
  });

  it("keeps a padded frame anchored across redraws", () => {
    // Pi redraws by homing the cursor and re-emitting padded rows. Eager
    // wrapping would add one blank row per padded row, so the anchor drifts.
    const rows = render(frame.repeat(4));
    assert.equal(rows[0], "R".repeat(WIDTH));
    assert.equal(rows[1], "anchor");
    assert.equal(rows[2], "");
  });

  it("fault control: an eager wrap moves the anchored row", () => {
    // The defect this guards against: wrapping as soon as the last column is
    // written. The same fixture must then lose the anchor's row.
    let row = 0;
    let col = 0;
    const lines = ["", "", "", ""];
    const write = (ch) => {
      if (ch === "\x1b") return;
      if (ch === "\r") { col = 0; return; }
      if (ch === "\n") { row += 1; col = 0; return; }
      if (row < lines.length) lines[row] = (lines[row] ?? "").padEnd(col) + ch;
      col += 1;
      if (col >= WIDTH) { col = 0; row += 1; } // eager wrap
    };
    for (const ch of frame.repeat(4)) write(ch);
    assert.notEqual(lines[1], "anchor", "an eager wrap must not satisfy the anchor assertion");
  });
});
