// Deterministic coverage for the terminal-screen parser that renders Bifrost's
// UI snapshots. The parser is Python, so each case replays a small ANSI fixture
// through the real `scripts/ui-smoke.py` Screen class. Only image rendering
// needs Pillow, so these cases run on the documented `npm ci` setup; the UI
// smoke job installs Pillow separately for the snapshots themselves.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WIDTH = 12;

const RENDER = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ui_smoke", sys.argv[3])
module = importlib.util.module_from_spec(spec)
sys.modules["ui_smoke"] = module
spec.loader.exec_module(module)
screen = module.Screen(int(sys.argv[1]), int(sys.argv[2]))
screen.parse(sys.stdin.buffer.read().decode("utf-8", "replace"))
print("\\n".join(screen.lines()), end="")
`;

/** Replay ANSI bytes through a capture parser and return its rows. */
function render(ansi, height = 4, parser = join(ROOT, "scripts", "ui-smoke.py")) {
  return execFileSync("python3", ["-B", "-c", RENDER, String(WIDTH), String(height), parser], {
    cwd: ROOT, input: ansi, encoding: "utf8",
  }).split("\n");
}

/** A row padded to the terminal width, exactly how Pi emits a frame line. */
const padded = (text) => `${text}${" ".repeat(Math.max(0, WIDTH - text.length))}`;

/** One full frame: home the cursor, then emit both padded rows. */
const frame = `\x1b[H${"R".repeat(WIDTH)}\r\n${padded("anchor")}\r\n`;

describe("ui-smoke screen parser", () => {
  it("loads and parses without Pillow installed", () => {
    // `npm test` discovers this file on a machine that only ran `npm ci`, which
    // does not install Pillow. Importing the module must not require it.
    const script = `
import importlib.abc, importlib.util, sys
class BlockPillow(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name == "PIL" or name.startswith("PIL."):
            raise ModuleNotFoundError("No module named 'PIL'")
        return None
sys.meta_path.insert(0, BlockPillow())
sys.modules.pop("PIL", None)
spec = importlib.util.spec_from_file_location("ui_smoke", "scripts/ui-smoke.py")
module = importlib.util.module_from_spec(spec)
sys.modules["ui_smoke"] = module
spec.loader.exec_module(module)
screen = module.Screen(4, 2)
screen.parse("abcd")
print("|".join(screen.lines()), end="")
`;
    const rows = execFileSync("python3", ["-B", "-c", script], { cwd: ROOT, encoding: "utf8" });
    assert.equal(rows, "abcd|", "the parser must work with no image renderer installed");
  });

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
    // written. The mutation is applied to the production parser itself, so a
    // parser change that makes the anchor assertion insensitive shows up here
    // as a fault control that no longer goes RED.
    const source = readFileSync(join(ROOT, "scripts", "ui-smoke.py"), "utf8");
    const deferred = `        if self.col + 1 >= self.width:\n            self.col = self.width - 1\n            self.wrap_pending = True`;
    assert.ok(source.includes(deferred), "the deferred-wrap anchor must exist in the parser");
    const mutated = source.replace(deferred, `        if self.col + 1 >= self.width:\n            self.newline()`);
    const dir = mkdtempSync(join(tmpdir(), "bifrost-ui-fault-"));
    try {
      const parser = join(dir, "ui-smoke.py");
      writeFileSync(parser, mutated);
      // A taller screen keeps the redraws from scrolling, so the shifted row
      // is read directly instead of through a scroll offset.
      const rows = render(frame.repeat(4), 8, parser);
      assert.notEqual(rows[1], "anchor", "an eager wrap must move the anchored row");
      assert.equal(rows[2], "anchor", "the eager wrap pushes the anchor down one row");
      // The same fixture through the real parser keeps the anchor, so the
      // difference comes from the mutation and not from the fixture.
      assert.equal(render(frame.repeat(4), 8)[1], "anchor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
