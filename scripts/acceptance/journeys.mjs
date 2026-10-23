import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { processGroupExists, terminateProcessGroup, verificationGateEnvironment } from "./core.mjs";

const journeys = [
  {
    id: "first-use-held-probe-auto-save",
    testFile: "tests/integration/auto-bootstrap-selection.test.mjs",
    title: "keeps the first turn usable during a held probe, then transfers the same save to Auto",
    requirements: ["R02", "R04", "R15"],
    boundary: "real Pi RPC with isolated fake provider",
    evidenceEvents: true,
  },
  {
    id: "first-use-save-failure-preserves-empty-config",
    testFile: "tests/integration/auto-bootstrap-selection.test.mjs",
    title: "keeps routing available and preserves the empty config when first-use probe save fails",
    requirements: ["R15"],
    boundary: "real Pi RPC with held local probes and an enforced POSIX read-only project config directory; UID 0 and filesystems that bypass mode bits are blocked",
    evidenceEvents: true,
    requiredEvidenceEvent: "bootstrap_save_failure_readonly",
  },
  {
    id: "verified-default-restart",
    testFile: "tests/integration/auto-virtual.test.mjs",
    title: "saves a nonempty verified default and routes from it after restart",
    requirements: ["R04", "R16"],
    boundary: "real Pi RPC and restarted real Pi process with isolated fake provider",
  },
  {
    id: "normal-init-successful-probes-save-membership",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "probes on ordinary init and saves only successful models",
    requirements: ["R15"],
    boundary: "real Pi init command with isolated fake providers and project files",
  },
  {
    id: "normal-init-reuses-cache-and-forced-init-refreshes",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "uses a complete recent probe cache on ordinary init and refreshes it on forced init",
    requirements: ["R15"],
    boundary: "real Pi init with cached and forced local provider probes; exact saved membership and SHA256 snapshots",
    evidenceEvents: true,
    evidenceEventsRequired: ["init_cached_results", "init_force_ignores_cache"],
  },
  {
    id: "forced-init-all-failed-no-write",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "leaves existing config untouched when forced probes have zero successes",
    requirements: ["R15"],
    boundary: "real Pi init -f command with isolated fake providers and exact config bytes",
  },
  {
    id: "forced-init-reconciles-generated-membership-preserves-manual",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "removes failed generated memberships, keeps handwritten entries and preserves settings",
    requirements: ["R15"],
    boundary: "real Pi /bifrost init -f command; exact saved config values and ownership reconciliation",
  },
  {
    id: "init-all-failed-cache-does-not-expand-to-registry",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "does not replace an all-failed fresh probe cache with the full registry",
    requirements: ["R15"],
    boundary: "real Pi init command, all-failed probe receipt, and exact no-write cache behavior",
  },
  {
    id: "new-project-inherits-private-global-settings-without-copying",
    testFile: "tests/integration/init-regression.test.mjs",
    title: "keeps inherited private and nondefault policy out of a new project config",
    requirements: ["R15"],
    boundary: "real Pi init and project config, followed by inherited config reload after global edit",
  },
  {
    id: "physical-402-pause-survives-restart-v1",
    testFile: "tests/integration/release-acceptance.test.mjs",
    title: "keeps a physical 402 provider pause across restart before v1 Auto routing",
    requirements: ["R08"],
    boundary: "real Pi process restart with persisted provider-scoped state; exact v1 Auto parameter variant",
  },
  {
    id: "physical-402-pause-survives-restart-v2",
    testFile: "tests/integration/release-acceptance.test.mjs",
    title: "keeps a physical 402 provider pause across restart before v2 Auto routing",
    requirements: ["R08"],
    boundary: "real Pi process restart with persisted provider-scoped state; exact v2 Auto parameter variant",
  },
  {
    id: "auto-zero-effect-recovery-v1",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "retries one zero-effect allowance failure with a configured alternate in v1 Auto",
    requirements: ["R03"],
    boundary: "real Pi v1 Auto path with fake provider 402 responses and synthetic empty-effect boundary",
  },
  {
    id: "auto-zero-effect-recovery-v2",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "retries one zero-effect allowance failure with a configured alternate in v2 Auto",
    requirements: ["R03"],
    boundary: "real Pi v2 Auto path with fake provider 402 responses and synthetic empty-effect boundary",
  },
  {
    id: "pi-owned-error-retry-no-bifrost-replay",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "reuses one v2 receipt and model across a Pi-owned error retry, without Bifrost replay",
    requirements: ["R03", "R08"],
    boundary: "real pinned Pi retry lifecycle with local fake provider and persisted reliability state",
  },
  {
    id: "manual-pin-session-control",
    testFile: "tests/integration/legacy-behavior.test.mjs",
    title: "pin locks the current model for the session (deliberately never persisted)",
    requirements: ["R02"],
    boundary: "real Pi command and session with local fake provider",
  },
  {
    id: "manual-model-selection-pins-session",
    testFile: "tests/integration/legacy-behavior.test.mjs",
    title: "manual Pi model selection pins the physical model in physical and Auto modes until explicit unpin",
    requirements: ["R02"],
    boundary: "real pinned-Pi RPC set_model event, explicit unpin command, and fake-provider generation evidence",
  },
  {
    id: "manual-off-disables-router",
    testFile: "tests/integration/legacy-behavior.test.mjs",
    title: "/bifrost off disables routing",
    requirements: ["R02"],
    boundary: "real Pi slash command and physical model route",
  },
  {
    id: "same-tier-auto-retention-and-prefix-strategy",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "retains the successful Auto model across native turns while prefixes use the random strategy",
    requirements: ["R02", "R11", "R17"],
    boundary: "real Pi Auto native turns plus configured prefix strategy and fake-provider request counts",
  },
  {
    id: "auto-allowance-recovery-opt-out-v1",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "does not retry an allowance failure when v1 Auto recovery is disabled",
    requirements: ["R03"],
    boundary: "real Pi v1 Auto turn with recovery explicitly disabled and no alternate dispatch",
  },
  {
    id: "auto-allowance-recovery-opt-out-v2",
    testFile: "tests/integration/reliability-v2-auto.test.mjs",
    title: "does not retry an allowance failure when v2 Auto recovery is disabled",
    requirements: ["R03"],
    boundary: "real Pi v2 Auto turn with recovery explicitly disabled and no alternate dispatch",
  },
  {
    id: "strict-boundary-blocks-generation",
    testFile: "tests/integration/legacy-behavior.test.mjs",
    title: "does not generate on the active physical model after an explicit boundary is exhausted",
    requirements: ["R05", "R06"],
    boundary: "real Pi physical route with local fake provider and zero-generation assertion",
  },
  {
    id: "strict-activation-failure-no-generation",
    testFile: "tests/integration/native-activation-cancel.test.mjs",
    title: "cancels real AgentSession activation behind a proven deny-all fence",
    requirements: ["R05", "R06"],
    boundary: "real Pi AgentSession with hard admission; false or thrown activation must leave the turn unsent and preserve the seed model",
  },
  {
    id: "malformed-project-config-blocks-startup",
    testFile: "tests/integration/config-startup-acceptance.test.mjs",
    title: "blocks generation when a project config source is malformed",
    requirements: ["R09"],
    boundary: "real Pi RPC/startup with malformed project config and zero-generation assertion",
  },
  {
    id: "higher-supported-config-masks-unsupported-lower-layer",
    testFile: "tests/integration/config-startup-acceptance.test.mjs",
    title: "blocks generation when a higher supported schema masks an unsupported lower layer",
    requirements: ["R09"],
    boundary: "real Pi startup with layered config files and zero-generation assertion",
  },
  {
    id: "reload-repairs-malformed-config",
    testFile: "tests/integration/config-startup-acceptance.test.mjs",
    title: "allows routing after reload repairs a malformed startup source",
    requirements: ["R09"],
    boundary: "real Pi RPC config reload from malformed startup source to valid saved route",
  },
  {
    id: "reviewed-config-schema-migration",
    testFile: "tests/integration/command-policy-acceptance.test.mjs",
    title: "previews and applies one reviewed schema migration with exact backup and layer isolation",
    requirements: ["R09"],
    boundary: "real Pi RPC previews one selected config source, validates the merged replacement, rejects stale digests, and checks exact private backup bytes",
  },
  {
    id: "last-good-strict-boundary-survives-invalid-reload",
    testFile: "tests/integration/legacy-behavior.test.mjs",
    title: "keeps the last-good strict boundary after a null project reload and blocks active-model generation",
    requirements: ["R06", "R09"],
    boundary: "real Pi invalid reload after strict policy activation; provider counters assert no physical fallback",
  },
  {
    id: "offline-preview-has-no-classifier-request",
    testFile: "tests/integration/preview-offline-acceptance.test.mjs",
    title: "does not call an enabled prompt classifier in offline mode and keeps ordinary preview classification",
    requirements: ["R07", "R12"],
    boundary: "real Pi commands and local request counters with outbound network guard",
  },
  {
    id: "offline-inspection-validation-auth-observability",
    testFile: "tests/integration/command-policy-acceptance.test.mjs",
    title: "runs inspect, validate, and a direct-rule preview offline without provider requests",
    requirements: ["R07"],
    boundary: "real Pi inspection and validation with observable auth, unresolved model references, and a local outbound-request guard",
  },
  {
    id: "classifier-timeout-visible-fallback",
    testFile: "tests/integration/command-policy-acceptance.test.mjs",
    title: "warns on prompt-classifier timeout, falls back locally, then generates on the physical model",
    requirements: ["R12"],
    boundary: "real Pi RPC, controlled local fake-provider deadline, visible notice and physical generation",
  },
  {
    id: "physical-and-auto-turn-identity",
    testFile: "tests/integration/dispatch-identity.test.mjs",
    title: "binds physical and Auto turn_end IDs to the exact persisted assistant entry",
    requirements: ["R02", "R03"],
    boundary: "real pinned Pi transport and synthetic provider registry",
  },
  {
    id: "auto-streamed-output-failure-no-replay",
    testFile: "tests/integration/auto-virtual.test.mjs",
    title: "does not replay a failed Auto turn after the provider emitted output",
    requirements: ["R03"],
    boundary: "real Pi Auto RPC with partial output followed by a native usage-limit SSE error and a same-tier distinct-provider control",
    evidenceEvents: true,
    requiredEvidenceEvent: "unsafe_output_no_replay",
  },
  {
    id: "auto-tool-side-effect-failure-no-replay",
    testFile: "tests/integration/auto-virtual.test.mjs",
    title: "does not replay an allowance failure after a synthetic tool side effect",
    requirements: ["R03"],
    boundary: "real Pi Auto RPC with opt-in v2 reliability, registered synthetic extension tool counter, and a distinct-provider backup",
    evidenceEvents: true,
    requiredEvidenceEvent: "unsafe_tool_no_replay",
  },
  {
    id: "auto-queued-followup-no-replay",
    testFile: "tests/integration/auto-virtual.test.mjs",
    title: "does not replay an unsafe tool turn and dispatches its queued follow-up once on a distinct provider",
    requirements: ["R03"],
    boundary: "real Pi RPC follow-up queue with held fake-provider generation gate and safe message digests",
    evidenceEvents: true,
    requiredEvidenceEvent: "queued_work_no_replay",
  },
  {
    id: "rpc-affinity-branch-lifecycle",
    testFile: "tests/integration/affinity-lifecycle-acceptance.test.mjs",
    title: "retains same-tier affinity, bypasses it for another tier, and drops it after an RPC fork",
    requirements: ["R11", "R16"],
    boundary: "real Pi RPC session, native branch fork, fake-provider request stats, and event-level affinity observer",
    evidenceEvents: true,
    requiredEvidenceEvent: "affinity_branch_lifecycle",
  },
  {
    id: "explicit-model-and-tool-continuation-affinity",
    testFile: "tests/integration/affinity-lifecycle-acceptance.test.mjs",
    title: "keeps exact model rules above affinity and protocol continuation on its dispatched model",
    requirements: ["R11"],
    boundary: "real Pi RPC exact-model rule, successful prior anchor, tool side effect, and same-model protocol continuation",
  },
  {
    id: "bootstrap-registry-price-order-matrix",
    testFile: "tests/integration/auto-bootstrap-selection.test.mjs",
    title: "keeps bootstrap pools stable across registry order, availability, and price metadata",
    requirements: ["R04", "R15", "R17"],
    boundary: "real Pi RPC, synthetic configured model list and isolated local fake provider; no upstream provider catalog discovery",
    evidenceEvents: true,
    requiredEvidenceEvent: "bootstrap_matrix_cold",
  },
  {
    id: "first-use-prefers-verified-sibling",
    testFile: "tests/integration/auto-bootstrap-selection.test.mjs",
    title: "routes the first prompt to an already verified sibling without replay",
    requirements: ["R03", "R04", "R05"],
    boundary: "real Pi RPC, held health probe and isolated fake-provider 403 response",
    evidenceEvents: true,
    requiredEvidenceEvent: "first_turn_verified_sibling",
  },
  {
    id: "agent-tui-first-use-progress-picker-shutdown",
    scriptFile: "scripts/ui-acceptance-first-use.sh",
    requirements: ["R04", "R16"],
    boundary: "real Pi terminal process through pinned agent-tui with isolated local fake provider",
    timeoutMs: 180_000,
    requiresTuiShutdownEvidence: true,
  },
];

