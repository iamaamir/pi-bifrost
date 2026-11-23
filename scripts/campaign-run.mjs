#!/usr/bin/env node
// Bounded expanded-campaign runner (issue #85).
//
// Repeats one existing command with distinct, replayable fast-check seeds.
// Every attempt records command, seed, installed versions, source identity,
// elapsed time, and results; the campaign fails as soon as any attempt fails,
// times out, or leaves a child process group behind. Seeds reach the tests
// through FC_SEED plus the test-only preload (tests/preload/fast-check-seed.mjs)
// injected with NODE_OPTIONS, so assertions that pass an explicit seed keep
// their pinned replay behavior while seedless assertions vary per attempt.
//
// Bounds: --repeat is limited to MAX_REPEAT, --timeout-ms to MAX_TIMEOUT_MS,
// and --out must stay outside the repository so campaign evidence can never
// dirty the tracked tree.
//
// Usage:
//   node scripts/campaign-run.mjs --name properties --repeat 3 --seed-base 1729 \
//     [--timeout-ms 1200000] [--out DIR] [--validate-only] -- <command> [args...]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChild } from "./acceptance.mjs";
import { git, installedToolVersions, sourceFingerprint } from "./acceptance/core.mjs";

export const MAX_REPEAT = 5;
export const MAX_TIMEOUT_MS = 1_200_000;
export const MIN_TIMEOUT_MS = 1_000;
export const SEED_STRIDE = 1_042_543;
export const PRELOAD_PATH = fileURLToPath(new URL("../tests/preload/fast-check-seed.mjs", import.meta.url));

