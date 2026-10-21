// Bounded campaign runner tests (issue #85).
//
// The runner repeats an existing command with distinct, replayable fast-check
// seeds, records command/seed/version/source/elapsed/results per attempt, and
// exits non-zero when any attempt fails, times out, or leaves children behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_REPEAT, deriveSeed, parseCampaignArgs } from "../scripts/campaign-run.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = fileURLToPath(new URL("../scripts/campaign-run.mjs", import.meta.url));
const SIGNED_32_MIN = -2_147_483_648;
const SIGNED_32_MAX = 2_147_483_647;

function run(args, options = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 120_000,
    ...options,
  });
}

function withOutDir(t) {
  const out = mkdtempSync(join(tmpdir(), "bifrost-campaign-run-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return out;
}

function readCampaign(out, name) {
  return JSON.parse(readFileSync(join(out, name, "campaign.json"), "utf8"));
}

test("rejects out-of-bounds repeat, seed base, timeout, and name values", () => {
  const cases = [
    [["--name", "properties", "--repeat", "0", "--seed-base", "1", "--", "node", "-e", ""], /--repeat/u],
    [[`--name`, "properties", "--repeat", String(MAX_REPEAT + 1), "--seed-base", "1", "--", "node", "-e", ""], /--repeat/u],
    [["--name", "properties", "--repeat", "1", "--seed-base", "1.5", "--", "node", "-e", ""], /--seed-base/u],
    [["--name", "properties", "--repeat", "1", "--seed-base", "2147483648", "--", "node", "-e", ""], /--seed-base/u],
    [["--name", "properties", "--repeat", "1", "--seed-base", "1", "--timeout-ms", "999", "--", "node", "-e", ""], /--timeout-ms/u],
    [["--name", "Properties!", "--repeat", "1", "--seed-base", "1", "--", "node", "-e", ""], /--name/u],
    [["--name", "properties", "--repeat", "1", "--seed-base", "1"], /command/u],
    [["--name", "properties", "--repeat", "1", "--seed-base", "1", "--out", REPO_ROOT, "--", "node", "-e", ""], /--out must stay outside the repository/u],
  ];
  for (const [args, expected] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, expected);
  }
});

test("derives distinct, replayable, in-range seeds from one seed base", () => {
  assert.equal(MAX_REPEAT, 5, "the campaign repeat count stays hard-bounded");
  const seeds = Array.from({ length: MAX_REPEAT }, (_, attempt) => deriveSeed(1729, attempt));
  assert.equal(seeds[0], 1729, "attempt zero must use the requested seed base");
  assert.equal(deriveSeed(0, 0), 0);
  assert.equal(deriveSeed(SIGNED_32_MIN, 0), SIGNED_32_MIN);
  assert.equal(deriveSeed(SIGNED_32_MAX, 1), -2_146_441_106, "overflow must wrap to signed32");
  assert.equal(new Set(seeds).size, MAX_REPEAT, "derived seeds must be distinct");
  assert.deepEqual(seeds, Array.from({ length: MAX_REPEAT }, (_, attempt) => deriveSeed(1729, attempt)));
  for (const seed of [...seeds, deriveSeed(0, 0), deriveSeed(SIGNED_32_MAX, 4), deriveSeed(SIGNED_32_MIN, 0)]) {
    assert.ok(Number.isInteger(seed) && seed >= SIGNED_32_MIN && seed <= SIGNED_32_MAX, `seed out of signed32 range: ${seed}`);
  }
  assert.throws(() => deriveSeed("1729", 0), /seed base/u);
  assert.throws(() => deriveSeed(1729, -1), /attempt/u);
});

test("parses a bounded campaign configuration without running anything", () => {
  const config = parseCampaignArgs([
    "--name", "properties", "--repeat", "3", "--seed-base", "1729",
    "--timeout-ms", "60000", "--out", "/tmp/out", "--", "node", "-e", "",
  ]);
  assert.equal(config.name, "properties");
  assert.equal(config.repeat, 3);
  assert.equal(config.seedBase, 1729);
  assert.equal(config.timeoutMs, 60_000);
  assert.deepEqual(config.seeds, [deriveSeed(1729, 0), deriveSeed(1729, 1), deriveSeed(1729, 2)]);
  assert.deepEqual(config.command, ["node", "-e", ""]);
});

test("validate-only prints the resolved bounds and seeds without running the command", () => {
  const result = run([
    "--name", "properties", "--repeat", "3", "--seed-base", "1729", "--validate-only",
    "--", "node", "-e", "process.exit(7)",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.repeat, 3);
  assert.deepEqual(config.seeds, [deriveSeed(1729, 0), deriveSeed(1729, 1), deriveSeed(1729, 2)]);
  assert.equal(config.validateOnly, true);
});

test("records seeds, versions, source identity, and elapsed time for every attempt", (t) => {
  const out = withOutDir(t);
  const result = run([
    "--name", "records", "--repeat", "2", "--seed-base", "1729", "--out", out,
    "--", process.execPath, "-e", "console.log('attempt-seed=' + process.env.FC_SEED)",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const campaign = readCampaign(out, "records");
  assert.equal(campaign.name, "records");
  assert.equal(campaign.repeat, 2);
  assert.equal(campaign.seedBase, 1729);
  assert.deepEqual(campaign.seeds, [deriveSeed(1729, 0), deriveSeed(1729, 1)]);
  assert.deepEqual(
    campaign.attempts.map((attempt) => attempt.seed),
    campaign.seeds,
    "attempt seeds must match the declared, replayable seed list",
  );
  assert.equal(campaign.summary.passed, 2);
  assert.equal(campaign.summary.failed, 0);
  assert.equal(campaign.summary.exitCode, 0);
  assert.match(campaign.node, /^v\d+/u);
  assert.match(campaign.npm, /^\d+/u);
  assert.match(campaign.gitRevision, /^[0-9a-f]{7,}$/u);
  assert.match(campaign.source, /^[0-9a-f]{64}$/u);
  assert.ok(campaign.elapsedMs >= 0);
  assert.equal(campaign.changedDuringRun, false);
  for (const attempt of campaign.attempts) {
    assert.equal(attempt.status, "passed");
    assert.equal(attempt.exitCode, 0);
    assert.ok(attempt.elapsedMs >= 0);
    assert.ok(existsSync(attempt.logFile), `missing attempt log: ${attempt.logFile}`);
    const log = readFileSync(attempt.logFile, "utf8");
    assert.match(log, new RegExp(`seed: ${attempt.seed}`, "u"));
    assert.match(log, new RegExp(`\\[fc-seed\\] FC_SEED=${attempt.seed} applied as fast-check global seed`, "u"));
    assert.match(log, new RegExp(`attempt-seed=${attempt.seed}`, "u"));
  }
});

test("propagates a failing attempt as a failing campaign with honest counts", (t) => {
  const out = withOutDir(t);
  const result = run([
    "--name", "failing", "--repeat", "2", "--seed-base", "1729", "--out", out,
    "--", process.execPath, "-e", `process.exit(process.env.FC_SEED === '${deriveSeed(1729, 1)}' ? 3 : 0)`,
  ]);
  assert.equal(result.status, 1, `campaign must fail when an attempt fails\n${result.stdout}`);
  const campaign = readCampaign(out, "failing");
  assert.equal(campaign.summary.attempted, 2);
  assert.equal(campaign.summary.passed, 1, "the first attempt still passes");
  assert.equal(campaign.summary.failed, 1);
  assert.equal(campaign.summary.exitCode, 1);
  const failure = campaign.attempts.find((attempt) => attempt.status === "failed");
  assert.equal(failure.exitCode, 3);
  assert.match(readFileSync(failure.logFile, "utf8"), /status: failed \(exit 3\)/u);
});

test("stops before spawning another attempt after failure", (t) => {
  const out = withOutDir(t);
  const receipts = join(out, "spawn-receipts.txt");
  const result = run([
    "--name", "fail-fast", "--repeat", "3", "--seed-base", "1729", "--out", out,
    "--", process.execPath, "-e",
    "require('node:fs').appendFileSync(process.argv[1], 'spawned\\n'); process.exit(3)", receipts,
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(receipts, "utf8"), "spawned\n", "only one real child must start");
  const campaign = readCampaign(out, "fail-fast");
  assert.equal(campaign.summary.attempted, 1);
  assert.equal(campaign.summary.failed, 1);
});

test("bounds a hung attempt and fails the campaign instead of waiting forever", (t) => {
  const out = withOutDir(t);
  const startedMs = Date.now();
  const result = run([
    "--name", "hung", "--repeat", "1", "--seed-base", "1729", "--out", out,
    "--timeout-ms", "1500", "--", process.execPath, "-e", "setTimeout(() => {}, 60000)",
  ]);
  const elapsedMs = Date.now() - startedMs;
  assert.equal(result.status, 1, result.stdout);
  assert.ok(elapsedMs < 30_000, `hung attempt must be cut off promptly, took ${elapsedMs}ms`);
  const campaign = readCampaign(out, "hung");
  assert.equal(campaign.summary.timeout, 1);
  assert.equal(campaign.summary.failed, 0, "timeouts are counted separately from failing exits");
  assert.equal(campaign.summary.passed + campaign.summary.failed + campaign.summary.timeout, campaign.summary.attempted);
  assert.equal(campaign.summary.exitCode, 1);
  const attempt = campaign.attempts[0];
  assert.equal(attempt.status, "timeout");
  assert.equal(attempt.exitCode, 124);
  assert.equal(attempt.processCleanupFailed, false, "the hung child group must be reaped");
  assert.equal(attempt.timeoutMs, 1500);
  const log = readFileSync(attempt.logFile, "utf8");
  assert.match(log, /attempt exceeded --timeout-ms=1500/u);
  assert.match(log, /Command timed out after 1500 ms/u, "the shared runner must report the bound actually used");
  assert.doesNotMatch(log, /20 minutes/u);
});

test("replays the same seed list for the same configuration", (t) => {
  const out = withOutDir(t);
  const args = ["--name", "replay", "--repeat", "3", "--seed-base", "1729", "--validate-only", "--", "node", "-e", ""];
  const first = JSON.parse(run(args).stdout);
  const second = JSON.parse(run(args).stdout);
  assert.deepEqual(second.seeds, first.seeds);
  assert.deepEqual(first.seeds, [deriveSeed(1729, 0), deriveSeed(1729, 1), deriveSeed(1729, 2)]);
});
