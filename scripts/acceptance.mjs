#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateDirectory, git, gitTruth, installedToolVersions, matchNamedTestEvent, parseArgs, processGroupExists, sourceFingerprint, summarizeCases, terminateProcessGroup, verificationGateEnvironment } from "./acceptance/core.mjs";
import { exportCiReportIfConfigured } from "./ci-report.mjs";
export { processGroupExists, terminateProcessGroup, verificationGateEnvironment };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_FILES = {
  contract: "./acceptance/profiles/contract.mjs",
  live: "./acceptance/profiles/live.mjs",
};
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_REPORTER_LINE_BYTES = 1024 * 1024;
const MAX_REPORTER_EVENTS = 20_000;
const MAX_REPORTER_EVENT_BYTES = 16 * 1024 * 1024;
let activeChild;
let activeTermination;
let receivedSignal;
const SUPPORTING_TESTS = [
  { id: "runtime-preview-router-parity", requirement: "R01", file: "tests/integration/decision-parity-acceptance.test.mjs", name: "keeps selected, excluded, fallback, and no-route decisions aligned across all three surfaces", boundary: "pinned Pi physical runtime, pinned Pi offline preview, and installed packed resolve-only API", caseArtifact: "cases/runtime-preview-router-parity/parity.json" },
  { id: "support:r06:strict-activation", requirement: "R06", file: "tests/strict-runtime.test.ts", name: "handles false and throwing physical activation inside a strict policy", boundary: "registered runtime handler; not Pi RPC" },
  { id: "support:r06:cancelled-registry-wait", requirement: "R06", file: "tests/strict-runtime.test.ts", name: "stops an aborted registry wait and preserves a newer editor draft", boundary: "registered runtime handler; not Pi RPC" },
  { id: "support:r09:invalid-reload", requirement: "R09", file: "tests/strict-runtime.test.ts", name: "blocks invalid policy at startup and retains last-good config on invalid reload", boundary: "config/runtime unit boundary" },
  { id: "support:r10:declared-billing-class", requirement: "R10", file: "tests/integration/command-policy-acceptance.test.mjs", name: "dispatches to the fresh declared billing-class preference and makes no classifier call", boundary: "real Pi RPC with synthetic registry; no live billing adapter" },
  { id: "support:r11:eligible-affinity", requirement: "R11", file: "tests/routing.test.ts", name: "retains an automatic anchor only inside the selected tier's final strategy pool", boundary: "pure resolver; branch/session lifecycle not proven" },
  { id: "support:r13:packed-experimental-api", requirement: "R13", file: "tests/router-package.test.mjs", name: "installs the packed JS API and resolves without loader flags on Node 22.19+", boundary: "installed experimental consumer API; stable versioned contract deferred" },
  { id: "support:r14:redacted-observation", requirement: "R14", file: "tests/typesafe-classifier.test.ts", name: "persists only redacted TypeSafe debug metadata", boundary: "unit privacy projection; not complete local trace contract" },
  { id: "support:r17:generic-strategy", requirement: "R17", file: "tests/routing.test.ts", name: "defaults to first", boundary: "pure generic strategy resolver; arbitrary tier strings separately configured" },
];

function usage() {
  return [
    "Usage: npm run acceptance -- [--profile deterministic|contract|live]",
    "Live only: --allow-live --allow-model provider/model (exactly one model)",
    "           [--max-requests-per-model 1..4] [--deadline-seconds 1..300]",
  ].join("\n");
}