const SIGNED_32_MIN = -2_147_483_648;
const SIGNED_32_MAX = 2_147_483_647;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requireInteger(flag, raw, { min, max }) {
  if (raw === undefined || !/^-?\d+$/u.test(raw)) {
    throw new Error(`${flag} must be an integer, received: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be between ${min} and ${max}, received: ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Deterministic seed derivation: seed(attempt) = signed32(seedBase + attempt * SEED_STRIDE). */
export function deriveSeed(seedBase, attempt) {
  if (!Number.isSafeInteger(seedBase) || seedBase < SIGNED_32_MIN || seedBase > SIGNED_32_MAX) {
    throw new Error(`seed base must be a signed 32-bit integer, received: ${JSON.stringify(seedBase)}`);
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error(`attempt must be a non-negative integer, received: ${JSON.stringify(attempt)}`);
  }
  return Number(BigInt.asIntN(32, BigInt(seedBase) + BigInt(attempt) * BigInt(SEED_STRIDE)));
}

function assertOutsideRepository(out) {
  const resolved = resolve(out);
  const inside = resolved === ROOT || resolved.startsWith(ROOT + sep);
  if (inside) {
    throw new Error(`--out must stay outside the repository (evidence inside the tree would dirty the source): ${resolved}`);
  }
  return resolved;
}

/**
 * Parse and bound a campaign configuration. Throws on any out-of-range or
 * unknown flag; never runs the command.
 */
export function parseCampaignArgs(argv) {
  const values = { name: undefined, repeat: undefined, seedBase: undefined, timeoutMs: MAX_TIMEOUT_MS, out: undefined, validateOnly: false };
  const present = new Set();
  const valueFlags = new Set(["--name", "--repeat", "--seed-base", "--timeout-ms", "--out"]);
  let index = 0;
  for (; index < argv.length; index++) {
    const raw = argv[index];
    if (raw === "--") { index++; break; }
    if (raw === "--validate-only") {
      if (present.has(raw)) throw new Error(`${raw} may only be specified once`);
      present.add(raw);
      values.validateOnly = true;
      continue;
    }
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    if (!valueFlags.has(flag)) throw new Error(`unknown campaign flag: ${JSON.stringify(raw)}`);
    if (present.has(flag)) throw new Error(`${flag} may only be specified once`);
    present.add(flag);
    const value = equals < 0 ? argv[++index] : raw.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--name") values.name = value;
    else if (flag === "--repeat") values.repeat = requireInteger(flag, value, { min: 1, max: MAX_REPEAT });
    else if (flag === "--seed-base") values.seedBase = requireInteger(flag, value, { min: SIGNED_32_MIN, max: SIGNED_32_MAX });
    else if (flag === "--timeout-ms") values.timeoutMs = requireInteger(flag, value, { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
    else if (flag === "--out") assertOutsideRepository(value);
    if (flag === "--out") values.out = resolve(value);
  }
  const command = argv.slice(index);
  if (values.name === undefined) throw new Error("--name is required");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(values.name)) {
    throw new Error(`--name must be lowercase alphanumeric with dashes, received: ${JSON.stringify(values.name)}`);
  }
  if (values.repeat === undefined) throw new Error("--repeat is required");
  if (values.seedBase === undefined) throw new Error("--seed-base is required");
  if (command.length === 0 && !values.validateOnly) throw new Error("a command is required after --");
  const seeds = Array.from({ length: values.repeat }, (_, attempt) => deriveSeed(values.seedBase, attempt));
  return {
    name: values.name,
    repeat: values.repeat,
    seedBase: values.seedBase,
    timeoutMs: values.timeoutMs,
    out: values.out ?? join(tmpdir(), `bifrost-campaign-${values.name}`),
    validateOnly: values.validateOnly,
    seeds,
    command,
  };
}

function attemptStatus(status) {
  if (status === 0) return "passed";
  if (status === 124) return "timeout";
  return "failed";
}

function childEnvironment(seed) {
  const preloadImport = `--import=${pathToFileURL(PRELOAD_PATH).href}`;
  const existing = process.env.NODE_OPTIONS?.trim();
  return {
    ...process.env,
    FC_SEED: String(seed),
    NODE_OPTIONS: existing ? `${existing} ${preloadImport}` : preloadImport,
  };
}

function writeAttemptLog({ campaignDir, config, attempt, seed, result, startedAt, finishedAt, elapsedMs, status }) {
  const logFile = join(campaignDir, `attempt-${String(attempt).padStart(2, "0")}-seed-${seed}.log`);
  const statusLine = status === "timeout"
    ? `status: timeout (attempt exceeded --timeout-ms=${config.timeoutMs}; exit ${result.status})`
    : `status: ${status} (exit ${result.status})`;
  const lines = [
    `campaign: ${config.name}`,
    `attempt: ${attempt}/${config.repeat}`,
    `seed: ${seed}`,
    `command: ${config.command.join(" ")}`,
    `timeout-ms: ${config.timeoutMs}`,
    `started-at: ${startedAt}`,
    `finished-at: ${finishedAt}`,
    `elapsed-ms: ${elapsedMs}`,
    statusLine,
    `process-cleanup-failed: ${result.processCleanupFailed === true}`,
    `output-truncated: ${result.outputTruncated === true}`,
    "--- stdout ---",
    result.stdout ?? "",
    "--- stderr ---",
    result.stderr ?? "",
    "",
  ];
  writeFileSync(logFile, lines.join("\n"));
  return logFile;
}

export async function runCampaign(config, { log = (line) => process.stdout.write(line + "\n") } = {}) {
  const campaignDir = join(config.out, config.name);
  mkdirSync(campaignDir, { recursive: true });
  const startedAtMs = Date.now();
  const versions = installedToolVersions(ROOT);
  const revision = (() => {
    try { return git(ROOT, ["rev-parse", "HEAD"]); } catch { return null; }
  })();
  const sourceBefore = sourceFingerprint(ROOT);
  const attempts = [];
  let aborted = null;
  for (let index = 0; index < config.repeat; index++) {
    const seed = config.seeds[index];
    const attemptStartedAt = new Date().toISOString();
    const attemptStartedMs = Date.now();
    const result = await runChild(config.command[0], config.command.slice(1), {
      cwd: process.cwd(),
      env: childEnvironment(seed),
      timeoutMs: config.timeoutMs,
    });
    const elapsedMs = Date.now() - attemptStartedMs;
    const finishedAt = new Date().toISOString();
    const status = attemptStatus(result.status);
    const logFile = writeAttemptLog({ campaignDir, config, attempt: index + 1, seed, result, startedAt: attemptStartedAt, finishedAt, elapsedMs, status });
    attempts.push({
      attempt: index + 1,
      seed,
      status,
      exitCode: result.status,
      timeoutMs: config.timeoutMs,
      elapsedMs,
      startedAt: attemptStartedAt,
      finishedAt,
      logFile,
      outputTruncated: result.outputTruncated === true,
      processCleanupFailed: result.processCleanupFailed === true,
    });
    log(`campaign ${config.name} attempt ${index + 1}/${config.repeat} seed=${seed} status=${status} exit=${result.status} elapsed-ms=${elapsedMs}`);
    // A campaign only produces valid evidence when each attempt passes, cleans
    // up its child process group, and leaves the source tree byte-stable.
    // Abort before launching another attempt; do not merely record the failure.
    if (status !== "passed") {
      aborted = `attempt ${index + 1} did not pass (status=${status}, exit=${result.status})`;
      break;
    }
    if (result.processCleanupFailed === true) {
      aborted = `attempt ${index + 1} left an owned child process group behind`;
      break;
    }
    const sourceAfterAttempt = sourceFingerprint(ROOT);
    if (sourceAfterAttempt !== sourceBefore) {
      aborted = `source tree changed during attempt ${index + 1}`;
      break;
    }
  }
  const sourceAfter = sourceFingerprint(ROOT);
  const summary = {
    attempted: attempts.length,
    passed: attempts.filter((attempt) => attempt.status === "passed").length,
    failed: attempts.filter((attempt) => attempt.status === "failed").length,
    timeout: attempts.filter((attempt) => attempt.status === "timeout").length,
    aborted,
    validEvidence: aborted === null && sourceBefore === sourceFingerprint(ROOT) && attempts.every((attempt) => attempt.status === "passed"),
    exitCode: aborted === null && attempts.every((attempt) => attempt.status === "passed") ? 0 : 1,
  };
  const campaign = {
    name: config.name,
    command: config.command,
    commandLine: config.command.join(" "),
    repeat: config.repeat,
    seedBase: config.seedBase,
    seedDerivation: `seed(attempt) = signed32(seedBase + attempt * ${SEED_STRIDE}), attempt starts at 0`,
    seeds: config.seeds,
    timeoutMs: config.timeoutMs,
    out: config.out,
    node: process.version,
    npm: versions.runtime.npm,
    packages: versions.installed,
    gitRevision: revision,
    source: sourceBefore,
    sourceAfter,
    aborted,
    validEvidence: aborted === null && sourceBefore === sourceFingerprint(ROOT),
    changedDuringRun: sourceBefore !== sourceAfter,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    attempts,
    summary,
  };
  const evidencePath = join(campaignDir, "campaign.json");
  writeFileSync(evidencePath, JSON.stringify(campaign, null, 2) + "\n");
  log(`campaign ${config.name}: ${summary.passed}/${summary.attempted} passed, ${summary.failed} failed, ${summary.timeout} timed out, valid-evidence=${summary.validEvidence} (${campaign.elapsedMs}ms)`);
  log(`campaign evidence: ${relative(ROOT, evidencePath) || evidencePath}`);
  return { campaign, evidencePath };
}

async function main(argv) {
  const config = parseCampaignArgs(argv);
  if (config.validateOnly) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return 0;
  }
  const { campaign } = await runCampaign(config);
  return campaign.summary.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`campaign-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
