// Authoritative G03 replay fault-proof baseline metadata.
//
// This module is deliberately dependency-free and side-effect free. The release
// preflight (scripts/verify-release.mjs) imports it to reject a stale candidate
// before any verification lane starts, so it must not carry the fixture's
// process-group orchestration or test harness with it.
//
// Update REPLAY_GUARD_BASELINE_SHA256 in the same change that alters the guarded
// production source, after re-running the named replay fault proofs against it.
// Nothing rewrites the hash automatically.
//
// GUARD INVENTORY (index.ts). Guards are located by function anchor, never by
// line number: recorded line numbers drifted (to three disagreeing values)
// without any owner noticing, and every mutator already anchors on
// `function <name>(`. A byte-identical baseline necessarily carries each anchor,
// so the pinned hash is the whole contract.
export const REPLAY_GUARD_BASELINE_SHA256 = "822123bab361524636307052a007e7e7ab686bf186195d4c41f93a95baea70bb";
export const REPLAY_GUARD_FUNCTIONS = [
  "isSideEffectFreeAllowanceFailure",
  "allowanceRetryBoundaryStillSafe",
  "autoBoundaryStillActive",
];
