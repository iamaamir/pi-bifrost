import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, bumpVersion } from "../scripts/release.mjs";

describe("release script", () => {
  describe("parseVersion", () => {
    it("parses a valid semver string", () => {
      const v = parseVersion("1.2.3");
      assert.equal(v.major, 1);
      assert.equal(v.minor, 2);
      assert.equal(v.patch, 3);
    });

    it("parses zero version", () => {
      const v = parseVersion("0.0.0");
      assert.equal(v.major, 0);
      assert.equal(v.minor, 0);
      assert.equal(v.patch, 0);
    });

    it("parses large version numbers", () => {
      const v = parseVersion("99.99.99");
      assert.equal(v.major, 99);
      assert.equal(v.minor, 99);
      assert.equal(v.patch, 99);
    });

    it("throws on invalid format", () => {
      assert.throws(() => parseVersion("1.2"), /Invalid version/);
      assert.throws(() => parseVersion("not-semver"), /Invalid version/);
      assert.throws(() => parseVersion("1.2.3.4"), /Invalid version/);
      assert.throws(() => parseVersion(""), /Invalid version/);
      assert.throws(() => parseVersion("v1.2.3"), /Invalid version/);
    });
  });

  describe("bumpVersion", () => {
    it("bumps patch", () => {
      assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    });

    it("bumps minor", () => {
      assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    });

    it("bumps major", () => {
      assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
    });

    it("bumps 0.0.1 patch → 0.0.2", () => {
      assert.equal(bumpVersion("0.0.1", "patch"), "0.0.2");
    });

    it("bumps 0.0.1 minor → 0.1.0", () => {
      assert.equal(bumpVersion("0.0.1", "minor"), "0.1.0");
    });

    it("bumps 0.0.1 major → 1.0.0", () => {
      assert.equal(bumpVersion("0.0.1", "major"), "1.0.0");
    });

    it("throws on unknown bump type", () => {
      assert.throws(() => bumpVersion("1.2.3", "revision"), /Unknown bump type/);
    });
  });
});
