import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/test-config-approval-tui.py");

it("requires complete paged approval in real pinned Pi across viewport resize", { timeout: 120_000 }, async () => {
  const { stdout } = await promisify(execFile)("python3", [fileURLToPath(new URL("../../scripts/test-config-approval-tui.py", import.meta.url))], { timeout: 110_000 });
  assert.match(stdout, /PASS: pinned Pi paged review/);
});

it("detects the original non-scrollable confirmation fault in an isolated Pi copy", { timeout: 120_000 }, async () => {
  const copy = mkdtempSync(join(tmpdir(), "bifrost-approval-fault-"));
  try {
    for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") || ["schema.json", "bifrost.json", "package.json"].includes(name))) {
      cpSync(join(root, file), join(copy, file));
    }
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    mkdirSync(join(copy, "tests/fixtures"), { recursive: true });
    cpSync(join(root, "tests/fixtures/config-approval-extension.ts"), join(copy, "tests/fixtures/config-approval-extension.ts"));
    const path = join(copy, "config-approval.ts");
    const source = readFileSync(path, "utf8");
    const anchor = "  let cancel: (() => void) | undefined;";
    assert.equal(source.split(anchor).length, 2, "fault must match one approval adapter");
    writeFileSync(path, source.replace(anchor, `  return ctx.ui.confirm(title, message);\n${anchor}`));
    await assert.rejects(
      promisify(execFile)("python3", [script], { timeout: 110_000, env: { ...process.env, BIFROST_TEST_APPROVAL_ROOT: copy } }),
      (error) => { assert.match(error.stderr, /AssertionError: unreviewed proposal wrote source/); return true; },
    );
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
