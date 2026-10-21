import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execPath } from "node:process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = join(root, "tests", "fixtures", "native-activation-cancel-child.mjs");
const guard = join(root, "scripts", "test-outbound-guard.cjs");
const credentials = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const DEADLINE_MS = 120_000;
const PRODUCTION_SHA256 = "14752568bd935068ca5874156bd324f45336dc29bd305523fe6e0ca5973c3303";
const LATE_ABORT_GUARD = `      if (ctx.signal?.aborted) {
        endClassify({ kind: classification.kind, outcome: "aborted" });
        endInput({ outcome: "aborted" });
        return routeBoundary
          ? strictInputHandled(ctx, state, originalText, editorTextAtInput, "Bifrost routing was cancelled; the turn was not sent. Resubmit after repair.")
          : defaultAction;
      }`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroupGone(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupId)) return true;
    await delay(25);
  }
  return !processGroupExists(groupId);
}

// Bounded, owned-child runner. Every child is a detached process-group leader
// with an explicit deadline; on expiry the whole group is terminated through the
// shared acceptance helper. The result reports the observed close and whether the
// owned group is independently gone, so the caller can refuse to delete scratch
// while a group might still live.
function runNode(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const spawnedAt = Date.now();
    const groupId = childProcess.pid;
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let deadlineExceeded = false;
    let settled = false;
    let closeObserved = false;
    let timer = null;

    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr?.on("data", (chunk) => { stderr += chunk; });

    const closePromise = new Promise((resolveClose) => {
      childProcess.once("close", (code, signal) => {
        closeObserved = true;
        exitCode = code;
        exitSignal = signal;
        resolveClose();
      });
    });

    async function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let groupGone = false;
      if (process.platform !== "win32" && Number.isInteger(groupId) && groupId > 0) {
        groupGone = await waitForGroupGone(groupId, 500);
        if (!groupGone) {
          try { await terminateProcessGroup(childProcess, { graceMs: 2_000, cleanupTimeoutMs: 5_000 }); } catch {}
          groupGone = !processGroupExists(groupId);
        }
      }
      if (!closeObserved) {
        let drainTimer;
        await Promise.race([closePromise, new Promise((resolveDrain) => { drainTimer = setTimeout(resolveDrain, 500); })]);
        clearTimeout(drainTimer);
      }
      if (!closeObserved) {
        childProcess.stdout?.destroy();
        childProcess.stderr?.destroy();
      }
      childProcess.unref();
      resolve({ status: exitCode, signal: exitSignal, stdout, stderr, deadlineExceeded, groupId, spawnPid: childProcess.pid, spawnedAt, groupGone, closeObserved });
    }

    timer = setTimeout(() => {
      deadlineExceeded = true;
      void settle();
    }, timeoutMs);

    closePromise.then(() => { if (!deadlineExceeded) void settle(); });
    childProcess.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