function sanitize(text) {
  return text
    .replace(/((?:proxy-)?authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n]+/gim, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]");
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function signalProcessGroup(child) {
  if (!child?.pid) return;
  activeTermination ??= terminateProcessGroup(child);
}

export function registerTerminationHandlers() {
  const onSignal = (signal) => {
    receivedSignal ??= signal;
    signalProcessGroup(activeChild);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    return receivedSignal;
  };
}

function enforceGateNetworkBoundary(result, violationPath) {
  let violations = "";
  try { violations = readFileSync(violationPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (violations.length) {
    result.status = 1;
    result.stderr += "\nOutbound network guard recorded a blocked request; the deterministic gate failed.";
  }
  result.networkGuardArtifact = violationPath;
  return result;
}

function createOutputCapture(limit = MAX_CAPTURE_BYTES) {
  const segmentLimit = Math.floor(limit / 2);
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      let bytes = Buffer.from(chunk);
      size += bytes.length;
      if (head.length < segmentLimit) {
        const count = Math.min(segmentLimit - head.length, bytes.length);
        head = Buffer.concat([head, bytes.subarray(0, count)]);
        bytes = bytes.subarray(count);
      }
      if (bytes.length) tail = Buffer.concat([tail, bytes]).subarray(-segmentLimit);
    },
    text() {
      const truncated = size > limit;
      if (!truncated) return Buffer.concat([head, tail]).toString("utf8");
      return `${head.toString("utf8")}\n[stream output truncated]\n${tail.toString("utf8")}`;
    },
    truncated() { return size > limit; },
  };
}

export function runChild(command, args, {
  cwd,
  env,
  timeoutMs = 20 * 60 * 1000,
  captureLimit = MAX_CAPTURE_BYTES,
  onStdoutLine,
  reporterMaxEvents = MAX_REPORTER_EVENTS,
  reporterMaxBytes = MAX_REPORTER_EVENT_BYTES,
}) {
  return new Promise((resolveResult) => {
    if (receivedSignal) {
      resolveResult({ status: signalExitCode(receivedSignal), stdout: "", stderr: `Gate skipped after ${receivedSignal}.`, outputTruncated: false, reporterLineTooLarge: false });
      return;
    }
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    const stdout = createOutputCapture(captureLimit);
    const stderr = createOutputCapture(captureLimit);
    const decoder = new StringDecoder("utf8");
    let reporterRemainder = "";
    let reporterLineTooLarge = false;
    let reporterEventOverflowed = false;
    let reporterEventCount = 0;
    let reporterEventBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child);
    }, timeoutMs);
    const consumeStdoutText = (text) => {
      if (!onStdoutLine || reporterLineTooLarge) return;
      reporterRemainder += text;
      if (Buffer.byteLength(reporterRemainder) > MAX_REPORTER_LINE_BYTES && !reporterRemainder.includes("\n")) {
        reporterLineTooLarge = true;
        reporterRemainder = "";
        return;
      }
      const lines = reporterRemainder.split("\n");
      reporterRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (Buffer.byteLength(line) > MAX_REPORTER_LINE_BYTES) {
          reporterLineTooLarge = true;
          reporterRemainder = "";
          return;
        }
        const eventBytes = Buffer.byteLength(line);
        if (reporterEventCount >= reporterMaxEvents || reporterEventBytes + eventBytes > reporterMaxBytes) {
          reporterEventOverflowed = true;
          continue;
        }
        reporterEventCount++;
        reporterEventBytes += eventBytes;
        onStdoutLine(line.replace(/\r$/u, ""));
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      consumeStdoutText(decoder.write(chunk));
    });
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", async (error) => {
      clearTimeout(timeout);
      let cleanupFailed = false;
      try { cleanupFailed = activeTermination !== undefined && !(await activeTermination); }
      catch { cleanupFailed = true; }
      if (activeChild === child) activeChild = undefined;
      activeTermination = undefined;
      resolveResult({
        status: 1,
        stdout: stdout.text(),
        stderr: stderr.text() + error.message + (cleanupFailed ? "\nCould not confirm that the child process group terminated." : ""),
        outputTruncated: stdout.truncated() || stderr.truncated(),
        reporterLineTooLarge,
        reporterEventOverflowed,
      });
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      if (!activeTermination && process.platform !== "win32" && processGroupExists(child.pid)) {
        activeTermination = terminateProcessGroup(child);
      }
      let cleanupFailed = false;
      try { cleanupFailed = activeTermination !== undefined && !(await activeTermination); }
      catch { cleanupFailed = true; }
      if (activeChild === child) activeChild = undefined;
      activeTermination = undefined;
      consumeStdoutText(decoder.end());
      if (reporterRemainder && Buffer.byteLength(reporterRemainder) > MAX_REPORTER_LINE_BYTES) reporterLineTooLarge = true;
      if (onStdoutLine && !reporterLineTooLarge && reporterRemainder) onStdoutLine(reporterRemainder.replace(/\r$/u, ""));
      resolveResult({
        status: cleanupFailed ? 1 : timedOut ? 124 : receivedSignal ? signalExitCode(receivedSignal) : reporterLineTooLarge || reporterEventOverflowed ? 1 : code ?? 1,
        stdout: stdout.text(),
        stderr: (timedOut ? stderr.text() + `\nCommand timed out after ${timeoutMs} ms.` : signal ? stderr.text() + `\nProcess ended by ${signal}.` : stderr.text())
          + (cleanupFailed ? "\nCould not confirm that the child process group terminated." : ""),
        outputTruncated: stdout.truncated() || stderr.truncated(),
        reporterLineTooLarge,
        reporterEventOverflowed,
        processCleanupFailed: cleanupFailed,
      });
    });
  });
}

