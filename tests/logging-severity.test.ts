import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeMeta, serializeRecord } from "../logging/severity.ts";

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("metadata sanitization", () => {
  it("redacts nested credentials while preserving legitimate diagnostics", () => {
    const clean = sanitizeMeta({
      route: {
        tier: "frontier",
        request: { authorization: "Bearer nested-secret", body: "raw prompt" },
        credentials: { api_key: "nested-key" },
      },
      attempts: [{ prompt: "array-secret", model: "provider/model" }],
      count: 2,
    });

    const text = serialized(clean);
    assert.equal(text.includes("nested-secret"), false);
    assert.equal(text.includes("nested-key"), false);
    assert.equal(text.includes("array-secret"), false);
    assert.equal(text.includes("raw prompt"), false);
    assert.deepEqual(clean.route, { tier: "frontier" });
    assert.deepEqual(clean.attempts, [{ model: "provider/model" }]);
    assert.equal(clean.count, 2);
  });

  it("does not execute accessors while traversing metadata", () => {
    let calls = 0;
    const meta: Record<string, unknown> = { safe: true };
    Object.defineProperty(meta, "nested", {
      enumerable: true,
      get: () => {
        calls += 1;
        return { authorization: "getter-secret" };
      },
    });

    const clean = sanitizeMeta(meta);
    assert.equal(calls, 0, "sanitization must inspect descriptors, not invoke getters");
    assert.deepEqual(clean, { safe: true });
    assert.equal(serialized(clean).includes("getter-secret"), false);
  });

  it("bounds circular references instead of overflowing", () => {
    const meta: Record<string, unknown> = { name: "root" };
    meta.self = meta;
    const clean = sanitizeMeta(meta);
    assert.equal(clean.self, "[circular]");
    assert.equal(serialized(clean).includes("root"), true);
  });

  it("does not invoke custom toJSON while sanitizing", () => {
    let calls = 0;
    const payload = {
      visible: 1,
      toJSON: () => {
        calls += 1;
        return { authorization: "to-json-secret" };
      },
    };
    const clean = sanitizeMeta({ payload });
    assert.equal(calls, 0);
    assert.deepEqual(clean.payload, { visible: 1 });
    assert.equal(serialized(clean).includes("to-json-secret"), false);
  });

  it("treats a hostile proxy as data and keeps traversal bounded", () => {
    const proxy = new Proxy({}, {
      get: () => {
        throw new Error("get trap must not run");
      },
      getOwnPropertyDescriptor: (_target, key) => key === "nested"
        ? { enumerable: true, configurable: true, value: { authorization: "proxy-secret" } }
        : undefined,
      ownKeys: () => ["nested"],
    });

    const clean = sanitizeMeta({ proxy });
    assert.deepEqual(clean.proxy, { nested: {} });
    assert.equal(serialized(clean).includes("proxy-secret"), false);
  });

  it("preserves deep routing diagnostics without exposing nested secrets", () => {
    const clean = sanitizeMeta({
      decision: {
        attempted: [{
          candidates: [{
            model: "fake/circuit",
            status: "excluded",
            exclusion: "economic_reserve",
            reserve: { disposition: "rejected", wouldReject: true, reasons: ["reserve_reached"] },
            authorization: "deep-secret",
          }],
        }],
      },
    });

    assert.deepEqual(clean, {
      decision: {
        attempted: [{
          candidates: [{
            model: "fake/circuit",
            status: "excluded",
            exclusion: "economic_reserve",
            reserve: { disposition: "rejected", wouldReject: true, reasons: ["reserve_reached"] },
          }],
        }],
      },
    });
    assert.equal(serialized(clean).includes("deep-secret"), false);
  });

  it("bounds depth, key count, and array length", () => {
    let deep: Record<string, unknown> = { value: "bottom" };
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    let nestedArray: unknown = "array-bottom";
    for (let index = 0; index < 200; index += 1) nestedArray = [nestedArray];
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]));
    const long = Array.from({ length: 500 }, (_, index) => index);

    const clean = sanitizeMeta({ deep, wide, long, nestedArray });
    const text = serialized(clean);
    assert.equal(text.includes("bottom"), false, "object depth must be bounded");
    assert.equal(text.includes("array-bottom"), false, "array depth must be bounded");
    assert.equal(Object.keys(clean.wide as Record<string, unknown>).length < 500, true);
    assert.equal((clean.long as unknown[]).length < 500, true);
    assert.equal(text.length < 8 * 1024, true);
  });

  it("bounds sparse arrays without materializing every hole", () => {
    const sparse = new Array(10_000_000);
    const clean = sanitizeMeta({ sparse });
    const output = clean.sparse as unknown[];
    assert.ok(output.length <= 257, "sparse slots must count against the node budget");
    assert.equal(output.at(-1), "[truncated]");
  });

  it("does not leak sensitive values through fallback serialization", () => {
    const clean = sanitizeMeta({
      nested: { authorization: "fallback-secret" },
      counter: 3n,
    });
    const serializedRecord = serializeRecord({ ts: "2026-01-01T00:00:00.000Z", level: "debug", ...clean }, 64 * 1024);
    assert.ok(serializedRecord);
    assert.equal(serializedRecord.line.includes("fallback-secret"), false);
    assert.equal(serializedRecord.line.includes("_meta_error"), true);
  });
});
