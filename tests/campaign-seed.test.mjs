// Campaign seed preload tests (issue #85).
//
// The preload is test-only: it reads FC_SEED, validates it, and applies it as
// fast-check's global default seed. Assertions that pass an explicit seed keep
// their pinned replay behavior; this file proves both halves of that claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { applySeed, resolveSeed } from "./preload/fast-check-seed.mjs";

const PRELOAD_URL = new URL("./preload/fast-check-seed.mjs", import.meta.url).href;
// The probe lives in a temporary directory, so it imports fast-check by the
// resolved file URL to reach the same module instance as the preload.
const FAST_CHECK_URL = import.meta.resolve("fast-check");

/** In-process calls stay silent; the child-process test covers real logging. */
function applySilently(env) {
  return applySeed(env, { log: () => {} });
}

function withGlobalSeed(mutate) {
  const previous = fc.readConfigureGlobal();
  fc.resetConfigureGlobal();
  try {
    return mutate();
  } finally {
    fc.resetConfigureGlobal();
    if (previous !== undefined) fc.configureGlobal(previous);
  }
}

test("leaves fast-check global configuration untouched when FC_SEED is unset", () => {
  withGlobalSeed(() => {
    const before = fc.readConfigureGlobal();
    assert.equal(resolveSeed({}), undefined);
    assert.equal(applySilently({}), undefined);
    assert.deepEqual(fc.readConfigureGlobal(), before);
  });
});

test("applies a valid FC_SEED as the fast-check global seed", () => {
  withGlobalSeed(() => {
    assert.equal(resolveSeed({ FC_SEED: "1729" }), 1729);
    assert.equal(applySilently({ FC_SEED: "1729" }), 1729);
    assert.equal(fc.readConfigureGlobal()?.seed, 1729);
  });
});

test("accepts the full signed 32-bit seed range", () => {
  withGlobalSeed(() => {
    for (const raw of ["-2147483648", "2147483647", "0"]) {
      assert.equal(typeof resolveSeed({ FC_SEED: raw }), "number");
      assert.equal(applySilently({ FC_SEED: raw }), Number(raw));
      assert.equal(fc.readConfigureGlobal()?.seed, Number(raw));
      fc.resetConfigureGlobal();
    }
  });
});

test("rejects malformed, fractional, and out-of-range FC_SEED values", () => {
  for (const raw of ["abc", "1.5", " 1729", "1729 ", "1e9", "2147483648", "-2147483649", "17,29"]) {
    assert.throws(
      () => resolveSeed({ FC_SEED: raw }),
      /FC_SEED/,
      `expected ${JSON.stringify(raw)} to be rejected as FC_SEED`,
    );
  }
});

test("configured seed varies generated values while an explicit seed keeps replay", () => {
  withGlobalSeed(() => {
    const arb = fc.integer({ min: 0, max: 1_000_000_000 });
    applySilently({ FC_SEED: "1" });
    const fromOne = fc.sample(arb, { numRuns: 5 });
    applySilently({ FC_SEED: "2" });
    const fromTwo = fc.sample(arb, { numRuns: 5 });
    assert.notDeepEqual(fromTwo, fromOne, "distinct global seeds must generate distinct values");

    applySilently({ FC_SEED: "2" });
    const explicitUnderTwo = fc.sample(arb, { numRuns: 5, seed: 4242 });
    applySilently({ FC_SEED: "1" });
    const explicitUnderOne = fc.sample(arb, { numRuns: 5, seed: 4242 });
    assert.deepEqual(explicitUnderOne, explicitUnderTwo, "an explicit seed must win over the configured seed");
  });
});

test("node --test child processes load the preload and report the applied seed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-campaign-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, "probe.test.mjs");
  writeFileSync(probe, `
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from ${JSON.stringify(FAST_CHECK_URL)};

test("child saw the campaign seed", () => {
  assert.equal(fc.readConfigureGlobal()?.seed, Number(process.env.FC_SEED));
});
`);
  // The test runner marks its own children with NODE_TEST_CONTEXT; a nested
  // `node --test` must not inherit it or it refuses to run files.
  const childEnv = {
    ...process.env,
    FC_SEED: "20260116",
    NODE_OPTIONS: `--import=${PRELOAD_URL}`,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", probe], {
    encoding: "utf8",
    env: childEnv,
    timeout: 60_000,
  });
  const output = result.stdout + result.stderr;
  assert.match(output, /\[fc-seed\] FC_SEED=20260116/u, output);
  assert.match(output, /pass 1/u, output);
  assert.doesNotMatch(output, /fail 1/u, output);
  assert.equal(result.status, 0, output);
});
