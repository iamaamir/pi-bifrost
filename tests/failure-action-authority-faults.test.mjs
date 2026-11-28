import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = "tests/failure-action-authority.test.ts";
const sources = [
  "failure-observations.ts", "reliability.ts", "reliability-v2.ts",
  "storage.ts", "reliability-v1-fence.ts", fixture,
];

const faults = [
  {
    path: "reliability.ts",
    before: "boundRuntimeAllowanceObservation(allowanceExhaustion, model, source, now)",
    after: "boundRuntimeAllowanceObservation(allowanceExhaustion ?? _observation, model, source, now)",
    expectedFailure: "V1 records a diagnostic without treating it as immediate allowance authority",
  },
  {
    path: "reliability-v2.ts",
    before: "const allowanceTrigger = allowanceEvidence;",
    after: "const allowanceTrigger = allowanceEvidence ?? observation;",
    expectedFailure: "V2 observation persistence does not authorize an allowance cooldown",
  },
];

function applyFault(dir, fault) {
  const path = join(dir, fault.path);
  const source = readFileSync(path, "utf8");
  assert.equal(source.split(fault.before).length, 2, `unique fault anchor: ${fault.path}`);
  writeFileSync(path, source.replace(fault.before, fault.after));
}

function runAuthorityTests(fault) {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-authority-"));
  try {
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    for (const path of sources) copyFileSync(join(root, path), join(dir, path));
    if (fault) applyFault(dir, fault);
    // Do not attribute coverage from deliberately mutated copies to the delivered source.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", "--test", "--test-reporter=tap", fixture,
    ], { cwd: dir, env, encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("authority fault controls: original source passes both contracts", () => {
  const { status, output } = runAuthorityTests();
  assert.equal(status, 0, output);
  assert.match(output, /^# tests 2$/m, output);
  assert.match(output, /^# pass 2$/m, output);
  assert.match(output, /^# fail 0$/m, output);
});

for (const fault of faults) {
  test(`authority fault controls: ${fault.path} diagnostic fallback is detected`, () => {
    const { status, output } = runAuthorityTests(fault);
    assert.equal(status, 1, output);
    assert.ok(output.split("\n").some(line =>
      line.trim().startsWith("not ok ") && line.endsWith(fault.expectedFailure)), output);
    assert.match(output, /code: 'ERR_ASSERTION'/, output);
    assert.match(output, /^# tests 2$/m, output);
    assert.match(output, /^# pass 1$/m, output);
    assert.match(output, /^# fail 1$/m, output);
  });
}
