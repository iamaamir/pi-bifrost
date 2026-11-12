// Controlled source-copy fault runner for G08 (P2).
//
// The runner never edits the committed tree. It builds a private mkdtemp
// scratch copy with one production module replaced by a mutable real file and
// the test tree copied, then runs one named assertion against pristine,
// mutated, and restored sources. Each nested runner is a detached process-group
// leader; ownership is captured at creation, the close event is observed, and
// the group must be independently proven absent before the scratch is removed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processGroupExists } from "../../scripts/acceptance/core.mjs";

const MAX_CAPTURE = 64 * 1024;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function append(current, chunk) {
  return current.length >= MAX_CAPTURE ? current : current + chunk.slice(0, MAX_CAPTURE - current.length);
}

function createScratch(root, targetFile) {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-g08-fault-"));
  for (const entry of readdirSync(root)) {
    if (entry === "tests" || entry === targetFile) continue;
    symlinkSync(join(root, entry), join(scratch, entry));
  }
  cpSync(join(root, "tests"), join(scratch, "tests"), { recursive: true });
  mkdirSync(dirname(join(scratch, targetFile)), { recursive: true });
  writeFileSync(join(scratch, targetFile), readFileSync(join(root, targetFile)));
  return scratch;
}

function signalGroup(groupId, signal) {
  try { process.kill(-groupId, signal); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

async function terminateGroup(_child, closePromise, groupId) {
  // The group may already be gone; ESRCH is swallowed by signalGroup. Escalate
  // only on a bounded grace window, then always await the observed close.
  signalGroup(groupId, "SIGTERM");
  await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  signalGroup(groupId, "SIGKILL");
  await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  await closePromise;
}

function runNamed({ scratch, testFile, testName, timeoutMs = 60_000 }) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.BIFROST_ACCEPTANCE_EVENTS;
  const child = spawn(process.execPath, [
    "--test", "--experimental-strip-types", `--test-name-pattern=${testName}`, testFile,
  ], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const groupId = child.pid;
  assert.equal(typeof groupId, "number", "the nested runner must expose a creation-time group id");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  let timedOut = false;
  let forceTimer;
  const closePromise = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup(groupId, "SIGTERM");
    forceTimer = setTimeout(() => signalGroup(groupId, "SIGKILL"), 2_000);
  }, timeoutMs);
  return (async () => {
    const result = await closePromise;
    clearTimeout(timer);
    clearTimeout(forceTimer);
    await terminateGroup(child, closePromise, groupId);
    assert.equal(processGroupExists(groupId), false, `nested runner group ${groupId} must be proven absent`);
    return { ...result, stdout, stderr, timedOut };
  })().catch(async (error) => {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    await terminateGroup(child, closePromise, groupId).catch(() => {});
    if (processGroupExists(groupId)) error.message += `; owned group ${groupId} is still present and the scratch was retained`;
    throw error;
  });
}

/**
 * Run GREEN (pristine), RED (mutated), GREEN (restored) for one named test.
 * The mutation callback receives the target source text and must return mutated
 * text. The RED run must fail with an AssertionError containing expectedRed.
 */
export async function runControlledFault({ root, testFile, targetFile, testName, expectedRed, mutation }) {
  const scratch = createScratch(root, targetFile);
  const pristine = readFileSync(join(root, targetFile));
  const targetPath = join(scratch, targetFile);
  const pristineTestPath = join(scratch, testFile);
  assert.ok(readFileSync(pristineTestPath, "utf8").includes(testName), "the copied test file must contain the named assertion");
  try {
    const baselineRun = await runNamed({ scratch, testFile, testName });
    assert.equal(baselineRun.timedOut, false, "the baseline named assertion must finish inside its deadline");
    assert.equal(baselineRun.code, 0, `baseline named assertion must pass:\n${baselineRun.stdout}\n${baselineRun.stderr}`);

    const mutated = mutation(pristine.toString("utf8"));
    assert.notEqual(sha256(mutated), sha256(pristine), "the controlled mutation must change the target source");
    writeFileSync(targetPath, mutated);
    const redRun = await runNamed({ scratch, testFile, testName });
    assert.notEqual(redRun.code, 0, `mutated source must turn the named assertion RED:\n${redRun.stdout}\n${redRun.stderr}`);
    assert.match(`${redRun.stdout}\n${redRun.stderr}`, /AssertionError/u, "the controlled fault must fail a named assertion, not startup or syntax");
    assert.ok(`${redRun.stdout}\n${redRun.stderr}`.includes(expectedRed), `RED output must contain ${expectedRed}`);

    writeFileSync(targetPath, pristine);
    assert.equal(sha256(readFileSync(targetPath)), sha256(pristine), "the scratch target must be restored byte-for-byte");
    const restoredRun = await runNamed({ scratch, testFile, testName });
    assert.equal(restoredRun.code, 0, `restored named assertion must pass again:\n${restoredRun.stdout}\n${restoredRun.stderr}`);
    assert.equal(sha256(readFileSync(join(root, targetFile))), sha256(pristine), "the committed production file must remain untouched");
    return { scratch, baseline: baselineRun, red: redRun, restored: restoredRun };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