async function executeVerificationGate({ root, script, testEvents, artifactDir }) {
  const gateEnvironment = verificationGateEnvironment({ root, artifactDir, script });
  if (script !== "test" && script !== "test:integration") {
    return enforceGateNetworkBoundary(await runChild("npm", ["run", script], { cwd: root, env: gateEnvironment.env }), gateEnvironment.violationPath);
  }
  const reporterPath = join(root, "scripts", "acceptance", "test-event-reporter.mjs");
  const testPaths = script === "test"
    ? ["tests/*.test.ts", "tests/*.test.mjs"]
    : ["tests/integration/*.test.mjs"];
  let malformedEvent = false;
  const result = await runChild(process.execPath, [
    "--test",
    "--experimental-strip-types",
    `--test-reporter=${reporterPath}`,
    ...testPaths,
  ], {
    cwd: root,
    env: gateEnvironment.env,
    onStdoutLine(line) {
      if (!line) return;
      try { testEvents.push(JSON.parse(line)); }
      catch { malformedEvent = true; }
    },
  });
  if (malformedEvent || result.reporterLineTooLarge) {
    result.status = 1;
    result.stderr += malformedEvent
      ? "\nNode test reporter returned malformed JSONL."
      : "\nNode test reporter emitted a line larger than the 1 MiB safety limit; structured event capture is incomplete.";
  }
  if (result.reporterEventOverflowed) {
    result.status = 1;
    result.stderr += "\nNode test reporter exceeded the structured event count or total-byte limit; structured event capture is incomplete.";
  }
  return enforceGateNetworkBoundary(result, gateEnvironment.violationPath);
}

