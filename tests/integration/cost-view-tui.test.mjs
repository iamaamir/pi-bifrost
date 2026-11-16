import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("renders a solid framed cost overlay at regular and narrow usable sizes", { timeout: 120_000 }, async () => {
  const script = fileURLToPath(new URL("../../scripts/test-cost-view-tui.py", import.meta.url));
  const { stdout } = await promisify(execFile)("python3", [script], { timeout: 110_000 });
  assert.match(stdout, /PASS: real Pi cost overlay keyboard and narrow resize/);
});
