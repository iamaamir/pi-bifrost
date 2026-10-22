// Replay fault control for G03 (P1): fault-sensitivity bindings for replay guards.
//
// This module is a *scratch/process* helper, not a runtime dependency of any
// production code. It executes the controlled fault proof that binds the
// existing replay-safety assertions in tests/integration/auto-virtual.test.mjs
// and tests/integration/reliability-v2-auto.test.mjs to the production guards
// in index.ts.
//
// GUARD INVENTORY (index.ts, baseline a792cb173317744d12950698009d11c7ea0b39b2):
//   - isSideEffectFreeAllowanceFailure (exact line 1764) — proves a failed
//     attempt had no output/tool results/queued work before allowance recovery.
//   - autoBoundaryStillActive (exact line 1707) — confirms the original user
//     boundary is still the active turn.
//   - allowanceRetryBoundaryStillSafe (exact line 2525) — re-checks the boundary
//     immediately before dispatching the prepared allowance retry.
//
// CONTROLLED FAULT PROOF (performed in a disposable scratch copy, never in the
// committed tree; reproduces /Users/mak/.paseo/delivery/g03-replay-fault/proof.log):
//   1. COPY    — build a private scratch tree: symlink every repository entry
//      except index.ts and tests, copy index.ts and tests/ so the test file's
//      ROOT resolves inside the scratch tree.
//   2. GREEN   — run the named replay assertion against the pristine copied
//      index.ts. It must pass (proves the harness and baseline are healthy).
//   3. MUTATE  — inject one bounded fault (possibly across redundant guards) (see REPLAY_GUARD_MUTATORS). The
//      mutant hash must differ.
//   4. RED     — run the SAME named assertion against the mutant. It must fail
//      with the meaningful AssertionError message below, NOT a syntax/startup
//      failure and NOT a timeout that merely printed matching text.
//   5. RESTORE — write the original bytes back into the scratch tree, confirm
//      the restored hash matches the baseline, rerun the assertion (GREEN),
//      and confirm the committed index.ts was never modified.
//
// OWNED PROCESS LIFECYCLE (the correction this helper now enforces):
//   - Each nested run is spawned as the leader of a process group this module
//     owns (the reusable spawnOwned/closeTracking/stopChild pattern from
//     tests/fixtures/child-auto-inline-harness.mjs; shared helpers are not
//     edited). The owned group id is captured at creation.
//   - Every run is terminated and its close event observed before the receipt
//     is returned. A run is only trustworthy when the group is independently
//     proven dead (processGroupExists === false). A clean exit or a close event
//     alone proves nothing about descendants.
//   - The scratch tree is reclaimed only after every owned group is proven
//     dead. When ownership cannot be verified (denied signal, unknown
//     descendant) the scratch is retained with its ownership and paths and the
//     pending assertion failure is preserved rather than replaced by a delete
//     error.
//
// The caller selects a proof with the FAULT_PROOFS spec; the default is the
// original isSideEffectFreeAllowanceFailure output-effect proof.
//
// No live provider calls. No arbitrary replay in production. Scratch is private
// (mkdtemp, mode 0700), created and reclaimed by this helper; receipts are
// recorded from the real child processes, and no PID is ever guessed or killed.

import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processGroupExists } from "../../scripts/acceptance/core.mjs";
import { closeTracking, cleanupFailure, detachOwnedHandles, spawnOwned } from "./child-auto-inline-harness.mjs";

export const REPLAY_GUARD_BASELINE_SHA256 = "9fe0cfdb833d38dbffc50d1f2deed2d6ecce91b5defe708593069c03c5965041";
export const REPLAY_GUARD_FUNCTIONS = [
  "isSideEffectFreeAllowanceFailure",
  "allowanceRetryBoundaryStillSafe",
  "autoBoundaryStillActive",
];