async function runDeterministic({ root, artifactDir }) {
  const { runVerification } = await import("./verify-release.mjs");
  const runStartedMs = Date.now();
  const testEvents = [];
  const verification = await runVerification({
    root,
    execute: ({ script }) => executeVerificationGate({ root, script, testEvents, artifactDir }),
  });
  const testEventsArtifact = writeNodeTestEventsArtifact({ root, artifactDir, testEvents });
  if (receivedSignal) {
    return [{
      id: "deterministic:interrupted",
      requirements: [],
      boundary: "deterministic-release-gates",
      status: "failed",
      required: true,
      attempts: testEvents.length,
      exclusions: [],
      artifacts: [relative(root, testEventsArtifact)],
      detail: `The deterministic profile stopped after ${receivedSignal}; active child process groups were terminated and awaited.`,
    }];
  }
  const terminalCaptures = [];
  const uiCaptureDir = join(root, "screenshots", "ui-smoke");
  try {
    const targetDir = join(artifactDir, "terminal");
    for (const name of readdirSync(uiCaptureDir)) {
      const source = join(uiCaptureDir, name);
      if (!statSync(source).isFile() || statSync(source).mtimeMs < runStartedMs || !/\.(?:png|txt|ansi\.log)$/.test(name)) continue;
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, name);
      if (/\.(?:txt|ansi\.log)$/.test(name)) writeFileSync(target, sanitize(readFileSync(source, "utf8")));
      else copyFileSync(source, target);
      terminalCaptures.push(relative(root, target));
    }
  } catch {}
  const cases = buildGateEvidenceCases({ verification, root, artifactDir, terminalCaptures });
  const eventPath = relative(root, testEventsArtifact);
  for (const target of SUPPORTING_TESTS) {
    cases.push(supportingTestCase({ target, testEvents, artifactDir, root, eventPath }));
  }
  cases.push({
    id: "deferred:r13:stable-versioned-api",
    requirements: ["R13"],
    boundary: "stable public API contract",
    status: "deferred",
    required: false,
    attempts: [],
    exclusions: ["The installed consumer smoke covers the existing experimental API only."],
    artifacts: [eventPath],
    detail: "A stable versioned resolve-only TypeScript contract is deferred; see RELEASE-PLAN.md.",
  });
  cases.push({
    id: "node-test-event-capture",
    requirements: [],
    boundary: "unit-and-pinned-pi-integration-test-events",
    status: testEvents.length > 0 ? "passed" : "blocked",
    required: true,
    startedAt: new Date(runStartedMs).toISOString(),
    endedAt: new Date().toISOString(),
    attempts: testEvents.length,
    exclusions: ["UI verification and non-test gates do not emit Node test events."],
    artifacts: [relative(root, testEventsArtifact)],
    ...(testEvents.length === 0 ? { detail: "Neither Node test gate emitted structured per-test results." } : {}),
  });
  const hasTerminalImage = terminalCaptures.some((path) => path.endsWith(".png"));
  const hasTerminalText = terminalCaptures.some((path) => path.endsWith(".txt"));
  cases.push({
    id: "terminal-captures",
    requirements: ["R16"],
    boundary: "pinned-Pi-terminal-ui",
    status: hasTerminalImage && hasTerminalText ? "passed" : "blocked",
    required: true,
    startedAt: new Date(runStartedMs).toISOString(),
    endedAt: new Date().toISOString(),
    attempts: 1,
    exclusions: [],
    artifacts: terminalCaptures,
    ...(!(hasTerminalImage && hasTerminalText) ? { detail: "The UI gate produced no fresh terminal image and text capture for this run." } : {}),
  });
  let journeys;
  try {
    ({ runJourneys: journeys } = await import("./acceptance/journeys.mjs"));
    const result = await journeys({ root, artifactDir, options: { shouldStop: () => Boolean(receivedSignal) } });
    cases.push(...result.cases);
  } catch (error) {
    cases.push({
      id: "journeys:runner",
      requirements: [],
      boundary: "critical-user-journeys",
      status: "blocked",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: "Journey profile unavailable or failed: " + (error instanceof Error ? error.message : String(error)),
    });
  }
  return cases;
}

