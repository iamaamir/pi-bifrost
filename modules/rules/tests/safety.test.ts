import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCompiled, compileRules } from "../rules.ts";
import { isPatternAccepted, verifyRulePatterns } from "../safety.ts";

const UNIQUE = `${process.pid}-${Date.now()}`;

/** A pattern no other test has verified, so the process-global cache cannot mask the probe. */
function freshPattern(name: string): string {
  return `probe-${name}-${UNIQUE}-literal`;
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * A stub probe whose first and later invocations emit fixed verdict streams.
 * Verdicts are passed as arrays so no escape sequence is written or interpreted.
 */
function sequenceProbe(directory: string, first: string[], later: string[]): { probe: string; calls: () => number } {
  const counter = join(directory, "calls");
  const probe = join(directory, "sequence-node");
  const payload = (lines: string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  const script = `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const counter = ${JSON.stringify(counter)};
let calls = 0;
try { calls = Number(readFileSync(counter, "utf8")); } catch {}
calls += 1;
writeFileSync(counter, String(calls));
process.stdout.write(calls === 1 ? ${JSON.stringify(payload(first))} : ${JSON.stringify(payload(later))});
`;
  writeFileSync(probe, script, { mode: 0o755 });
  // Warm the new script and the interpreter before the measured call: a cold
  // exec can approach the production probe timeout under Stryker's parallel
  // load. The counter is reset so the measured sequence still starts at call 1.
  spawnSync(probe, [], { input: "", encoding: "utf8" });
  rmSync(counter, { force: true });
  return { probe, calls: () => Number(existsSync(counter) ? readFileSync(counter, "utf8") : 0) };
}

/** Run a case in a bounded child so a mutant cannot hang the test runner. */
function runIsolated(source: string, moduleUrl: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source, moduleUrl],
    { encoding: "utf8", timeout: 2500, killSignal: "SIGKILL" },
  );
}

