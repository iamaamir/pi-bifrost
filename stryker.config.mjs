// StrykerJS configuration entry point.
//
// Stryker auto-detects this file at the repository root, but all configuration
// lives in mutation/config.mjs so there is one place to tune. This shim only
// selects the target, the shard's mutated scope, and whether this run may reuse
// stored results.
//
//   node mutation/run.mjs                     # the runner sets these variables
//   MUTATION_TARGET=routing.ts npx stryker run
//   MUTATION_TARGET=cache.ts MUTATION_MUTATE=cache.ts:1-140 npx stryker run
//   MUTATION_TARGET=routing.ts MUTATION_INCREMENTAL=1 npx stryker run   # local loop (TAP only)
//
// This is not a pull-request gate; the nightly workflow runs it.
import { targetConfig, targetNames } from "./mutation/targets.mjs";

const target = process.env.MUTATION_TARGET ?? targetNames()[0];

export default targetConfig(target, {
  mutate: process.env.MUTATION_MUTATE || undefined,
  // Incremental is a developer convenience only. CI leaves it unset so the
  // nightly measures every mutant instead of replaying a stored score.
  incremental: process.env.MUTATION_INCREMENTAL === "1",
  reportFile: process.env.MUTATION_REPORT_FILE ?? "reports/mutation/mutation.json",
});
