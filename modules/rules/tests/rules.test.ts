import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, classifyCompiled, compileRules } from "../rules.ts";

function captureDiagnostics(run: () => void): string[] {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    run();
  } finally {
    console.error = original;
  }
  return messages;
}

describe("rule compilation and matching", () => {
    it("returns undefined for invalid regex pattern", () => {
      let result: string | undefined = "unset";
      const messages = captureDiagnostics(() => {
        result = classify("hello", [{ pattern: "***invalid[", model: "frontier" }]);
      });
      assert.equal(result, undefined);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /^\[bifrost\] invalid regex "\*\*\*invalid\[": /);
    });

    it("precompiled matching preserves rule-order precedence across positions", () => {
      // Rule 1 matches later in the text but must still win — guards against
      // leftmost-first alternatives (e.g. a combined regex) changing precedence.
      const rules = [
        { pattern: "foo", model: "first" },
        { pattern: "bar", model: "second" },
      ];
      assert.equal(classify("bar foo", rules), "first");
      assert.equal(classifyCompiled("bar foo", compileRules(rules)), "first");
    });

    it("falls through to a later rule when the first does not match", () => {
      const rules = [
        { pattern: "foo", model: "first" },
        { pattern: "bar", model: "second" },
      ];
      assert.equal(classify("bar", rules), "second");
      assert.equal(classifyCompiled("bar", compileRules(rules)), "second");
    });

    it("matches patterns case-insensitively on both paths", () => {
      const rules = [{ pattern: "casefold-literal", model: "first" }];
      assert.equal(classify("CASEFOLD-LITERAL", rules), "first");
      assert.equal(classifyCompiled("CASEFOLD-LITERAL", compileRules(rules)), "first");
    });

    it("skips a rejected pattern even when it would match", () => {
      // The verifier rejects nested quantifiers; matching must not run them.
      let result: string | undefined = "unset";
      captureDiagnostics(() => {
        result = classify("aaaa", [{ pattern: "^(a+)+$", model: "quick" }]);
      });
      assert.equal(result, undefined);
    });

    it("drops an invalid pattern while compiling and reports it", () => {
      let compiled: ReturnType<typeof compileRules> = [];
      const messages = captureDiagnostics(() => {
        compiled = compileRules([
          { pattern: "***invalid[", model: "invalid" },
          { pattern: "compiled-literal", model: "kept" },
        ]);
      });
      assert.deepEqual(compiled.map((rule) => rule.model), ["kept"]);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /^\[bifrost\] invalid regex "\*\*\*invalid\[": /);
    });
});