function redact(text) {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, "[REDACTED]");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasNamedResult(output, title) {
  return output.split(/\r?\n/u).map((line) => line.trimStart()).some((line) => {
    const match = /^(?:ok|not ok) \d+ - (.*)$/u.exec(line);
    return match?.[1] === title;
  });
}

function hasNamedFailure(output, title) {
  return output.split(/\r?\n/u).map((line) => line.trimStart()).some((line) => {
    const match = /^not ok \d+ - (.*)$/u.exec(line);
    return match?.[1] === title;
  });
}

export function summarizeJourney({ exitCode, output, outputOverflow, title }) {
  if (outputOverflow) {
    return { status: "failed", detail: `Journey output exceeded its evidence limit: ${title}` };
  }
  if (!hasNamedResult(output, title)) {
    return { status: "blocked", detail: `Required Pi journey did not report a result: ${title}` };
  }
  if (hasNamedFailure(output, title)) {
    return { status: "failed", detail: `Pi journey failed: ${title}` };
  }
  if (exitCode !== 0) {
    return { status: "failed", detail: `Pi journey failed: ${title}` };
  }
  return { status: "passed" };
}

export function stripTuiControlSequences(text) {
  return stripVTControlCharacters(text);
}

export function summarizeTuiEvidence({ exitCode, output, outputOverflow, events }) {
  if (outputOverflow) return { status: "failed", detail: "TUI output exceeded its evidence limit." };
  if (exitCode !== 0 || !/ACCEPTANCE_TUI_PASS/u.test(output)) {
    return { status: "failed", detail: "The agent-tui journey did not emit its required completion marker." };
  }
  const shutdown = events.find((event) => event.event === "shutdown_cancelled_pending_probe");
  if (!shutdown) return { status: "blocked", detail: "The TUI journey passed without shutdown evidence." };
  if (shutdown.gracefulExitObserved !== true || shutdown.sessionAbsentFromActiveList !== true || shutdown.probeClientClosed !== true || shutdown.lateSave !== false
    || shutdown.staleUiCallbacks !== "not_observed_after_session_exit") {
    return { status: "failed", detail: "The TUI shutdown evidence did not match its observable guarantees." };
  }
  return { status: "passed" };
}

