import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "tests/integration/native-faux-lifecycle.test.mjs");

for (const pipes of ["inherit", "ignore"]) {
  // One composed fault per pipe mode covers the required dimensions: the
  // shortened deadline (test timeout), inherited/absent descendant pipes, a
  // denied owned-group kill (EPERM), missing child diagnostics, and a pending
  // caller assertion that must survive retention.
  it(`bounds the submitted lifecycle parent with denied cleanup and ${pipes} descendant pipes`, { skip: process.platform === "win32", timeout: 15000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-lifecycle-control-"));
    const receipt = join(scratch, "receipts.jsonl");
    const copied = join(scratch, "tests/integration/native-faux-lifecycle.test.mjs");
    mkdirSync(dirname(copied), { recursive: true });
    const bytes = readFileSync(source);
    writeFileSync(copied, bytes);
    assert.equal(createHash("sha256").update(readFileSync(copied)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    // The copied parent imports the shared fixture by relative path; link both
    // shared trees so the submitted worker loads real modules (never a startup
    // error that would masquerade as the intended assertion fault).
    symlinkSync(join(root, "scripts"), join(scratch, "scripts"));
    symlinkSync(join(root, "tests", "fixtures"), join(scratch, "tests", "fixtures"));
    const preload = join(scratch, "intercept.cjs");
    // Only this private worker is intercepted. Receipts are captured at spawn;
    // the outer process keeps its real kill implementation for restoration.
    writeFileSync(preload, `
const cp = require("node:child_process");
const fs = require("node:fs");
const originalSpawn = cp.spawn;
const originalKill = process.kill.bind(process);
const owned = new Set();
cp.spawn = (command, args, options) => {
  const descendant = "setInterval(() => {}, 1000)";
  const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(descendant) + "], {stdio: '${pipes}'}); c.unref();";
  const child = originalSpawn(command, ["-e", code], {...options, env: {PATH: process.env.PATH}});
  owned.add(child.pid);
  fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid: child.pid, scratch: options.env.BIFROST_NATIVE_LIFECYCLE_SCRATCH}) + "\\n");
  return child;
};
process.kill = (pid, signal) => {
  if (owned.has(-pid) && signal !== 0) { const error = new Error("controlled owned-group denial"); error.code = "EPERM"; throw error; }
  return originalKill(pid, signal);
};
const originalTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 120000 ? 100 : ms, ...args);
require("node:module").syncBuiltinESMExports();
`);
    let worker;
    let closed = false;
    let receipts = [];
    let output = "";
    let bound;
    try {
      const result = await new Promise((resolve, reject) => {
        worker = spawn(process.execPath, ["--require", preload, copied], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
        worker.stdout.on("data", chunk => { output += chunk; });
        worker.stderr.on("data", chunk => { output += chunk; });
        bound = setTimeout(() => reject(new Error(`submitted parent exceeded outer bound: ${output}`)), 5000);
        worker.once("error", reject);
        worker.once("close", code => { closed = true; clearTimeout(bound); resolve(code); });
      });
      assert.notEqual(result, 0, "pending caller assertion must survive retention");
      assert.match(output, /guard probe (must finish|process group must be gone)/);
      assert.match(output, /retaining scratch without verified owned-group death/);
      // Missing diagnostics: the intercepted child emits no transcript, yet the
      // pending assertion still names the guard-probe failure and no scenario ran.
      assert.doesNotMatch(output, /own scripted response/, "missing diagnostics must not mask the pending assertion");
      receipts = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
      console.log(JSON.stringify({ sourceSha256: createHash("sha256").update(bytes).digest("hex"), pipes, receipts, output }));
      assert.equal(receipts.length, 1, "the failed first probe must stop the parent");
      for (const owned of receipts) {
        assert.ok(Number.isInteger(owned.pid) && owned.pid > 0, "real creation-time ownership receipt required");
        assert.equal(processGroupExists(owned.pid), true, "denied signals must leave a real survivor");
        assert.equal(existsSync(owned.scratch), true, "live group scratch must be retained");
      }
    } finally {
      clearTimeout(bound);
      if (existsSync(receipt)) receipts = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
      for (const owned of receipts) {
        assert.ok(Number.isInteger(owned.pid) && owned.pid > 0);
        assert.equal(await terminateProcessGroup({ pid: owned.pid }, { graceMs: 100, cleanupTimeoutMs: 2000 }), true, "outer restoration must independently prove group absence");
        assert.equal(processGroupExists(owned.pid), false);
        rmSync(owned.scratch, { recursive: true, force: true });
      }
      if (worker && !closed) {
        const closure = new Promise(resolve => worker.once("close", resolve));
        worker.kill("SIGKILL");
        await closure;
        closed = true;
      }
      if (!worker || closed) rmSync(scratch, { recursive: true, force: true });
    }
  });
}