export function supportingTestCase({ target, testEvents, artifactDir, root, eventPath }) {
  const result = matchNamedTestEvent(testEvents, target);
  const caseArtifact = target.caseArtifact ? join(artifactDir, target.caseArtifact) : undefined;
  const hasCaseArtifact = caseArtifact ? existsSync(caseArtifact) : true;
  const status = !result ? "blocked" : !result.passed ? "failed" : !hasCaseArtifact ? "blocked" : "passed";
  return {
      id: target.id,
      requirements: [target.requirement],
      boundary: target.boundary,
      status,
      required: true,
      durationMs: result?.durationMs ?? null,
      attempts: result ? [{ durationMs: result.durationMs, result: result.passed ? "passed" : "failed", testFile: target.file, testName: target.name, ...(result.failure ? { failure: result.failure } : {}) }] : [],
      exclusions: [],
      artifacts: [eventPath, ...(hasCaseArtifact && caseArtifact ? [relative(root, caseArtifact)] : [])],
      ...(status === "failed" && result?.failure?.message ? { detail: sanitize(result.failure.message) } : {}),
      ...(status === "blocked" ? { detail: !result
        ? `The pinned test runner did not emit the exact required test result: ${target.file} — ${target.name}`
        : "The required structured parity evidence artifact was not written for this acceptance run." } : {}),
    };
}

export function buildGateEvidenceCases({ verification, root, artifactDir, terminalCaptures = [] }) {
  return verification.gates.map((gate) => {
    const sourceLog = join(root, gate.logPath);
    let artifact = null;
    try {
      const logText = sanitize(readFileSync(sourceLog, "utf8"));
      const target = join(artifactDir, "gates", gate.id + ".log");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, logText);
      artifact = relative(root, target);
    } catch {}
    const networkPath = gate.script ? join(gateDirectory(artifactDir, gate.script), "network-violations.log") : null;
    return {
      id: "gate:" + gate.id,
      requirements: ["R16"],
      boundary: gate.id === "preflight" ? "installed-tool-preflight" : "release-verification-gate",
      status: gate.exitCode === 0 ? "passed" : "failed",
      required: true,
      startedAt: gate.startedAt,
      endedAt: gate.endedAt,
      attempts: gate.script === null ? 0 : 1,
      exclusions: [],
      artifacts: [
        ...(artifact ? [artifact] : []),
        ...(networkPath && existsSync(networkPath) ? [relative(root, networkPath)] : []),
        ...(gate.id === "pinned-pi-ui" ? terminalCaptures : []),
      ],
      detail: gate.logPath,
    };
  });
}

export function writeNodeTestEventsArtifact({ root, artifactDir, testEvents }) {
  const target = join(artifactDir, "gates", "node-test-events.jsonl");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, testEvents.map((event) => sanitize(JSON.stringify({
    ...event,
    file: event.file?.startsWith(root) ? relative(root, event.file) : event.file,
  }))).join("\n") + "\n");
  return target;
}

async function executeProfile(profile, context) {
  if (profile === "deterministic") return runDeterministic(context);
  const modulePath = PROFILE_FILES[profile];
  try {
    const { runProfile } = await import(modulePath);
    const result = await runProfile(context);
    if (!result || !Array.isArray(result.cases)) throw new Error("Profile did not return a cases array");
    return result.cases;
  } catch (error) {
    return [{
      id: profile + ":runner",
      requirements: [],
      boundary: profile + "-profile",
      status: "blocked",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: "Profile unavailable or failed: " + (error instanceof Error ? error.message : String(error)),
    }];
  }
}

function normalizeCases(cases, root) {
  const valid = new Set(["passed", "failed", "blocked", "missing", "deferred"]);
  return cases.map((item, index) => {
    const durationMs = Number.isFinite(item.durationMs)
      ? item.durationMs
      : item.startedAt && item.endedAt ? Date.parse(item.endedAt) - Date.parse(item.startedAt) : null;
    return {
      order: index + 1,
      id: String(item.id ?? "case-" + (index + 1)),
      requirements: Array.isArray(item.requirements) ? item.requirements : [],
      boundary: item.boundary ?? "unspecified",
      status: valid.has(item.status) ? item.status : "failed",
      required: item.required !== false,
      startedAt: item.startedAt ?? null,
      endedAt: item.endedAt ?? null,
      durationMs,
      attempts: item.attempts ?? 0,
      exclusions: Array.isArray(item.exclusions) ? item.exclusions : [],
      artifacts: Array.isArray(item.artifacts) ? item.artifacts.map((path) => path.startsWith(root) ? relative(root, path) : path) : [],
      ...(item.detail ? { detail: sanitize(String(item.detail)) } : {}),
    };
  });
}

