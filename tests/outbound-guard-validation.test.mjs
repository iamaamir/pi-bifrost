import assert from "node:assert/strict";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import fc from "fast-check";

const require = createRequire(import.meta.url);
const { isLoopbackAddress } = require("../scripts/outbound-guard-lookup.cjs");

const octet = () => fc.integer({ min: 0, max: 255 });

describe("outbound guard loopback validation properties", () => {
  it("accepts every IPv4 loopback literal", () => {
    fc.assert(fc.property(octet(), octet(), octet(), (a, b, c) => {
      assert.equal(isLoopbackAddress(`127.${a}.${b}.${c}`), true);
    }));
  });

  it("accepts every IPv4-mapped loopback literal in hex form", () => {
    fc.assert(fc.property(octet(), octet(), octet(), (a, b, c) => {
      const high = (127 << 8) | a;
      const low = (b << 8) | c;
      const mapped = `::ffff:${high.toString(16)}:${low.toString(16)}`;
      assert.equal(isLoopbackAddress(mapped), true);
      assert.equal(isLoopbackAddress(mapped.toUpperCase()), true);
    }));
  });

  it("accepts canonical and expanded IPv6 loopback forms", () => {
    for (const form of ["::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:1%lo0"]) {
      assert.equal(isLoopbackAddress(form), true, form);
    }
  });

  it("rejects non-loopback IPv4 and IPv6 addresses", () => {
    fc.assert(fc.property(octet(), octet(), octet(), (a, b, c) => {
      const prefix = a === 127 ? 126 : a;
      assert.equal(isLoopbackAddress(`${prefix}.${b}.${c}.${b}`), false);
      assert.equal(isLoopbackAddress(`2001:db8:${b.toString(16)}::${c.toString(16)}`), false);
    }));
  });

  it("rejects malformed and out-of-range literals", () => {
    for (const form of [
      "127.00.0.1", "127.0.0.01", "127.0.0.999", "127.1", "127.0.0.1.5",
      "::2", "::ffff:128.0.0.1", "not-an-ip", "", "localhost", "::ffff:7f00",
    ]) {
      assert.equal(isLoopbackAddress(form), false, form);
    }
  });

  it("never accepts arbitrary generated strings", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (value) => {
      if (isIP(value) !== 0) return;
      assert.equal(isLoopbackAddress(value), false);
    }));
  });
});
