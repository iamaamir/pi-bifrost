import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  BIFROST_LOCK_EVENT,
  acquireLock,
  isDelegateSession,
  parseLockRequest,
  parseReleaseRequest,
  releaseLock,
  type LockReply,
  type LockState,
} from "../tier-lock.ts";

const tiers = ["quick", "general", "frontier", "review", "local"];
const open: LockState = { enabled: true, pinned: false };

describe("tier lock", () => {
  it("acquires a known tier and clears a manual pin", () => {
    const result = acquireLock({ enabled: true, pinned: true, pinSource: "manual" }, { tier: "frontier", owner: "plannotator" }, tiers);
    assert.ok(result.ok);
    assert.deepEqual(result.next, { enabled: true, pinned: false, pinSource: undefined, lock: { tier: "frontier", owner: "plannotator" } });
  });

  it("refuses unknown tiers, disabled routing, delegate pins, and foreign owners", () => {
    assert.match(String((acquireLock(open, { tier: "nope", owner: "a" }, tiers) as { reason: string }).reason), /unknown tier/);
    assert.match(String((acquireLock({ ...open, enabled: false }, { tier: "general", owner: "a" }, tiers) as { reason: string }).reason), /off/);
    assert.match(
      String((acquireLock({ enabled: true, pinned: true, pinSource: "delegate" }, { tier: "general", owner: "a" }, tiers) as { reason: string }).reason),
      /delegate/,
    );
    const held: LockState = { ...open, lock: { tier: "frontier", owner: "a" } };
    assert.match(String((acquireLock(held, { tier: "general", owner: "b" }, tiers) as { reason: string }).reason), /locked to frontier by a/);
    const sameOwner = acquireLock(held, { tier: "general", owner: "a" }, tiers);
    assert.ok(sameOwner.ok);
    assert.equal(sameOwner.next.lock?.tier, "general");
  });

  it("releases only for the owner and is idempotent without a lock", () => {
    const held: LockState = { ...open, lock: { tier: "frontier", owner: "a" } };
    assert.equal(releaseLock(held, "b").ok, false);
    const released = releaseLock(held, "a");
    assert.ok(released.ok);
    assert.equal(released.next.lock, undefined);
    assert.ok(releaseLock(open, "anyone").ok);
  });

  it("validates event payloads", () => {
    assert.deepEqual(parseLockRequest({ tier: " ", owner: "a" }), { invalid: "lock request needs a tier", reply: undefined });
    assert.deepEqual(parseLockRequest(null), { invalid: "lock request needs a tier", reply: undefined });
    assert.deepEqual(parseLockRequest({ tier: "general" }), { invalid: "lock request needs an owner", reply: undefined });
    assert.deepEqual(parseReleaseRequest({}), { invalid: "release request needs an owner", reply: undefined });
    assert.deepEqual(parseLockRequest({ tier: "general", owner: "a", reply: 1 }), { tier: "general", owner: "a", reply: undefined });
  });

  it("delivers replies synchronously over the event bus", () => {
    const bus = createEventBus();
    bus.on(BIFROST_LOCK_EVENT, (data) => {
      const request = parseLockRequest(data);
      if ("invalid" in request) return request.reply?.({ ok: false, reason: request.invalid });
      const result = acquireLock(open, request, tiers);
      request.reply?.(result.ok ? { ok: true, tier: request.tier } : result);
    });
    let reply: LockReply | undefined;
    bus.emit(BIFROST_LOCK_EVENT, { tier: "frontier", owner: "plannotator", reply: (result: LockReply) => { reply = result; } });
    assert.deepEqual(reply, { ok: true, tier: "frontier" });
  });

  it("detects delegate sessions from PI_ACP_DELEGATE_DEPTH", () => {
    assert.equal(isDelegateSession({}), false);
    assert.equal(isDelegateSession({ PI_ACP_DELEGATE_DEPTH: "0" }), false);
    assert.equal(isDelegateSession({ PI_ACP_DELEGATE_DEPTH: "1" }), true);
    assert.equal(isDelegateSession({ PI_ACP_DELEGATE_DEPTH: "2" }), true);
    assert.equal(isDelegateSession({ PI_ACP_DELEGATE_DEPTH: "x" }), false);
  });
});
