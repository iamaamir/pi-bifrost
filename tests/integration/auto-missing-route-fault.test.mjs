import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { REPLAY_GUARD_MUTATORS, runReplayGuardFaultProof } from "../fixtures/replay-fault-control.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("proves missing Auto targets cannot escape an explicit boundary through sticky or fallback dispatch", { timeout: 600_000 }, async (t) => {
  const guard = "autoMissingExplicitBoundary";
  // One policy fault removes the same boundary from its two redundant callers.
  // It proves their combined contract, not individual-guard sensitivity.
  REPLAY_GUARD_MUTATORS[guard] = (source) => {
    const anchor = "routeFailure?.explicitBoundary || v2Active ? undefined :";
    assert.equal(source.split(anchor).length, 3, "the fault must target exactly fallback and sticky admission");
    return source.replaceAll(anchor, "v2Active ? undefined :");
  };
  try {
    const receipt = await runReplayGuardFaultProof({
      root,
      proof: {
        guard,
        testFile: "tests/integration/auto-virtual.test.mjs",
        testName: "does not degrade an exhausted explicit tier boundary to the last dispatched model",
        redAssertionMessage: "only the warmup turn may reach the healthy model; the exhausted frontier boundary must not dispatch it",
      },
      log: (message) => t.diagnostic(message),
    });
    assert.deepEqual(receipt.phases, { copy: "ok", green: 0, red: 1, restoredGreen: 0 });
    assert.notEqual(receipt.mutantSha256, receipt.baselineSha256);
    assert.equal(receipt.restoredSha256, receipt.baselineSha256);
    assert.equal(receipt.scratchRetained, false, "all native runs must close with owned groups absent before reclaim");
    t.diagnostic(JSON.stringify(receipt));
  } finally {
    delete REPLAY_GUARD_MUTATORS[guard];
  }
});
