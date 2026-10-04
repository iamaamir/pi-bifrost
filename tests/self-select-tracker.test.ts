import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSelfSelectTracker } from "../runtime-state.ts";

describe("self-select tracker (issue #17 P1)", () => {
  it("keeps per-session claims separate when both target the same model", () => {
    const tracker = createSelfSelectTracker();
    const sessionA = {};
    const sessionB = {};
    tracker.claim(sessionA, "fake/strong");
    tracker.claim(sessionB, "fake/strong");
    // A's event must never swallow B's identical claim: that cross-clear
    // made B's own event look manual and spuriously pinned the session.
    assert.equal(tracker.consume(sessionA, "set", "fake/strong"), true);
    assert.equal(tracker.consume(sessionB, "set", "fake/strong"), true);
    assert.equal(tracker.consume(sessionB, "set", "fake/strong"), false);
  });

  it("matches only set-sources on the claimed model key", () => {
    const tracker = createSelfSelectTracker();
    const session = {};
    tracker.claim(session, "fake/strong");
    assert.equal(tracker.consume(session, "restore", "fake/strong"), false);
    assert.equal(tracker.consume(session, "set", "fake/fast"), false);
    // Non-matching events must not consume the claim.
    assert.equal(tracker.consume(session, "set", "fake/strong"), true);
  });

  it("release drops the claim without consuming it", () => {
    const tracker = createSelfSelectTracker();
    const session = {};
    tracker.claim(session, "fake/strong");
    tracker.release(session);
    assert.equal(tracker.consume(session, "set", "fake/strong"), false);
  });
});