// Guard line anchors are exact against the baseline commit; keep them in sync
// with index.ts when the guards move.
export const REPLAY_GUARD_LINES = {
  autoBoundaryStillActive: 1711,
  isSideEffectFreeAllowanceFailure: 1768,
  allowanceRetryBoundaryStillSafe: 2529,
};

// Each PROVEN pair has an executable fault reaching its exact named assertion.
// A compound fault covers one semantic claim across redundant enforcement;
// it does not attribute sensitivity to each guard. OUTSTANDING means unproven.
// `mutation` records direction; `remainingEvidence` states what is still missing.
export const NAMED_REPLAY_ASSERTIONS = [
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay a failed Auto turn after the provider emitted output",
    guard: "isSideEffectFreeAllowanceFailure",
    mutation: "return [assistantEntryId]",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an allowance failure after a synthetic tool side effect",
    guard: "autoBoundaryStillActive",
    mutation: "return false",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an unsafe tool turn and dispatches its queued follow-up once on a distinct provider",
    guard: null,
    mutation: null,
    status: "OUTSTANDING",
    remainingEvidence: "The attempted side-effect, queued-work and boundary mutations stayed GREEN. Which remaining guard masks them has not been established; continuation-admission fault sensitivity remains unproven.",
  },
  // reliability-v2-auto titles are mode-parameterized; each concrete mode is listed.
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v1 Auto",
    guard: "allowanceRetryBoundaryStillSafe",
    mutation: "return false",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v2 Auto",
    guard: "allowanceRetryBoundaryStillSafe",
    mutation: "return false",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "stops after the single alternate allowance attempt in v1 Auto",
    guard: "singleAlternateV1",
    mutation: "compound empty-recovery lineage fault; not individual-guard sensitivity",
    status: "PROVEN",
  },
  {
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "stops after the single alternate allowance attempt in v2 Auto",
    guard: "singleAlternateV2",
    mutation: "compound empty-recovery lineage fault; not individual-guard sensitivity",
    status: "PROVEN",
  },
];

/** The original proof; kept as the default so existing callers stay unchanged. */
export const FAULT_PROOF = {
  guard: "isSideEffectFreeAllowanceFailure",
  testFile: "tests/integration/auto-virtual.test.mjs",
  testName: "does not replay a failed Auto turn after the provider emitted output",
  redAssertionMessage: "the failed allowance/output-effect turn must not dispatch to an alternate",
};

/** Named fault × assertion proofs executed by the anchor tests. */
export const FAULT_PROOFS = {
  sideEffectFreeAllowanceOutputEffect: FAULT_PROOF,
  allowanceRetryBoundaryV2: {
    guard: "allowanceRetryBoundaryStillSafe",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: "retries one zero-effect allowance failure with a configured alternate in v2 Auto",
    redAssertionMessage: "the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched.",
  },
  autoBoundaryToolSideEffect: {
    guard: "autoBoundaryStillActive",
    testFile: "tests/integration/auto-virtual.test.mjs",
    testName: "does not replay an allowance failure after a synthetic tool side effect",
    redAssertionMessage: "Pi must execute the provider-requested synthetic tool",
  },
};

// Restrictive first-retry sensitivity is separate from the compound limit fault.
FAULT_PROOFS.allowanceRetryBoundaryV1 = {
  ...FAULT_PROOFS.allowanceRetryBoundaryV2,
  testName: "retries one zero-effect allowance failure with a configured alternate in v1 Auto",
  redAssertionMessage: "the prepared usage-limit retry was cancelled because the turn changed; no model was dispatched."
};

for (const mode of ["v1", "v2"]) {
  FAULT_PROOFS[`singleAlternate${mode.toUpperCase()}`] = {
    guard: `singleAlternate${mode.toUpperCase()}`,
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    testName: `stops after the single alternate allowance attempt in ${mode} Auto`,
    redAssertionMessage: "Bifrost must stop after one alternate, without trying a third model",
  };
}

