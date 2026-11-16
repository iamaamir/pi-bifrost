import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAULT_PROOF,
  FAULT_PROOFS,
  assertAssertionRed,
  runReplayGuardFaultProof,
  sha256,
} from "./fixtures/replay-fault-control.mjs";

// Deterministic controls for the replay fault-proof baseline and mutation
// targeting. The proof's own process lifecycle is covered by
// tests/integration/replay-fault-lifecycle.test.mjs; here the nested runner is
// injected so each control exercises one contract at a time with no Pi, no
// subprocesses and no provider calls.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_INDEX = readFileSync(join(ROOT, "index.ts"), "utf8");

/** A minimal candidate root: the scratch builder only needs these entries. */
function candidateRoot(source) {
  const root = mkdtempSync(join(tmpdir(), "bifrost-g03-targeting-"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "index.ts"), source);
  return root;
}

function greenReceipt() {
  return { timedOut: false, status: 0, signal: null, stdout: "ℹ pass 1\nℹ fail 0\n", stderr: "", spawnError: null, ownedGroup: 0, verified: true, scratchPaths: [] };
}

function redReceipt(message) {
  return { timedOut: false, status: 1, signal: null, stdout: `not ok 1 - named assertion\n  AssertionError [ERR_ASSERTION]: ${message}\n`, stderr: "", spawnError: null, ownedGroup: 0, verified: true, scratchPaths: [] };
}

/** GREEN, RED, restored-GREEN by call order, with an optional per-call hook. */
function phaseRunner({ redMessage = FAULT_PROOF.redAssertionMessage, onCall } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async run({ onOwned } = {}) {
      calls += 1;
      onOwned?.(0);
      onCall?.(calls);
      return calls === 2 ? redReceipt(redMessage) : greenReceipt();
    },
  };
}

test("accepts a candidate whose index.ts differs from any previously reviewed bytes", async () => {
  const edited = `${REAL_INDEX}\n// unrelated candidate edit, never reviewed as a baseline\n`;
  const root = candidateRoot(edited);
  try {
    const runner = phaseRunner();
    const receipt = await runReplayGuardFaultProof({ root, runAssertion: runner.run });
    assert.equal(runner.calls(), 3, "the three phases must run");
    assert.equal(receipt.baselineSha256, sha256(edited), "the receipt must name the source it actually tested");
    assert.equal(receipt.restoredSha256, receipt.baselineSha256, "restoration must reproduce the captured bytes");
    assert.notEqual(receipt.mutantSha256, receipt.baselineSha256);
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), edited, "the committed source must be left untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails before any phase when a mutation target is missing", async () => {
  const root = candidateRoot(REAL_INDEX.replace("  function isSideEffectFreeAllowanceFailure(", "  function renamedAllowanceGuard("));
  try {
    const runner = phaseRunner();
    await assert.rejects(
      runReplayGuardFaultProof({ root, runAssertion: runner.run }),
      /replay guard anchor not found: isSideEffectFreeAllowanceFailure/u,
    );
    assert.equal(runner.calls(), 0, "no nested run may start without a valid target");
    assert.equal(readFileSync(join(root, "index.ts"), "utf8").includes("renamedAllowanceGuard("), true, "the source must be untouched after the rejection");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fails before any phase when a mutation target is ambiguous", async () => {
  const duplicated = `${REAL_INDEX}\n  function autoBoundaryStillActive(duplicate) { return false; }\n`;
  const root = candidateRoot(duplicated);
  try {
    const runner = phaseRunner();
    await assert.rejects(
      runReplayGuardFaultProof({ root, proof: FAULT_PROOFS.autoBoundaryToolSideEffect, runAssertion: runner.run }),
      /replay guard anchor is ambiguous \(2 matches\): autoBoundaryStillActive/u,
    );
    assert.equal(runner.calls(), 0, "an ambiguous line anchor must not select its first match");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a mutation that changes nothing", async () => {
  const root = candidateRoot(REAL_INDEX);
  try {
    const runner = phaseRunner();
    const proof = { ...FAULT_PROOF, mutate: (source) => source };
    await assert.rejects(
      runReplayGuardFaultProof({ root, proof, runAssertion: runner.run }),
      /mutation produced no source change/u,
    );
    assert.equal(runner.calls(), 0, "an ineffective fault must never be accepted as a proof");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not accept an unrelated failure as RED evidence", () => {
  const message = FAULT_PROOF.redAssertionMessage;
  assert.throws(
    () => assertAssertionRed({ ...redReceipt(message), status: 1, stdout: "Error: cannot find module './nope'\n" }, message),
    /RED was not an AssertionError/u,
    "a startup or syntax failure is not fault sensitivity",
  );
  assert.throws(
    () => assertAssertionRed(redReceipt("some other assertion failed"), message),
    /RED missing expected message/u,
    "an unrelated assertion failure is not the named assertion",
  );
  assert.doesNotThrow(() => assertAssertionRed(redReceipt(message), message));
});

test("detects the committed source changing while the proof runs", async () => {
  const root = candidateRoot(REAL_INDEX);
  try {
    const runner = phaseRunner({
      onCall: (call) => {
        if (call === 1) writeFileSync(join(root, "index.ts"), `${REAL_INDEX}\n// concurrent write\n`);
      },
    });
    await assert.rejects(
      runReplayGuardFaultProof({ root, runAssertion: runner.run }),
      /modified the committed index\.ts during the run/u,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restores the captured bytes into the scratch tree", async () => {
  const edited = `${REAL_INDEX}\n// candidate variant\n`;
  const root = candidateRoot(edited);
  let scratch = null;
  try {
    const runner = phaseRunner();
    const receipt = await runReplayGuardFaultProof({ root, keepScratch: true, runAssertion: runner.run });
    scratch = receipt.scratch;
    assert.equal(readFileSync(join(scratch, "index.ts"), "utf8"), edited, "the restored scratch must equal the captured source");
    assert.equal(receipt.scratchRetained, true);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("records top-level faults separately from fixture-env faults", async () => {
  const root = candidateRoot(REAL_INDEX);
  try {
    const runner = phaseRunner();
    // A fixture-only fault declares no source mutator: the red phase comes from
    // the fixture env, not from an edited index.ts.
    const fixtureProof = { ...FAULT_PROOF, guard: "fixtureOnlyGuard", mutate: undefined, fixtureFaultEnv: { BIFROST_TEST_FAULT_EXAMPLE: "1" } };
    const receipt = await runReplayGuardFaultProof({ root, proof: fixtureProof, runAssertion: runner.run });
    assert.equal(receipt.mutantSha256, undefined, "a fixture-env fault has no mutant source");
    assert.equal(receipt.faultInjection, "fixture-env");
    assert.equal(receipt.baselineSha256, createHash("sha256").update(REAL_INDEX).digest("hex"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