export async function runAcceptance(argv = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n" + usage() + "\n");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = join(root, "screenshots", "acceptance", runId);
  mkdirSync(artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const before = {
    revision: git(root, ["rev-parse", "HEAD"]),
    sourceFingerprint: sourceFingerprint(root),
    dirtyPaths: gitTruth(root),
  };
  const toolVersions = installedToolVersions(root);
  let cases;
  const removeSignalHandlers = registerTerminationHandlers();
  try {
    cases = normalizeCases(await executeProfile(options.profile, { root, artifactDir, options }), root);
  } catch (error) {
    cases = normalizeCases([{
      id: options.profile + ":runner",
      requirements: [],
      boundary: options.profile + "-profile",
      status: "failed",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: error instanceof Error ? error.message : String(error),
    }], root);
  }
  const receivedRunSignal = removeSignalHandlers();
  const after = {
    revision: git(root, ["rev-parse", "HEAD"]),
    sourceFingerprint: sourceFingerprint(root),
    dirtyPaths: gitTruth(root),
  };
  const candidateChanged = before.revision !== after.revision || before.sourceFingerprint !== after.sourceFingerprint;
  const candidateDirty = before.dirtyPaths.length > 0 || after.dirtyPaths.length > 0;
  cases.push({
    order: cases.length + 1,
    id: "candidate-stable",
    requirements: ["R16"],
    boundary: "source-provenance",
    status: candidateChanged || candidateDirty ? "failed" : "passed",
    required: true,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: null,
    attempts: 1,
    exclusions: [],
    artifacts: [],
    ...(candidateChanged || candidateDirty ? { detail: "Source changed or the working tree was dirty; run again on a clean, frozen candidate." } : {}),
  });
  const summary = summarizeCases(cases);
  const evidence = {
    schemaVersion: 1,
    profile: options.profile,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: summary.exitCode,
    source: {
      revisionAtStart: before.revision,
      revisionAtEnd: after.revision,
      fingerprintAtStart: before.sourceFingerprint,
      fingerprintAtEnd: after.sourceFingerprint,
      dirtyPathsAtStart: before.dirtyPaths,
      dirtyPathsAtEnd: after.dirtyPaths,
      changedDuringRun: before.revision !== after.revision || before.sourceFingerprint !== after.sourceFingerprint,
    },
    toolVersions,
    options: options.profile === "live" ? {
      allowModels: options.allowModels,
      maxRequestsPerModel: options.maxRequestsPerModel,
      deadlineSeconds: options.deadlineSeconds,
      credentials: "Pi-managed; values not recorded",
    } : {},
    summary,
    cases,
  };
  const evidencePath = join(artifactDir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  let ciReportFailed = false;
  try {
    exportCiReportIfConfigured({ isMain: runtime.isMain === true, profile: options.profile, evidence, artifactDir });
  } catch (error) {
    ciReportFailed = true;
    process.stderr.write(`CI report export failed; acceptance evidence is preserved at ${relative(root, evidencePath)}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write("Acceptance " + options.profile + ": " + (summary.exitCode === 0 ? "passed" : "failed") +
    " (" + summary.passed + " passed, " + summary.failed + " failed, " + summary.blocked + " blocked)\n");
  process.stdout.write("Evidence: " + relative(root, join(artifactDir, "evidence.json")) + "\n");
  process.exitCode = receivedRunSignal ? signalExitCode(receivedRunSignal) : ciReportFailed ? 1 : summary.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAcceptance(process.argv.slice(2), { isMain: true });
}