describe("rule safety verification", () => {
    it("drops rule patterns whose backtracking explodes on a small canary", () => {
      // Security regression: a repo-provided rule with nested quantifiers
      // hangs the host event loop synchronously before the message is sent.
      // compileRules must drop the rule (fail closed to later rules/default)
      // instead of shipping a pattern that cannot run within a bounded budget.
      const compiled = compileRules([
        { pattern: "^(a+)+$", model: "quick" },
        { pattern: "hello", model: "general" },
      ]);
      assert.deepEqual(compiled.map((rule) => rule.model), ["general"]);
    });

    it("falls back to the hosting runtime when the pinned probe binary is absent", () => {
      // The probe pins `node` so a mutant's verdict does not depend on whichever
      // runtime hosts the router. A host without `node` on PATH must still
      // verify rules rather than dropping them.
      //
      // The pattern below is deliberately fresh: `compileRules` caches verdicts,
      // and a pattern another test already verified would be skipped instead of
      // probed, making this assertion vacuous. A probe failure is fail-closed, so
      // without the fallback this rule would be dropped and the assertion fails.
      const previous = process.env.BIFROST_PROBE_NODE;
      process.env.BIFROST_PROBE_NODE = join(tmpdir(), "bifrost-no-such-node-binary");
      try {
        const compiled = compileRules([{ pattern: "fallback-probe-pattern", model: "general" }]);
        assert.deepEqual(compiled.map((rule) => rule.model), ["general"]);
      } finally {
        if (previous === undefined) delete process.env.BIFROST_PROBE_NODE;
        else process.env.BIFROST_PROBE_NODE = previous;
      }
    });

    it("does not let PATH choose the probe binary on a Node host", () => {
      // The probe is a security control: its verdict decides whether a rule can
      // run. Resolving `node` through PATH let anyone who controls the
      // environment substitute a binary that answers "safe" for every pattern.
      // Under Node the hosting binary is the production engine and is used
      // directly; under Bun there is no Node binary to reuse, so the lookup
      // stays and this test does not apply.
      if ((process.versions as Record<string, string | undefined>).bun) return;
      const dir = mkdtempSync(join(tmpdir(), "bifrost-probe-path-"));
      const marker = join(dir, "executed");
      writeFileSync(join(dir, "node"), `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\necho 0\n`, { mode: 0o755 });
      const previousPath = process.env.PATH;
      const previousOverride = process.env.BIFROST_PROBE_NODE;
      delete process.env.BIFROST_PROBE_NODE;
      process.env.PATH = `${dir}:${previousPath ?? ""}`;
      try {
        const compiled = compileRules([{ pattern: "path-substitution-probe-pattern", model: "general" }]);
        assert.deepEqual(compiled.map((rule) => rule.model), ["general"]);
        assert.equal(existsSync(marker), false, "the probe executed a binary resolved through PATH");
      } finally {
        process.env.PATH = previousPath;
        if (previousOverride === undefined) delete process.env.BIFROST_PROBE_NODE;
        else process.env.BIFROST_PROBE_NODE = previousOverride;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects lookahead-anchored catastrophic patterns without paying the long probe", () => {
      // A lookaround can keep every earlier canary cheap and detonate the guard's
      // own longest probe, so the probe loop must not be the only defense:
      // this includes the nested-quantifier test even past lookahead guards.
      const started = performance.now();
      const compiled = compileRules([
        { pattern: "^(?=a{26}b)(a+)+$", model: "quick" },
        { pattern: "^(?=a{32}b)(a+)+$", model: "quick" },
      ]);
      assert.deepEqual(compiled, []);
      assert.ok(performance.now() - started < 250, "rejection must not pay a long probe");
    });

    it("bounds a disguised catastrophic rule while compiling", () => {
      const moduleUrl = new URL("../rules.ts", import.meta.url).href;
      const script = `const {compileRules} = await import(process.argv[1]); const rules = compileRules([{ pattern: "first literal", model: "first" }, { pattern: "^(?=a{32}b)(?:a|[a])+$", model: "quick" }, { pattern: "last literal", model: "last" }]); process.stdout.write(JSON.stringify(rules.map(rule => rule.model)));`;
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl], { encoding: "utf8", timeout: 2500, killSignal: "SIGKILL" });
      assert.equal(result.error, undefined, `compilation must finish: ${result.error}`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["first", "last"]);
    });

    it("rejects deterministic-free catastrophic alternations without exec", () => {
      // (a|aa)+ explodes through branch prefix-overlap, not nested quantifiers.
      const compiled = compileRules([
        { pattern: "^((a|aa)+)b", model: "quick" },
        { pattern: "^(a+)+$", model: "quick" },
        { pattern: "(?:ab?)+c", model: "quick" },
      ]);
      assert.deepEqual(compiled, []);
    });

    it("accepts lazy fixed repeats and still rejects lazy variable repeats", () => {
      const safe = compileRules([{ pattern: "^(?:[0-9]{2}?)+$", model: "quick" }]);
      assert.equal(classifyCompiled("1234", safe), "quick");
      assert.equal(compileRules([{ pattern: "^(?:a+?)+$", model: "quick" }]).length, 0);
    });

    it("keeps benign quantified rules that shuttle variable tokens safely", () => {
      // Fixed-length repetition and non-overlapping alternations must survive
      // the structural filter untouched.
      const compiled = compileRules([
        { pattern: "(\\d{2}:\\d{2})*", model: "quick" },
        { pattern: "class(?:room|rooms)?", model: "quick" },
        { pattern: "(foo|bar)+", model: "quick" },
        { pattern: "(a|b|c)+", model: "quick" },
        // The `?` that opens a noncapturing group is group syntax, not an
        // optional quantifier, so a repeated noncapturing group is as safe as
        // its capturing equivalent and must survive the structural scan.
        { pattern: "(?:foo)+", model: "quick" },
        { pattern: "(?:foo|bar)+", model: "quick" },
      ]);
      assert.equal(compiled.length, 6);
    });

    it("verifies a batch of fresh patterns with one child process", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-batch-probe-"));
      try {
        const { probe, calls } = sequenceProbe(directory, ["0", "0", "0", "0"], []);
        const patterns = Array.from({ length: 4 }, (_, index) => freshPattern(`batch-${index}`));
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules(patterns.map((pattern) => ({ pattern, model: pattern })));
        });
        assert.deepEqual(compiled.map((rule) => rule.model), patterns);
        assert.equal(calls(), 1, "one batch must spawn one verifier");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("does not spawn or verify again while matching compiled rules", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-match-probe-"));
      try {
        const { probe, calls } = sequenceProbe(directory, ["0"], []);
        const pattern = freshPattern("match-path");
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules([{ pattern, model: "quick" }]);
        });
        assert.deepEqual(compiled.map((rule) => rule.model), ["quick"]);
        assert.equal(calls(), 1);
        let hits = 0;
        for (let index = 0; index < 2000; index += 1) {
          if (classifyCompiled(`prompt ${index} ${pattern}`, compiled) === "quick") hits += 1;
        }
        assert.equal(hits, 2000);
        assert.equal(calls(), 1, "matching must not reach the verifier again");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("matches a rule whose pattern verification would reject without verifying it", () => {
      // `CompiledRule` carries no pattern, so matching cannot compile or verify:
      // this object matches `^(a+)+$` on a safe input even though the verifier
      // rejects that pattern. A regression that routes matching back through
      // verification returns undefined here; a regression that recompiles has no
      // pattern to compile and cannot pass either.
      const rule = { re: new RegExp("^(a+)+$", "i"), model: "quick" };
      assert.equal(classifyCompiled("aaaa", [rule]), "quick");
    });

    it("keeps ambient NODE_OPTIONS away from the verifier", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-options-probe-"));
      try {
        const poison = join(directory, "poison.cjs");
        const marker = join(directory, "poison-ran");
        writeFileSync(poison, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
        const pattern = freshPattern("ambient");
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: undefined, NODE_OPTIONS: `--require ${poison}` }, () => {
          compiled = compileRules([{ pattern, model: "general" }]);
        });
        assert.deepEqual(compiled.map((rule) => rule.model), ["general"]);
        assert.equal(existsSync(marker), false, "the verifier inherited NODE_OPTIONS");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("drops a rule when the verifier hangs past its bound", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-hung-probe-"));
      try {
        const probe = join(directory, "hung-node");
        writeFileSync(probe, `#!${process.execPath}
setTimeout(() => {}, 5000);
`, { mode: 0o755 });
        const messages: string[] = [];
        const originalError = console.error;
        console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
        const started = performance.now();
        let compiled: ReturnType<typeof compileRules> = [];
        try {
          withEnv({ BIFROST_PROBE_NODE: probe }, () => {
            compiled = compileRules([{ pattern: freshPattern("hung"), model: "quick" }]);
          });
        } finally {
          console.error = originalError;
        }
        assert.deepEqual(compiled, []);
        assert.ok(performance.now() - started < 2500, "the verifier test must stay inside its own bound");
        assert.equal(messages.filter((line) => line.includes("rejecting rule pattern")).length, 1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("rejects a pattern after a malformed verdict stream instead of assuming it safe", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-malformed-probe-"));
      try {
        const probe = join(directory, "malformed-node");
        writeFileSync(probe, `#!${process.execPath}
process.stdout.write("not-a-verdict" + String.fromCharCode(10));
`, { mode: 0o755 });
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules([{ pattern: freshPattern("malformed"), model: "quick" }]);
        });
        assert.deepEqual(compiled, []);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("keeps the decoded prefix of a partial verdict stream", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-partial-probe-"));
      try {
        const { probe, calls } = sequenceProbe(directory, ["0", "0"], ["0", "0", "0"]);
        const patterns = Array.from({ length: 34 }, (_, index) => freshPattern(`partial-${index}`));
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules(patterns.map((pattern) => ({ pattern, model: pattern })));
        });
        assert.deepEqual(compiled.map((rule) => rule.model), [patterns[0], patterns[1], patterns[32], patterns[33]]);
        assert.equal(calls(), 2, "the later batch must still be probed");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("rejects one timed-out pattern and keeps probing the rest", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-timeout-probe-"));
      try {
        const counter = join(directory, "calls");
        const probe = join(directory, "timeout-node");
        const script = `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const counter = ${JSON.stringify(counter)};
let calls = 0;
try { calls = Number(readFileSync(counter, "utf8")); } catch {}
calls += 1;
writeFileSync(counter, String(calls));
process.stdout.write("0" + String.fromCharCode(10));
if (calls === 1) setTimeout(() => {}, 5000);
`;
        writeFileSync(probe, script, { mode: 0o755 });
        const patterns = Array.from({ length: 3 }, (_, index) => freshPattern(`timeout-${index}`));
        const started = performance.now();
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules(patterns.map((pattern) => ({ pattern, model: pattern })));
        });
        assert.deepEqual(compiled.map((rule) => rule.model), [patterns[0], patterns[2]]);
        assert.equal(Number(readFileSync(counter, "utf8")), 2, "the later pattern must still be probed");
        assert.ok(performance.now() - started < 2500, "the timeout control must stay inside its own bound");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("keeps the decoded prefix of a malformed verdict stream", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-malformed-prefix-"));
      try {
        const { probe, calls } = sequenceProbe(directory, ["0", "not-a-verdict"], ["0", "0"]);
        const patterns = Array.from({ length: 34 }, (_, index) => freshPattern(`prefix-${index}`));
        let compiled: ReturnType<typeof compileRules> = [];
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          compiled = compileRules(patterns.map((pattern) => ({ pattern, model: pattern })));
        });
        assert.deepEqual(compiled.map((rule) => rule.model), [patterns[0], patterns[32], patterns[33]]);
        assert.equal(calls(), 2, "the remainder of the batch is rejected, not the whole run");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("records an accepted verdict for a freshly verified pattern and reuses it", () => {
      const directory = mkdtempSync(join(tmpdir(), "bifrost-seam-probe-"));
      try {
        const { probe, calls } = sequenceProbe(directory, ["0"], []);
        const pattern = freshPattern("seam-accepted");
        assert.equal(isPatternAccepted(pattern), false, "an unverified pattern has no accepted verdict");
        withEnv({ BIFROST_PROBE_NODE: probe }, () => {
          verifyRulePatterns([pattern]);
          assert.equal(isPatternAccepted(pattern), true);
          verifyRulePatterns([pattern]);
        });
        assert.equal(calls(), 1, "the cached verdict must be reused");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("records a rejection once through the seam", () => {
      const pattern = `^(seam${process.pid}+)+$`;
      const messages: string[] = [];
      const originalError = console.error;
      console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
      try {
        verifyRulePatterns([pattern]);
        verifyRulePatterns([pattern]);
      } finally {
        console.error = originalError;
      }
      assert.equal(isPatternAccepted(pattern), false);
      assert.equal(messages.filter((line) => line.includes("rejecting rule pattern")).length, 1);
    });

    it("parity path drops the same catastrophic pattern", () => {
      // A mutant that removes the rejection would otherwise run the match in this
      // process; the bounded child keeps that failure visible instead of hanging.
      const moduleUrl = new URL("../rules.ts", import.meta.url).href;
      const script = `const { classify, classifyCompiled, compileRules } = await import(process.argv[1]);
const rules = [{ pattern: "^(a+)+$", model: "quick" }];
process.stdout.write(JSON.stringify([
  classify("a".repeat(24) + "b", rules) ?? null,
  classifyCompiled("a".repeat(24) + "b", compileRules(rules)) ?? null,
]));`;
      const result = runIsolated(script, moduleUrl);
      assert.equal(result.error, undefined, `parity path must finish: ${result.error}`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [null, null]);
    });

    it("reports a rejected rule once across repeated classify calls", () => {
      // classify() runs per message, so a rejected configured rule must be
      // diagnosed once instead of logging on every classified prompt. The match
      // runs in a bounded child for the same reason as the parity case above.
      const moduleUrl = new URL("../rules.ts", import.meta.url).href;
      const script = `const { classify } = await import(process.argv[1]);
const messages = [];
const original = console.error;
console.error = (...values) => { messages.push(values.map(String).join(" ")); };
const rules = [{ pattern: "^(zz+)+$", model: "quick" }];
const first = classify("z".repeat(24) + "c", rules) ?? null;
const second = classify("z".repeat(24) + "c", rules) ?? null;
console.error = original;
process.stdout.write(JSON.stringify({
  first,
  second,
  reported: messages.filter((line) => line.includes("rejecting rule pattern")),
}));`;
      const result = runIsolated(script, moduleUrl);
      assert.equal(result.error, undefined, `classify must finish: ${result.error}`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        first: null,
        second: null,
        reported: ['[bifrost] rejecting rule pattern with unbounded backtracking or unverifiable safety: "^(zz+)+$"'],
      });
    });
  });