export function isSessionActiveInListing(listing, sessionId) {
  const sessions = Array.isArray(listing) ? listing : listing?.sessions;
  if (!Array.isArray(sessions)) throw new Error("agent-tui session listing has no sessions array");
  const matching = sessions.filter((session) => session && typeof session === "object"
    && (session.id === sessionId || session.session_id === sessionId));
  if (matching.some((session) => session.running === true || session.status === "active" || session.status === "running")) return true;
  if (matching.some((session) => session.running !== false
    && !["exited", "closed", "stopped"].includes(session.status))) {
    throw new Error("matching agent-tui session has no structured active/exited state");
  }
  return false;
}

function captureStream(limit) {
  const partLimit = Math.floor(limit / 2);
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      let remaining = Buffer.from(chunk);
      size += remaining.length;
      if (head.length < partLimit) {
        const count = Math.min(partLimit - head.length, remaining.length);
        head = Buffer.concat([head, remaining.subarray(0, count)]);
        remaining = remaining.subarray(count);
      }
      if (remaining.length) tail = Buffer.concat([tail, remaining]).subarray(-partLimit);
    },
    text() {
      return size > limit
        ? `${head.toString()}\n[stream output truncated]\n${tail.toString()}`
        : Buffer.concat([head, tail]).toString();
    },
    overflowed() { return size > limit; },
  };
}

