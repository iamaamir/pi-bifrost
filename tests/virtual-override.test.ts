import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VirtualOverride } from "../virtual-override.ts";

describe("virtual inline override handoff", () => {
  it("hands stripped prompt tier to matching next user request once", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("quick", "commit changes");
    assert.equal(handoff.take("commit changes"), "quick");
    assert.equal(handoff.take("commit changes"), undefined);
  });

  it("does not apply or drop a tier for unrelated prompt text", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("frontier", "debug race");
    assert.equal(handoff.take("unrelated message"), undefined);
    assert.equal(handoff.take("debug race"), "frontier");
  });

  it("matches whitespace-padded message text against the trimmed handoff", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("quick", "commit changes");
    assert.equal(handoff.take("commit changes\n"), "quick");
  });

  it("keeps queued steering and follow-up overrides separate", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("general", "same text", "followUp");
    handoff.prepare("quick", "same text", "steer");
    assert.equal(handoff.take("same text"), "quick");
    assert.equal(handoff.take("same text"), "general");
  });

  it("tracks ordinary prompts so duplicate stripped text cannot inherit a tier", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("quick", "commit changes", "followUp");
    handoff.prepare(undefined, "commit changes", "steer");
    assert.equal(handoff.take("commit changes"), undefined);
    assert.equal(handoff.take("commit changes"), "quick");
  });

  it("clear() drops abandoned overrides", () => {
    const handoff = new VirtualOverride();
    handoff.prepare("quick", "commit changes");
    handoff.clear();
    assert.equal(handoff.take("commit changes"), undefined);
  });
});
