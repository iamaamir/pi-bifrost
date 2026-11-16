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
  injectGuardStatement,
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

// --- body-brace targeting ---------------------------------------------------
// The body brace must be derived from the guard's own signature. A `{\n` search
// cannot distinguish a body from a comment tail, a type annotation, or the next
// function, and the reported failure injected into `turnUserBoundary` while both
// existing checks still passed.
const AUTO_BOUNDARY_SIGNATURE =
  "  function autoBoundaryStillActive(ctx: ExtensionContext, boundary: AutoUserBoundary): boolean {";
const ADJACENT = [
  "  function turnUserBoundary(",
  "  function isSideEffectFreeAllowanceFailure(",
  "  function recordAutoRouteProof(",
];

/** A function's text, from its signature up to the next sibling declaration. */
function functionText(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing signature: ${signature}`);
  const end = source.indexOf("\n  function ", start);
  return source.slice(start, end === -1 ? source.length : end);
}

function assertInsideGuard(mutant, signature, statement) {
  const guardStart = mutant.indexOf(signature);
  assert.notEqual(guardStart, -1, `missing signature: ${signature}`);
  const fault = mutant.indexOf(`\n    ${statement}`, guardStart);
  const nextSibling = mutant.indexOf("\n  function ", guardStart);
  assert.notEqual(fault, -1, "the fault must be injected into the guard body");
  assert.ok(fault > guardStart, "the fault must follow the guard signature, not precede it");
  assert.ok(fault < nextSibling, "the fault must stay inside the intended function");
}

test("targets the intended function when its body opens with a comment", () => {
  const candidate = REAL_INDEX.replace(AUTO_BOUNDARY_SIGNATURE, `${AUTO_BOUNDARY_SIGNATURE} /* comment */`);
  assert.notEqual(candidate, REAL_INDEX, "the reproduction must change the candidate");

  const mutant = injectGuardStatement(candidate, "autoBoundaryStillActive", "return false;");
  assertInsideGuard(mutant, AUTO_BOUNDARY_SIGNATURE, "return false;");
  for (const signature of ADJACENT) {
    assert.equal(functionText(mutant, signature), functionText(candidate, signature),
      `${signature} must be byte-identical after the mutation`);
  }
  const brace = candidate.indexOf(AUTO_BOUNDARY_SIGNATURE) + AUTO_BOUNDARY_SIGNATURE.length - 1;
  assert.equal(mutant,
    `${candidate.slice(0, brace + 1)}\n    return false;${candidate.slice(brace + 1)}`,
    "the mutant must differ from the candidate by exactly one insertion at the guard's body brace");
});

test("skips an object type literal in the return type", () => {
  const signature = "  function turnUserBoundary(ctx: ExtensionContext, event: TurnEndEvent): { entryId: string; message: object } | undefined {";
  const mutant = injectGuardStatement(REAL_INDEX, "turnUserBoundary", "return undefined;");
  assertInsideGuard(mutant, signature, "return undefined;");
  assert.ok(mutant.includes(": { entryId: string; message: object } | undefined {"),
    "the return-type annotation must be unchanged");
  const brace = REAL_INDEX.indexOf(signature) + signature.length - 1;
  assert.equal(mutant,
    `${REAL_INDEX.slice(0, brace + 1)}\n    return undefined;${REAL_INDEX.slice(brace + 1)}`,
    "the fault must be inserted at the body brace, not inside the annotation");
});

test("handles a multiline parameter list", () => {
  const signature = "  function isSideEffectFreeAllowanceFailure(";
  const mutant = injectGuardStatement(REAL_INDEX, "isSideEffectFreeAllowanceFailure", "return [assistantEntryId];");
  assertInsideGuard(mutant, signature, "return [assistantEntryId];");
  assert.ok(mutant.includes("    boundary: { entryId: string; message: object },"),
    "parameter annotations must be unchanged");
});

test("accepts a body brace placed on its own line", () => {
  const candidate = REAL_INDEX.replace(AUTO_BOUNDARY_SIGNATURE, `${AUTO_BOUNDARY_SIGNATURE.slice(0, -1)}\n  {`);
  assert.notEqual(candidate, REAL_INDEX);
  const mutant = injectGuardStatement(candidate, "autoBoundaryStillActive", "return false;");
  assertInsideGuard(mutant, "  function autoBoundaryStillActive(", "return false;");
  for (const signature of ADJACENT.slice(0, 2)) {
    assert.equal(functionText(mutant, signature), functionText(candidate, signature),
      `${signature} must be byte-identical after the mutation`);
  }
});

test("fails closed when the guard declaration has no body", () => {
  const declarationOnly = REAL_INDEX.replace(
    functionText(REAL_INDEX, AUTO_BOUNDARY_SIGNATURE),
    `${AUTO_BOUNDARY_SIGNATURE.slice(0, -1)};`,
  );
  assert.notEqual(declarationOnly, REAL_INDEX);
  assert.throws(
    () => injectGuardStatement(declarationOnly, "autoBoundaryStillActive", "return false;"),
    /declaration only/u,
    "a bodyless declaration must not adopt the next function's body",
  );
});

test("fails closed on an overload whose return type is an object literal", () => {
  const overload = REAL_INDEX.replace(
    functionText(REAL_INDEX, AUTO_BOUNDARY_SIGNATURE),
    "  function autoBoundaryStillActive(ctx: ExtensionContext, boundary: AutoUserBoundary): { ok: boolean };",
  );
  assert.notEqual(overload, REAL_INDEX);
  assert.throws(
    () => injectGuardStatement(overload, "autoBoundaryStillActive", "return false;"),
    /declaration only/u,
    "an object return type in a bodyless declaration must not be mistaken for the body",
  );
});

test("fails closed instead of adopting the next function's body", () => {
  const bodyless = REAL_INDEX.replace(
    functionText(REAL_INDEX, AUTO_BOUNDARY_SIGNATURE),
    "  function autoBoundaryStillActive(ctx: ExtensionContext, boundary: AutoUserBoundary): boolean",
  );
  assert.notEqual(bodyless, REAL_INDEX);
  assert.throws(
    () => injectGuardStatement(bodyless, "autoBoundaryStillActive", "return false;"),
    /escapes into the following declaration/u,
    "a missing body must never borrow the following declaration's brace",
  );
});

test("runs the full proof on a guard whose body opens with a comment", async () => {
  const candidate = REAL_INDEX.replace(AUTO_BOUNDARY_SIGNATURE, `${AUTO_BOUNDARY_SIGNATURE} /* comment */`);
  const root = candidateRoot(candidate);
  try {
    const proof = FAULT_PROOFS.autoBoundaryToolSideEffect;
    const runner = phaseRunner({ redMessage: proof.redAssertionMessage });
    const receipt = await runReplayGuardFaultProof({ root, proof, runAssertion: runner.run });
    assert.equal(runner.calls(), 3);
    assert.equal(receipt.baselineSha256, sha256(candidate));
    assert.notEqual(receipt.mutantSha256, receipt.baselineSha256, "the fault must change the guard");
    assert.equal(receipt.restoredSha256, receipt.baselineSha256);
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), candidate, "the committed source must be untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