it("cancels real AgentSession activation behind a proven deny-all fence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-activation-"));
  const violations = join(scratch, "network-violations.log");
  const previousCredentials = Object.fromEntries(credentials.map((name) => [name, process.env[name]]));
  // The child never deletes scratch; the parent reclaims it only when every owned
  // group is independently proven gone. A spawn error or unverified group death
  // retains the scratch and names it for inspection.
  let cleanupVerified = true;
  let runCounter = 0;
  let lastScenario = "setup";
  let isolatedEnv;
  async function runOwned(args, options) {
    try {
      const result = await runNode(args, options);
      if (result.groupGone !== true || result.closeObserved !== true) cleanupVerified = false;
      return result;
    } catch (error) {
      cleanupVerified = false;
      throw error;
    }
  }
  async function runScenario(scenario, env = {}) {
    runCounter += 1;
    lastScenario = scenario;
    const runScratch = join(scratch, `run-${runCounter}-${scenario}`);
    mkdirSync(runScratch, { recursive: true });
    writeFileSync(violations, "");
    const result = await runOwned(["--test", "--experimental-strip-types", child], {
      cwd: root,
      env: { ...isolatedEnv, BIFROST_NATIVE_ACTIVATION_SCRATCH: runScratch, BIFROST_NATIVE_ACTIVATION_SCENARIO: scenario, ...env },
      timeoutMs: DEADLINE_MS,
    });
    return { ...result, runScratch };
  }

  function assertOwnedReceipt(result, label) {
    if (process.platform === "win32") return;
    assert.equal(result.groupGone, true, `${label} owned process group must be gone`);
    assert.equal(result.closeObserved, true, `${label} owned child close must be observed`);
    assert.equal(result.groupId, result.spawnPid, `${label} spawn-time receipt must identify the detached process-group leader`);
  }

  try {
    for (const name of credentials) process.env[name] = "ambient-secret-fixture";
    isolatedEnv = {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      BIFROST_TEST_DENY_ALL: "1",
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      NODE_OPTIONS: `--require=${guard}`,
    };
    for (const name of credentials) assert.equal(isolatedEnv[name], undefined, `${name} must not enter child env`);

    // Positive guard probe first: the deny-all fence must block fetch, socket, and
    // UDP before any scenario is credited with zero violations.
    lastScenario = "guard-probe";
    writeFileSync(violations, "");
    const probe = await runOwned(["-e", `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      const assert = require("node:assert/strict");
      (async () => {
        for (const url of ["http://127.0.0.1:2", "https://127.0.0.1:2"]) {
          await assert.rejects(async () => fetch(url, { signal: AbortSignal.timeout(500) }), /blocked fetch/);
        }
        for (const socket of [new net.Socket(), new tls.TLSSocket()]) {
          socket.on("error", () => {});
          try { assert.throws(() => socket.connect({ port: 2, host: "127.0.0.1" }), /blocked socket connection/); }
          finally { socket.destroy(); }
        }
        const udp = dgram.createSocket("udp4");
        udp.on("error", () => {});
        try { assert.throws(() => udp.send(Buffer.from("fixture"), 2, "127.0.0.1"), /blocked UDP datagram/); }
        finally { try { udp.close(); } catch {} }
        if (${JSON.stringify(credentials)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: root, env: isolatedEnv });
    assert.equal(probe.deadlineExceeded, false, `guard probe must finish inside its bounded deadline\n${probe.stdout}\n${probe.stderr}`);
    assertOwnedReceipt(probe, "guard probe");
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const attempts = readFileSync(violations, "utf8");
    assert.match(attempts, /blocked fetch to https?:\/\/[^:\s]+:\d/);
    assert.match(attempts, /blocked socket connection to [^\s]+:\d/);
    assert.match(attempts, /blocked UDP datagram to/);

    // GREEN: real AgentSession + real extension. Cancellation scenarios must
    // produce zero forbidden provider callbacks; failed-activation scenarios
    // must preserve the seed model and keep the turn unsent after the real host
    // setModel returns false or throws.
    const hostMarkers = {
      "activation-false": /HOST_SETMODEL=returned:false/,
      "activation-throw": /HOST_SETMODEL=threw:No API key for faux-target\/physical/,
    };
    for (const scenario of ["cancel-late-classifier", "manual-override", "activation-false", "activation-throw"]) {
      const green = await runScenario(scenario);
      assert.equal(green.deadlineExceeded, false, `${scenario} must complete inside its bounded deadline\n${green.stdout}\n${green.stderr}`);
      assertOwnedReceipt(green, scenario);
      assert.equal(green.status, 0, `${scenario}\n${green.stdout}\n${green.stderr}`);
      if (hostMarkers[scenario]) {
        assert.match(green.stdout, hostMarkers[scenario], `${scenario} must prove the real host setModel outcome`);
      }
      assert.equal(readFileSync(violations, "utf8"), "", `${scenario} made a blocked outbound attempt`);
    }

    // Sensitivity proofs use private scratch copies of index.ts so production
    // source is never modified. Each fault removes the exact handling for one
    // real host outcome and must fail the named child assertion.
    const original = readFileSync(join(root, "index.ts"), "utf8");
    assert.equal(sha256(original), PRODUCTION_SHA256, "production index.ts must match the reviewed baseline hash");
    assert.ok(original.includes(LATE_ABORT_GUARD), "the late-abort guard must exist in production source");

    let mutantCounter = 0;
    function prepareMutant(label, source) {
      mutantCounter += 1;
      const mutantDir = join(scratch, `mutant-${mutantCounter}-${label}`);
      mkdirSync(mutantDir, { recursive: true });
      for (const file of readdirSync(root)) {
        if (file.endsWith(".ts") || file === "bifrost.json") copyFileSync(join(root, file), join(mutantDir, file));
      }
      writeFileSync(join(mutantDir, "index.ts"), source);
      symlinkSync(join(root, "node_modules"), join(mutantDir, "node_modules"));
      return join(mutantDir, "index.ts");
    }

    // (1) Late-abort guard: the routed target must not become selected.
    const lateAbortMutantSource = original.replace(LATE_ABORT_GUARD, "      console.error('MUTANT_GUARD_REMOVED_REACHED');");
    assert.notEqual(lateAbortMutantSource, original, "late-abort fault injection must change the production source");
    const lateAbortRed = await runScenario("cancel-late-classifier", { BIFROST_NATIVE_ACTIVATION_EXTENSION: prepareMutant("late-abort", lateAbortMutantSource) });
    assert.equal(lateAbortRed.deadlineExceeded, false, `late-abort mutant run must finish inside its bounded deadline\n${lateAbortRed.stdout}\n${lateAbortRed.stderr}`);
    assertOwnedReceipt(lateAbortRed, "late-abort mutant");
    assert.notEqual(lateAbortRed.status, 0, `the guard-removed mutant must fail the native forbidden-dispatch assertion\n${lateAbortRed.stdout}\n${lateAbortRed.stderr}`);
    assert.match(`${lateAbortRed.stdout}\n${lateAbortRed.stderr}`, /forbidden late dispatch observable/,
      "the late-abort mutant failure must be the intended forbidden-dispatch assertion");
    assert.equal(readFileSync(violations, "utf8"), "", "late-abort mutant run made a blocked outbound attempt");

    // (2) False handling: ignoring the real host false would send the turn on
    // the stale seed model instead of keeping it unsent.
    const FALSE_FAILURE_GUARD = "      if (!ok) {";
    assert.ok(original.includes(FALSE_FAILURE_GUARD), "the failed-activation branch must exist in production source");
    const falseMutantSource = original.replace(FALSE_FAILURE_GUARD, "      if (false) {");
    assert.notEqual(falseMutantSource, original, "false-activation fault injection must change the production source");
    const falseRed = await runScenario("activation-false", { BIFROST_NATIVE_ACTIVATION_EXTENSION: prepareMutant("activation-false", falseMutantSource) });
    assert.equal(falseRed.deadlineExceeded, false, `false-activation mutant run must finish inside its bounded deadline\n${falseRed.stdout}\n${falseRed.stderr}`);
    assertOwnedReceipt(falseRed, "false-activation mutant");
    assert.notEqual(falseRed.status, 0, `the false-ignoring mutant must fail the native stale-model assertion\n${falseRed.stdout}\n${falseRed.stderr}`);
    assert.match(`${falseRed.stdout}\n${falseRed.stderr}`, /the failed activation must not send the turn on the stale model/,
      "the false-activation mutant failure must be the intended stale-model assertion");
    assert.equal(readFileSync(violations, "utf8"), "", "false-activation mutant run made a blocked outbound attempt");

    // (3) Throw handling: swallowing the real host throw and treating it as
    // success would send the turn on the stale seed model.
    const THROW_SWALLOW_ANCHOR = "        setModelError = err;";
    assert.ok(original.includes(THROW_SWALLOW_ANCHOR), "the setModel catch branch must exist in production source");
    const throwMutantSource = original.replace(THROW_SWALLOW_ANCHOR, "        setModelError = err;\n        ok = true;");
    assert.notEqual(throwMutantSource, original, "throw-activation fault injection must change the production source");
    const throwRed = await runScenario("activation-throw", { BIFROST_NATIVE_ACTIVATION_EXTENSION: prepareMutant("activation-throw", throwMutantSource) });
    assert.equal(throwRed.deadlineExceeded, false, `throw-activation mutant run must finish inside its bounded deadline\n${throwRed.stdout}\n${throwRed.stderr}`);
    assertOwnedReceipt(throwRed, "throw-activation mutant");
    assert.notEqual(throwRed.status, 0, `the throw-swallowing mutant must fail the native stale-model assertion\n${throwRed.stdout}\n${throwRed.stderr}`);
    assert.match(`${throwRed.stdout}\n${throwRed.stderr}`, /the failed activation must not send the turn on the stale model/,
      "the throw-activation mutant failure must be the intended stale-model assertion");
    assert.equal(readFileSync(violations, "utf8"), "", "throw-activation mutant run made a blocked outbound attempt");

    // GREEN restored: the pristine extension passes every faulted scenario again.
    for (const scenario of ["cancel-late-classifier", "activation-false", "activation-throw"]) {
      const restored = await runScenario(scenario);
      assert.equal(restored.deadlineExceeded, false, `restored ${scenario} run must finish inside its bounded deadline\n${restored.stdout}\n${restored.stderr}`);
      assertOwnedReceipt(restored, `restored ${scenario}`);
      assert.equal(restored.status, 0, `restored ${scenario} run\n${restored.stdout}\n${restored.stderr}`);
      if (hostMarkers[scenario]) assert.match(restored.stdout, hostMarkers[scenario], `restored ${scenario} must still prove the real host setModel outcome`);
      assert.equal(readFileSync(violations, "utf8"), "", `restored ${scenario} run made a blocked outbound attempt`);
    }
    assert.equal(sha256(readFileSync(join(root, "index.ts"), "utf8")), PRODUCTION_SHA256,
      "production index.ts must remain unchanged after all mutant runs");
  } finally {
    for (const [name, value] of Object.entries(previousCredentials)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (cleanupVerified) {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      process.stderr.write(`[native-activation] retaining scratch without verified owned-group death after ${lastScenario}: ${scratch}\n`);
    }
  }
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
