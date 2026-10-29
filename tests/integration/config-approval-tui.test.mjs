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
  assert.match(stdout, /PASS: pinned Pi concise summary, source\/effective layering, narrow viewport/);
});

it("detects a faulty summary that hides classifier disablement in an isolated Pi copy", { timeout: 120_000 }, async () => {
  const copy = mkdtempSync(join(tmpdir(), "bifrost-approval-fault-"));
  try {
    for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") || ["schema.json", "bifrost.json", "package.json"].includes(name))) {
      cpSync(join(root, file), join(copy, file));
    }
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    mkdirSync(join(copy, "tests/fixtures"), { recursive: true });
    cpSync(join(root, "tests/fixtures/config-approval-extension.ts"), join(copy, "tests/fixtures/config-approval-extension.ts"));
    const path = join(copy, "config-agent.ts");
    const source = readFileSync(path, "utf8");
    const anchor = "  if (!source && !effectiveChanged) return;";
    assert.equal(source.split(anchor).length, 2, "fault must match the classifier summary gate");
    writeFileSync(path, source.replace(anchor, "  if (source || effectiveChanged) return;"));
    await assert.rejects(
      promisify(execFile)("python3", [script], { timeout: 110_000, env: { ...process.env, BIFROST_TEST_APPROVAL_ROOT: copy } }),
      (error) => { assert.match(error.stderr, /summary omits classifier status/); return true; },
    );
  } finally { rmSync(copy, { recursive: true, force: true }); }
});
