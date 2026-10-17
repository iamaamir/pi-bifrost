import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execPath } from "node:process";
import { spawn } from "node:child_process";
import { processGroupExists } from "../../scripts/acceptance/core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF = join(__dirname, "child-auto-inline.test.mjs");
const CORE = join(__dirname, "..", "..", "scripts", "acceptance", "core.mjs");
const HARNESS = join(__dirname, "..", "fixtures", "child-auto-inline-harness.mjs");

// A return from a test finally replaces the pending throw and falsely passes.
// The retainOrRemoveScratch helper may return (it returns from the helper, so
// the caller's pending error still propagates). Direct test finalizers must
// rethrow the pending error, retain scratch, and preserve the failure.
describe("lifecycle finally preserves pending failures", { timeout: 60_000, concurrency: 1 }, () => {
  it("contains no direct-finally return that would swallow a pending failure", () => {
    const source = readFileSync(SELF, "utf8");
    const helperStart = source.indexOf("function retainOrRemoveScratch");
    const helperEnd = source.indexOf("// Best-effort descendant reaping");
    assert.ok(helperStart >= 0 && helperEnd > helperStart, "retention helper must exist");
    const helper = source.slice(helperStart, helperEnd);
    const rest = source.slice(0, helperStart) + source.slice(helperEnd);
    assert.equal((helper.match(/if \(pendingError\) return;/g) ?? []).length, 2,
      "the retention helper keeps its two helper-local returns");
    assert.equal((rest.match(/if \(pendingError\) return;/g) ?? []).length, 0,
      "direct test finalizers must not return while a failure is pending");
    assert.equal((rest.match(/if \(pendingError\) throw pendingError;/g) ?? []).length, 8,
      "all eight direct-finally paths must propagate the pending failure");
  });

  it("fails the worker when a pending failure meets unverified cleanup", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-finally-prop-"));
    const childTest = join(scratch, "finally-prop.mjs");
    let worker = null;
    let pendingError = null;
    try {
      // Minimal worker using the actual harness seam: denied owned-group
      // signals make the real stopChild report false, so the original
      // assertion fails and the fixed finally must propagate it nonzero.
      // Plain worker (not node:test) to avoid nested test-runner recursion.
      const childSource = `
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { processGroupExists } from ${JSON.stringify(CORE)};
import { spawnOwned, stopChild, setOwnedGroupSignalDenial } from ${JSON.stringify(HARNESS)};
await (async () => {
const dir = mkdtempSync(join(tmpdir(), "bifrost-finally-child-"));
const child = spawnOwned(execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "ignore", "ignore"], cwd: dir });
let pending = null;
try {
  setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });
  let verified = false;
  try { verified = await stopChild(child, 200); } finally { setOwnedGroupSignalDenial(null); }
  assert.equal(verified, true, "force-kill must reach a verified close");
} catch (error) { pending = error; throw error; }
finally {
  if (existsSync(dir)) {
    const verified = await stopChild(child, 200);
    if (!verified || processGroupExists(child.pid)) {
      if (pending) throw pending;
      throw new Error("refusing to delete scratch while owned group still alive");
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
})();
`;
      writeFileSync(childTest, childSource);
      const output = await new Promise((resolve, reject) => {
        worker = spawn(execPath, [childTest], { stdio: ["pipe", "pipe", "pipe"] });
        let text = "";
        worker.stdout.setEncoding("utf8");
        worker.stderr.setEncoding("utf8");
        worker.stdout.on("data", (c) => { text += c; });
        worker.stderr.on("data", (c) => { text += c; });
        const bound = setTimeout(() => {
          try { worker.kill("SIGKILL"); } catch {}
          reject(new Error("regression worker stayed pending past its bound"));
        }, 30_000);
        worker.once("error", (e) => { clearTimeout(bound); reject(e); });
        worker.once("close", (code) => { clearTimeout(bound); resolve({ code, text }); });
      });
      assert.notEqual(output.code, 0, `worker with pending failure + unverified cleanup must exit nonzero, got ${output.code}: ${output.text.slice(-2000)}`);
      assert.match(output.text, /force-kill must reach a verified close/, "the original assertion must survive the finally");
    } catch (error) {
      pendingError = error;
      throw error;
    } finally {
      if (worker) {
        try { worker.kill("SIGKILL"); } catch {}
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try { process.kill(worker.pid, 0); } catch (check) {
            if (check.code === "ESRCH") break;
            else throw check;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        if (existsSync(scratch)) {
          let alive = true;
          try { process.kill(worker.pid, 0); alive = true; } catch (check) {
            if (check.code === "ESRCH") alive = false;
            else throw check;
          }
          if (alive) {
            if (pendingError) throw pendingError;
            throw new Error(`refusing to delete scratch while regression worker ${worker.pid} still alive: ${scratch}`);
          }
          rmSync(scratch, { recursive: true, force: true });
        } else if (processGroupExists(worker.pid)) {
          if (pendingError) throw pendingError;
          throw new Error(`refusing to finish while regression worker group ${worker.pid} still alive`);
        }
      } else if (existsSync(scratch)) {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });
});