// One semantic fault forgets the per-boundary recovery limit across its
// redundant representations. It preserves tool/output/queue/abort checks;
// it does not prove each redundant guard individually fault-sensitive.
function permitRepeatedEmptyRecovery(source, v2) {
  const edits = [
    ['if (`${String(message.provider)}/${String(message.model)}` !== failedModelKey\n          || message.stopReason', 'if (message.stopReason'],
    ['if (previousAttempt?.entryId === boundary.entryId && previousAttempt.userMessage.deref() === boundary.message) {', 'if (false) {'],
    ...(v2 ? [['retryEligible: activeRouteOrigin === "automatic" || activeRouteOrigin === "explicit_tier",', 'retryEligible: true,']] : []),
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error(`compound recovery fault requires one exact anchor: ${before}`);
    source = source.replace(before, after);
  }
  return source;
}

/** Injected fault per guard. `return false` proves the guard's restrictive half
 * (the assertion depends on the guard permitting the safe path). */
export const REPLAY_GUARD_MUTATORS = {
  singleAlternateV1: (source) => permitRepeatedEmptyRecovery(source, false),
  singleAlternateV2: (source) => permitRepeatedEmptyRecovery(source, true),
  isSideEffectFreeAllowanceFailure: (source) => injectGuardStatement(source, "isSideEffectFreeAllowanceFailure", "return [assistantEntryId];"),
  allowanceRetryBoundaryStillSafe: (source) => injectGuardStatement(source, "allowanceRetryBoundaryStillSafe", "return false;"),
  autoBoundaryStillActive: (source) => injectGuardStatement(source, "autoBoundaryStillActive", "return false;"),
};