export function runJourneyChild({ command, args, cwd, env, timeoutMs, signal, captureLimit = 256 * 1024 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stdout = captureStream(captureLimit);
    const stderr = captureStream(captureLimit);
    let timedOut = false;
    let interrupted = false;
    let finishing = false;
    let termination;
    const terminate = () => termination ??= terminateProcessGroup(child).catch(() => false);
    const stop = () => {
      interrupted = true;
      void terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    const finish = async (exitCode, errorText = "") => {
      if (finishing) return;
      finishing = true;
      if (!termination && process.platform !== "win32" && processGroupExists(child.pid)) terminate();
      const groupTerminated = termination ? await termination : true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      resolve({
        exitCode: !groupTerminated ? 1 : timedOut ? 124 : exitCode ?? 1,
        text: `${timedOut ? "Acceptance journey timed out.\n" : ""}${!groupTerminated ? "Acceptance process group cleanup failed.\n" : ""}${stdout.text()}${stderr.text()}${errorText}`,
        outputOverflow: stdout.overflowed() || stderr.overflowed(),
        interrupted,
        cleanupFailed: !groupTerminated,
      });
    };
    child.once("error", (error) => { void finish(127, error.message); });
    child.once("close", (exitCode) => { void finish(exitCode); });
  });
}

