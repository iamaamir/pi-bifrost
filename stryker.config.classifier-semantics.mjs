// Supplementary binding-sensitivity config (issue #62 evidence run).
// Mutates only classifier-semantics.ts and binds all three test files that
// import it directly, quantifying how much the focused stryker.config.mjs
// binding undercounts kills for this module.
// Run: npx stryker run stryker.config.classifier-semantics.mjs
export default {
  mutate: ["classifier-semantics.ts"],
  testRunner: "command",
  commandRunner: {
    command: "node --test --experimental-strip-types tests/classifier-cache-key.test.ts tests/classifier-detection.test.ts tests/classifier-effective-validation.test.ts",
  },
  coverageAnalysis: "off",
  checkers: [],
  reporters: ["clear-text", "progress", "json"],
  thresholds: { high: 0, low: 0, break: null },
  tempDirName: ".stryker-tmp",
  timeoutFactor: 2,
  timeoutMS: 10000,
};