function injectGuardStatement(source, guard, statement) {
  const anchor = `  function ${guard}(`;
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) throw new Error(`replay guard anchor not found: ${guard}`);
  const openBrace = source.indexOf("{\n", anchorIndex);
  if (openBrace === -1) throw new Error(`replay guard body opening brace not found: ${guard}`);
  return `${source.slice(0, openBrace + 1)}\n    ${statement}${source.slice(openBrace + 1)}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Inject `return [assistantEntryId];` at the entry of
 * isSideEffectFreeAllowanceFailure so every call approves the failed attempt.
 * Throws if the function anchor is missing.
 */
export function mutateReplayGuard(source) {
  return REPLAY_GUARD_MUTATORS.isSideEffectFreeAllowanceFailure(source);
}

/**
 * Build a private scratch copy of `root` where index.ts and tests/ are real
 * files (so the copied test file computes its ROOT inside the scratch tree) and
 * every other repository entry is symlinked. Returns the scratch path.
 */
export function createReplayScratchTree(root, scratchPrefix = "bifrost-g03-fault-") {
  const scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
  for (const entry of readdirSync(root)) {
    if (["node_modules", "index.ts", "tests"].includes(entry)) continue;
    symlinkSync(join(root, entry), join(scratch, entry));
  }
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
  copyFileSync(join(root, "index.ts"), join(scratch, "index.ts"));
  cpSync(join(root, "tests"), join(scratch, "tests"), { recursive: true });
  return scratch;
}

/**
 * Run one named replay assertion in `scratch` under an owned process group.
 * Spawns the nested runner detached as its own group leader (captured at
 * creation), bounds the run, then always terminates the group and records
 * whether its death was independently verified. `command`/`args` are injectable
 * so focused lifecycle controls can drive private CLI fixtures. `onOwned` is
 * invoked synchronously with the owned group id the instant the leader exists,
 * before any await can throw, so a caller can retain ownership even when the
 * runner never reaches its return. Returns the process receipt; it never
 * deletes anything.
 */
export async function runNamedReplayAssertion({
  scratch,
  testFile,
  testName,
  timeoutMs = 180_000,
  terminationGraceMs = 2_000,
  env = process.env,
  command = process.execPath,
  args,
  onOwned,
} = {}) {
  const childEnv = { ...env };
  // A nested `node --test` must not inherit the runner's child marker.
  delete childEnv.NODE_TEST_CONTEXT;
  // Keep the outer acceptance event stream clean; the nested run has its own.
  delete childEnv.BIFROST_ACCEPTANCE_EVENTS;
  const resolvedArgs = args ?? [
    "--test",
    "--experimental-strip-types",
    `--test-name-pattern=${testName}`,
    testFile,
  ];
  const child = spawnOwned(command, resolvedArgs, {
    cwd: scratch,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Ownership is captured at creation, before any later await can throw.
  const ownedGroup = child.pid;
  if (typeof onOwned === "function") onOwned(ownedGroup);

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });

  let timedOut = false;
  let timer;
  const bounded = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve({ code: null, signal: null }); }, timeoutMs);
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const failedToSpawn = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error }));
  });
  const outcome = await Promise.race([closed, failedToSpawn, bounded]);
  clearTimeout(timer);

  // Always terminate and verify ownership, even after a clean close: a close
  // event says nothing about a descendant that inherited the pipes.
  const lifecycle = closeTracking(child);
  const verified = await lifecycle.terminate(terminationGraceMs);
  if (!verified) detachOwnedHandles(child);
  return {
    timedOut,
    status: timedOut || outcome.spawnError ? null : outcome.code,
    signal: timedOut || outcome.spawnError ? null : outcome.signal,
    stdout,
    stderr,
    spawnError: outcome.spawnError ?? null,
    ownedGroup,
    verified,
    scratchPaths: [scratch],
  };
}

function lifecycleError(message, receipt, cleanupUnverified = false) {
  const error = new Error(cleanupUnverified ? cleanupFailure(message, false) : message);
  error.kind = "g03-replay-fault-lifecycle";
  error.verified = receipt?.verified !== false;
  error.timedOut = receipt?.timedOut === true;
  error.ownedGroup = receipt?.ownedGroup ?? null;
  error.scratchPaths = receipt?.scratchPaths ?? [];
  return error;
}

/** Validate one GREEN phase receipt. Throws when the run is not a clean,
 * verified single-pass. */
export function assertAssertionGreen(receipt, phase) {
  if (receipt.timedOut) {
    throw lifecycleError(`G03 replay fault proof expected GREEN in ${phase} but the owned run exceeded its bounded window`, receipt);
  }
  if (receipt.spawnError) {
    throw lifecycleError(`G03 replay fault proof expected GREEN in ${phase} but the owned run failed to spawn: ${receipt.spawnError.message}`, receipt);
  }
  if (receipt.verified === false) {
    throw lifecycleError(`G03 replay fault proof expected GREEN in ${phase} but the owned process group cleanup could not be verified`, receipt, true);
  }
  const output = `${receipt.stdout}\n${receipt.stderr}`;
  if (receipt.status !== 0) {
    throw new Error(`G03 replay fault proof expected GREEN in ${phase} but exit was ${receipt.status}:\n${output}`);
  }
  if (!/^ℹ pass 1$/mu.test(output) || /^ℹ fail [1-9]/mu.test(output)) {
    throw new Error(`G03 replay fault proof expected exactly one passing assertion in ${phase}:\n${output}`);
  }
}

/** Validate one RED phase receipt. A timeout, a spawn failure or an unverified
 * owned-group cleanup is never valid RED evidence, even when the partial output
 * happens to contain the expected message text. */
export function assertAssertionRed(receipt, redAssertionMessage) {
  const output = `${receipt.stdout}\n${receipt.stderr}`;
  if (receipt.timedOut) {
    throw lifecycleError(`G03 replay fault proof expected RED but the owned run timed out; matching text is not valid RED evidence:\n${output}`, receipt);
  }
  if (receipt.spawnError) {
    throw lifecycleError(`G03 replay fault proof expected RED but the owned run failed to spawn: ${receipt.spawnError.message}`, receipt);
  }
  if (receipt.verified === false) {
    throw lifecycleError("G03 replay fault proof expected RED but the owned process group cleanup could not be verified", receipt, true);
  }
  if (receipt.status === 0) {
    throw new Error(`G03 replay fault proof expected RED but the mutant assertion passed:\n${output}`);
  }
  if (!/AssertionError/u.test(output)) {
    throw new Error(`G03 replay fault proof RED was not an AssertionError (syntax/startup?):\n${output}`);
  }
  if (!output.includes(redAssertionMessage)) {
    throw new Error(`G03 replay fault proof RED missing expected message ${JSON.stringify(redAssertionMessage)}:\n${output}`);
  }
}

/** Reclaim a scratch path only while its owned group is independently proven
 * dead. Refuses and names the live group otherwise. */
export function removeScratchAfterVerifiedGroupDeath(paths, ownedGroup) {
  const unique = [...new Set(paths)];
  if (!Number.isInteger(ownedGroup) || ownedGroup <= 0) {
    throw new Error(`refusing to delete scratch without owned-group ownership: ${unique.join(",")}`);
  }
  if (processGroupExists(ownedGroup)) {
    throw new Error(`refusing to delete scratch while owned process group ${ownedGroup} still alive: ${unique.join(",")}`);
  }
  for (const path of unique) rmSync(path, { recursive: true, force: true });
}

/** Decide reclaim vs. retain for a finished proof. Ownership is the union of
groups captured at creation and groups reported by receipts, so a run that
throws after spawning is still covered. Reclaim requires every started run to
have produced a verified receipt AND every owned group to be absent: any
incomplete/unknown receipt is treated as unverified and retained. A pending
assertion failure is never masked by a delete error. Returns
{ retained, ownedGroups, throwError }. */
function finalizeScratchLifecycle({ scratch, keepScratch, receipts, ownedGroupsAtCreation, startedRuns, pendingError }) {
  const ownedGroups = [...new Set([
    ...ownedGroupsAtCreation,
    ...receipts.map((receipt) => receipt?.ownedGroup).filter((group) => Number.isInteger(group) && group > 0),
  ])];
  if (keepScratch) return { retained: true, ownedGroups, throwError: null };
  const everyStartedRunReturned = startedRuns > 0 && receipts.length === startedRuns;
  const unverified = !everyStartedRunReturned
    || receipts.some((receipt) => !receipt || receipt.verified !== true);
  const liveGroups = ownedGroups.filter((group) => processGroupExists(group));
  if (unverified || liveGroups.length > 0) {
    const detail = liveGroups.length > 0 ? liveGroups.join(",") : "(unverified)";
    if (pendingError) return { retained: true, ownedGroups, throwError: null };
    const error = new Error(`G03 replay fault proof retained scratch ${scratch}: owned process group ${detail} not proven dead`);
    error.scratch = scratch;
    error.scratchRetained = true;
    error.ownedGroups = ownedGroups;
    error.verified = false;
    return { retained: true, ownedGroups, throwError: error };
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
    if (existsSync(scratch)) throw new Error(`G03 replay fault proof could not remove scratch ${scratch}`);
  } catch (error) {
    if (pendingError) return { retained: true, ownedGroups, throwError: null };
    error.scratch = scratch;
    error.scratchRetained = true;
    error.ownedGroups = ownedGroups;
    return { retained: true, ownedGroups, throwError: error };
  }
  return { retained: false, ownedGroups, throwError: null };
}

/**
 * Execute the full copy-mutate-load-assert-restore fault proof and return a
 * receipt. Every nested run is owned, bounded and group-verified before its
 * result is trusted. The scratch tree is reclaimed only after all owned groups
 * are proven dead; otherwise it is retained with ownership preserved.
 *
 * `runAssertion`/`runOptions` are injectable so focused lifecycle controls can
 * drive private owned fixtures through the exact same finalization path. Any
 * injected runner must call `onOwned(groupId)` at creation; ownership is also
 * captured from the default runner before its result is awaited. If a runner
 * throws after spawning, the group stays owned and the scratch is retained.
 */
export async function runReplayGuardFaultProof({
  root,
  keepScratch = false,
  log = () => {},
  proof = FAULT_PROOF,
  runAssertion = runNamedReplayAssertion,
  runOptions = {},
}) {
  const committedPath = join(root, "index.ts");
  const original = readFileSync(committedPath, "utf8");
  const originalHash = sha256(original);
  if (originalHash !== REPLAY_GUARD_BASELINE_SHA256) {
    throw new Error(`G03 replay fault proof requires baseline source; index.ts sha256=${originalHash}`);
  }
  const mutate = REPLAY_GUARD_MUTATORS[proof.guard];
  if (!mutate) throw new Error(`G03 replay fault proof has no mutator for guard ${proof.guard}`);

  const scratch = createReplayScratchTree(root);
  log(`G03 replay fault proof scratch: ${scratch} (created at proof start)`);
  const receipts = [];
  const ownedGroupsAtCreation = new Set();
  let startedRuns = 0;
  let pendingError = null;
  const captureOwned = (group) => { if (Number.isInteger(group) && group > 0) ownedGroupsAtCreation.add(group); };
  const runPhase = async () => {
    startedRuns += 1;
    return runAssertion({ scratch, testFile: proof.testFile, testName: proof.testName, ...runOptions, onOwned: captureOwned });
  };
  try {
    const { testFile, testName, redAssertionMessage } = proof;

    // 2. GREEN on the pristine copy.
    const green = await runPhase();
    receipts.push(green);
    assertAssertionGreen(green, "pristine copy");

    // 3. MUTATE.
    const mutant = mutate(original);
    const mutantHash = sha256(mutant);
    if (mutantHash === originalHash) throw new Error("G03 replay fault proof mutation produced no source change");
    writeFileSync(join(scratch, "index.ts"), mutant);
    log(`G03 replay fault proof ${proof.guard} mutant sha256=${mutantHash}`);

    // 4. RED against the mutant.
    const red = await runPhase();
    receipts.push(red);
    assertAssertionRed(red, redAssertionMessage);
    log(`G03 replay fault proof RED: ${redAssertionMessage}`);

    // 5. RESTORE and verify.
    writeFileSync(join(scratch, "index.ts"), original);
    const restoredHash = sha256(readFileSync(join(scratch, "index.ts"), "utf8"));
    if (restoredHash !== originalHash) throw new Error(`G03 replay fault proof restore hash mismatch: ${restoredHash}`);
    const restoredGreen = await runPhase();
    receipts.push(restoredGreen);
    assertAssertionGreen(restoredGreen, "restored copy");

    const committedHashAfter = sha256(readFileSync(committedPath, "utf8"));
    if (committedHashAfter !== originalHash) {
      throw new Error(`G03 replay fault proof modified the committed index.ts: ${committedHashAfter}`);
    }

    return {
      guard: proof.guard,
      testFile,
      testName,
      baselineSha256: originalHash,
      mutantSha256: mutantHash,
      restoredSha256: restoredHash,
      redAssertionMessage,
      scratch,
      scratchRetained: false,
      ownedGroups: [...ownedGroupsAtCreation],
      phases: {
        copy: "ok",
        green: green.status,
        red: red.status,
        restoredGreen: restoredGreen.status,
      },
    };
  } catch (error) {
    pendingError = error;
    pendingError.scratch = scratch;
    pendingError.scratchRetained = false;
    throw error;
  } finally {
    const lifecycle = finalizeScratchLifecycle({ scratch, keepScratch, receipts, ownedGroupsAtCreation, startedRuns, pendingError });
    if (pendingError) {
      pendingError.scratch = scratch;
      pendingError.scratchRetained = lifecycle.retained;
      pendingError.ownedGroups = lifecycle.ownedGroups;
    }
    if (lifecycle.throwError) throw lifecycle.throwError;
  }
}
