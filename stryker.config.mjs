// StrykerJS experiment config for issue #62.
// Scope: measured compatibility experiment against node:test + TypeScript
// type stripping (node >= 22.18 strips types natively for .ts files).
// Command runner + coverageAnalysis "off" because node:test has no Stryker
// per-test coverage plugin; every mutant runs the full bound test command.
// Focused subset binding: only test files that directly exercise each target
// (full-suite-per-mutant cost measured at ~21.5s and is not affordable).
// Run: npx stryker run (expensive; not part of PR CI).
export default {
  mutate: ["cache.ts", "classifier-semantics.ts", "reliability.ts", "routing.ts"],
  testRunner: "command",
  commandRunner: {
    command: "node --test --experimental-strip-types tests/cache.test.ts tests/classifier-cache-key.test.ts tests/classifier-detection.test.ts tests/reliability.test.ts tests/routing.test.ts",
  },
  coverageAnalysis: "off",
  checkers: [],
  reporters: ["clear-text", "progress", "json"],
  thresholds: { high: 0, low: 0, break: null },
  tempDirName: ".stryker-tmp",
  // Focused 5-file suite measures ~0.6s; modest headroom keeps slower
  // reviewer machines from producing spurious timeout "kills".
  timeoutFactor: 2,
  timeoutMS: 10000,
};
