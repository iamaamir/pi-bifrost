// Quick local test tier (#145): every root test file except the four heavy
// ones, so local iteration stays ~30s instead of ~5min. Selection-based only —
// no skip markers, no assertion changes; CI still runs the full suite.
// Heavy files (measured in #145): run individually with `node --test tests/<file>`.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HEAVY = new Set([
  "acceptance-runner.test.mjs",
  "merge-controller.test.mjs",
  "acceptance-live.test.mjs",
  "router-package.test.mjs",
]);

const files = readdirSync("tests").filter((f) => /\.test\.(ts|mjs)$/.test(f) && !HEAVY.has(f));
// Canary against silent selection drift: ~100 root files today; a big drop
// means the glob or exclusions regressed.
if (files.length < 90) {
  console.error(`test:quick: expected ~100 root test files, found ${files.length} — selection drifted, refusing to run`);
  process.exit(2);
}
console.error(`test:quick: ${files.length} files (excluded: ${[...HEAVY].sort().join(", ")})`);
const result = spawnSync(process.execPath, ["--test", "--experimental-strip-types", ...files.map((f) => `tests/${f}`)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