export async function runAcceptanceTest({ root, artifactDir, journey }) {
  const caseDir = join(artifactDir, "cases", journey.id);
  mkdirSync(caseDir, { recursive: true });
  const eventPath = journey.evidenceEvents ? join(caseDir, "observations.jsonl") : undefined;
  const startedAt = new Date().toISOString();
  const command = journey.scriptFile ? "bash" : process.execPath;
  const args = journey.scriptFile
    ? [journey.scriptFile]
    : ["--test", "--experimental-strip-types", "--test-reporter=tap", `--test-name-pattern=${escapeRegExp(journey.title)}`, journey.testFile];
  const abort = new AbortController();
  const gate = verificationGateEnvironment({ root, artifactDir: caseDir, script: `journey-${journey.id}` });
  let interruptedBy;
  const interrupt = (signalName) => {
    interruptedBy = signalName;
    abort.abort(signalName);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let output;
  try {
    output = await runJourneyChild({
      command,
      args,
      cwd: root,
      env: { ...gate.env, BIFROST_ACCEPTANCE_ARTIFACT_DIR: caseDir, ...(eventPath ? { BIFROST_ACCEPTANCE_EVENTS: eventPath } : {}) },
      timeoutMs: journey.timeoutMs ?? 300_000,
      signal: abort.signal,
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  const safeOutput = redact(output.text);
  const logPath = join(caseDir, "journey.tap.txt");
  writeFileSync(logPath, safeOutput);
  let result = journey.scriptFile
    ? { status: output.exitCode === 0 && !output.outputOverflow && /ACCEPTANCE_TUI_PASS/u.test(safeOutput) ? "passed" : "failed",
      ...(output.exitCode === 0 && !output.outputOverflow && /ACCEPTANCE_TUI_PASS/u.test(safeOutput) ? {} : { detail: "The TUI journey failed or exceeded its evidence limit." }) }
    : summarizeJourney({ ...output, output: safeOutput, title: journey.title });
  if (output.cleanupFailed) result = { status: "failed", detail: "The acceptance process group did not terminate cleanly." };
  const events = eventPath && existsSync(eventPath)
    ? readFileSync(eventPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const gapEvent = events.find((event) => event.event === journey.requiredEvidenceEvent && event.outcome === "observed_product_gap");
  if (gapEvent) {
    result = { status: "failed", detail: `OBSERVED_PRODUCT_GAP: queued follow-up was acknowledged but not dispatched before ${gapEvent.failureCode}.` };
  }
  const tuiEventPath = journey.scriptFile ? join(caseDir, "tui-first-use.jsonl") : undefined;
  const tuiEvents = tuiEventPath && existsSync(tuiEventPath)
    ? readFileSync(tuiEventPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  if (journey.requiresTuiShutdownEvidence) result = summarizeTuiEvidence({ exitCode: output.exitCode, output: safeOutput, outputOverflow: output.outputOverflow, events: tuiEvents });
  const networkViolations = readFileSync(gate.violationPath, "utf8");
  if (networkViolations.length) {
    result = { status: "failed", detail: "The journey attempted outbound network access outside loopback." };
  }
  const requiredEvents = journey.evidenceEventsRequired ?? (journey.evidenceEvents ? [journey.requiredEvidenceEvent ?? "first_turn_while_probe_pending"] : []);
  const missingEvents = requiredEvents.filter((eventName) => !events.some((event) => event.event === eventName));
  if (missingEvents.length && result.status === "passed") {
    result.status = "blocked";
    result.detail = `The Pi journey passed without required evidence event(s): ${missingEvents.join(", ")}.`;
  }
  const endedAt = new Date().toISOString();
  const row = {
    id: journey.id,
    requirements: journey.requirements,
    boundary: journey.boundary,
    status: result.status,
    startedAt,
    endedAt,
    attempts: [
      ...namedAttempt(safeOutput, journey.title),
      ...events.filter((event) => event.event === "request_counts" || requiredEvents.includes(event.event) || event.event === journey.requiredEvidenceEvent),
      ...tuiEvents.filter((event) => event.event === "request_counts"),
    ],
    exclusions: ["Live providers and real credentials are excluded; Pi uses the integration fixture's local fake provider."],
    artifacts: [logPath, gate.violationPath, ...(eventPath && existsSync(eventPath) ? [eventPath] : []), ...(tuiEventPath && existsSync(tuiEventPath) ? [tuiEventPath] : []),
      ...(journey.scriptFile && existsSync(join(caseDir, "captures")) ? readdirSync(join(caseDir, "captures"), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(caseDir, "captures", entry.name)) : [])].filter(existsSync),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(interruptedBy ? { interruptedBy } : {}),
  };
  writeFileSync(join(caseDir, "result.jsonl"), `${JSON.stringify(row)}\n`);
  return row;
}

function namedAttempt(output, title) {
  return output.split(/\r?\n/u).map((value) => value.trimStart())
    .filter((line) => /^(?:ok|not ok) \d+ - /u.test(line) && line.includes(` - ${title}`))
    .map((line) => {
      const match = /^(ok|not ok) (\d+) - (.*)$/u.exec(line);
      return { kind: "node-test", number: Number(match[2]), testName: match[3], result: match[1] === "ok" ? "passed" : "failed" };
    });
}

export async function runJourneys({ root, artifactDir, options = {} }) {
  const cases = [];
  for (let index = 0; index < journeys.length; index++) {
    const journey = journeys[index];
    if (options.shouldStop?.()) {
      for (const pending of journeys.slice(index)) {
        cases.push({ id: pending.id, requirements: pending.requirements, boundary: pending.boundary, status: "blocked", required: true,
          attempts: [], exclusions: [], artifacts: [], detail: "Not run after the acceptance runner received an interrupt." });
      }
      return { cases };
    }
    const result = await runAcceptanceTest({ root, artifactDir, journey });
    cases.push(result);
    if (result.interruptedBy) {
      for (const pending of journeys.slice(index + 1)) {
        cases.push({ id: pending.id, requirements: pending.requirements, boundary: pending.boundary, status: "blocked", required: true,
          attempts: [], exclusions: [], artifacts: [], detail: `Not run after journey runner received ${result.interruptedBy}.` });
      }
      return { cases };
    }
  }
  return { cases };
}
