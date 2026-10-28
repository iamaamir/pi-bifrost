// G09 (P2) — Commands and artifact privacy matrix.
//
// This suite seeds synthetic prompt, secret, endpoint, and error canaries and
// inspects local debug, metrics, reliability, runtime, cache, and probe artifacts
// against explicit schemas. The cache intentionally retains normalized prompt
// text and is sensitive local user data, not a content-free diagnostic artifact.
// The suite also checks classifier trace gates, opt-out persistence, aborts, and
// classifier test/benchmark command artifacts.
//
// Boundary: real pinned Pi processes (RPC) against the local fake provider.
// No live provider calls. The outbound guard proves no non-fixture network
// request. Every spawned process is the leader of a process group owned by
// this module; scratch is reclaimed only after each owned group is observed
// dead (see scenario/releaseScratch).
//
// The final case is a controlled fault proof: it mutates only the debug prompt
// projection in a private scratch copy of the tree and confirms the named
// redaction assertion turns RED, then proves the committed index.ts is
// unchanged. The production index.ts hash is never modified.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";
import { startFakeProviderServer } from "../fixtures/http-pi-harness.mjs";
import { REPLAY_GUARD_BASELINE_SHA256 } from "../fixtures/replay-fault-control.mjs";
import { reliabilityV2Config } from "../../runtime-reliability-v2.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

/** Production index.ts hash that the fault proof must leave byte-identical. */
const PRODUCTION_INDEX_SHA256 = REPLAY_GUARD_BASELINE_SHA256;

// ── synthetic canaries ──────────────────────────────────────────
// Distinct shapes so a leak is unambiguous, and words that survive cache
// normalization are separated so the normalized-cache contract can be checked.
const PROMPT_CANARY = "CANARY_PROMPT_alpaca_7f3d";
const SECRET_CANARY = "sk-CANARY_SECRET_9b2e";
const ENDPOINT_CANARY = "CANARY_ENDPOINT_4c1a";
const ERROR_CANARY = "CANARY_ERROR_5d8f";
const CANARIES = [PROMPT_CANARY, SECRET_CANARY, ENDPOINT_CANARY, ERROR_CANARY];
const CANARY_PROMPT = `${PROMPT_CANARY} implement a small routing helper and mention ${ERROR_CANARY}`;

/** Original-casing tokens that must never be written verbatim into any artifact. */
const RAW_LEAK_MARKERS = [...CANARIES];

// ── explicit debug-trace allowlist ──────────────────────────────
// Every top-level key a routing/measure debug record may carry in the
// prompt-backend witness below (case 1). A new field must be added here
// deliberately after a privacy review; an unexpected key fails the allowlist
// assertion. This set is deliberately not a claim about the other Bifrost
// subsystems: the pi-native and TypeSafe detailed traces are governed by their
// own declared per-backend sets below, and the route `decision` payload is the
// one structured nested value, checked against its recursive exact schema below.
const DEBUG_KEY_ALLOWLIST = new Set([
  "ts", "module", "event", "entryType", "duration_ms", "_meta_error",
  "run_correlation_id", "session_correlation_id", "turn_correlation_id",
  "pattern_run_id", "subagent_run_id",
  "extensionDir", "processId", "runtimeVersion", "routingMode", "reliabilityMode",
  "enabled", "pinned", "classifierEnabled", "reliabilityStateVersion",
  "routingEnabled", "budget_scope", "reason", "scope", "target", "action",
  "allowed", "claimed", "generation", "depth", "origin", "modelCount",
  "evidence", "issueCount", "exitCode", "stderrPresent", "streamingBehavior",
  "length", "outcome", "match", "hit", "entries", "model", "outputChars",
  "outputPresent", "provider", "status", "transport", "tier", "tiers",
  "trace_id", "runId", "kind", "source", "strategy", "skipped", "cacheHit",
  "classifierBackend", "classifierModel", "thinkingLevel", "fallback",
  "fallbackReason", "selectedTier", "decision", "request_correlation_id",
  "backend", "attribution", "category", "pool", "errorCategory", "agent",
  "command", "resultCount", "failedModels",
]);

// A sensitive channel is any key whose value could carry raw user/provider
// text. None may ever appear in the trace, even inside `decision`.
const SENSITIVE_KEYS = new Set([
  "prompt", "prompts", "message", "messages", "content", "response",
  "responseBody", "request", "requestBody", "body", "apiKey", "api_key",
  "authorization", "secret", "credentials", "endpoint", "url", "error",
  "errorText", "errorMessage", "stack", "criteria", "systemPrompt",
]);

// ── declared per-backend detailed-trace key sets ────────────────
// The pi-native and TypeSafe classifiers emit their own debug rows when their
// gate is open. Each row must stay inside that backend's declared set; these are
// the union of every field the backend's trace() calls can emit plus the shared
// debug() base fields. Adding a field to a backend trace is therefore a
// deliberate, reviewable change to this list. `endpoint` is the pinned
// TypeSafe service URL addressed by the gated `request` row; that row is only
// reachable once a credential exists, so it is declared here rather than
// exercised by the missing-credential witness.
const DEBUG_BASE_KEYS = ["ts", "module", "event", "entryType", "pattern_run_id", "subagent_run_id", "_meta_error"];
const PI_NATIVE_TRACE_KEYS = new Set([
  ...DEBUG_BASE_KEYS,
  "trace_id", "model", "tiers", "prompt_length", "timeout_ms", "max_attempts",
  "outcome", "attempts", "tier", "confidence", "elapsed_ms", "cause", "provider",
  "attempt", "remaining_ms", "valid", "min_confidence", "stop_reason", "retryable",
]);
const TYPESAFE_TRACE_KEYS = new Set([
  ...DEBUG_BASE_KEYS,
  "trace_id", "model", "tiers", "prompt_length", "timeout_ms", "max_attempts",
  "outcome", "attempts", "tier", "confidence", "elapsed_ms", "attempt",
  "remaining_ms", "endpoint", "status", "ok", "valid", "min_confidence",
  "retryable", "delay_ms", "category",
]);

/**
 * Named per-backend trace contract. The backend's rows must be present (a silent
 * non-emission is a failure, not a pass), must identify their backend, must
 * include the opening `start` row, and must stay inside the declared key set.
 * Key sets do not constrain values, so callers keep their sensitive-string and
 * canary checks as well.
 */
function assertBackendTraceContract(rows, backend, declared) {
  const own = rows.filter((row) => row.module === backend);
  assert.ok(own.length > 0, `${backend} trace must emit at least one row when its gate is open`);
  assert.ok(own.every((row) => row.module === backend), `${backend} trace rows must identify their backend`);
  assert.ok(own.some((row) => row.event === "start"), `${backend} trace must include its opening start row`);
  for (const row of own) {
    for (const key of Object.keys(row)) {
      assert.equal(declared.has(key), true, `${backend} trace key outside declared backend set: ${key} (${row.event})`);
    }
  }
  return own;
}

let server;

// ── fake provider ───────────────────────────────────────────────
// Sole owner: tests/fixtures/http-pi-harness.mjs. Ownership is cancellation-
// safe because the provider stays in this worker's process group.

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function attemptDelta(before, after, model) {
  return (after.attempts[model] ?? 0) - (before.attempts[model] ?? 0);
}

// ── fixture ─────────────────────────────────────────────────────

const FIXTURE_MODELS = ["chat", "classifier", "fail", "probe-slow", "probe-fast"];

function fixture({ config, models = FIXTURE_MODELS, extension = EXTENSION, apiKey = SECRET_CANARY } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-privacy-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-privacy-work-"));
  const agent = join(home, ".pi", "agent");
  const project = join(work, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, "network-violations.log"), "");
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey,
        models: models.map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
      },
    },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config));
  return { home, work, project, agent, extension };
}

function piEnvironment(home, extension) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    BIFROST_TEST_EXTENSION_PATH: extension,
  };
}

// ── owned RPC session ───────────────────────────────────────────

function startRpc({ home, work, extension = EXTENSION, model = "fake/chat" }) {
  const child = spawn(PI, ["-e", extension, "--mode", "rpc", "--no-session", "--no-tools", "--model", model], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home, extension),
    detached: true,
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closePromise;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { /* malformed output remains a protocol assertion failure */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => { clearTimeout(timer); if (wake === finish) wake = undefined; resolve(); };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message, timeoutMs = 30_000) {
    const id = `privacy-${records.length}-${Date.now()}`;
    const startIndex = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart), startIndex };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  async function userTurn(message, timeoutMs = 30_000) {
    const accepted = await prompt(message, timeoutMs);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + timeoutMs;
    let index = accepted.startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "agent_settled") return accepted;
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}`);
  }

  function close(home) {
    closePromise ??= (async () => {
      try { child.stdin.end(); } catch {}
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        const terminated = await terminateProcessGroup(child, { graceMs: 1_000, cleanupTimeoutMs: 2_000 });
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.unref(); } catch {}
        if (!terminated) return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid) };
      }
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
      return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid), code: closeInfo?.code, signal: closeInfo?.signal };
    })();
    return closePromise.then((result) => {
      let violations;
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error("network-violations log is missing");
        throw error;
      }
      if (/blocked|network.?violation|violation/i.test(stderr)) {
        throw new Error(`blocked request observed in captured stderr: ${stderr.trim()}`);
      }
      return { ...result, violations };
    });
  }

  return { prompt, userTurn, close };
}

/** Owns scratch removal; reclaims only after every owned group is observed dead. */
async function releaseScratch(env, sessions) {
  const failures = [];
  const receipts = [];
  for (const session of sessions) {
    if (!session) continue;
    let receipt;
    try { receipt = await session.close(env.home); }
    catch (error) { failures.push(error); continue; }
    receipts.push(receipt);
    if (!receipt.closed) failures.push(new Error("owned RPC session did not close"));
    if (!receipt.groupGone) failures.push(new Error("owned RPC process group still present"));
    if (receipt.violations !== "") failures.push(new Error(`network violations observed: ${receipt.violations}`));
  }
  if (failures.length > 0) return { removed: false, failures, receipts, retained: [env.home, env.work] };
  rmSync(env.home, { recursive: true, force: true });
  rmSync(env.work, { recursive: true, force: true });
  return { removed: !existsSync(env.home) && !existsSync(env.work), failures, receipts, retained: [] };
}

async function scenario(run) {
  const env = fixture(run.fixtureOptions ?? {});
  const sessions = [];
  let bodyError;
  try { await run.body({ env, sessions }); }
  catch (error) { bodyError = error; }
  const released = await releaseScratch(env, sessions);
  if (!released.removed || released.failures.length > 0) {
    const cleanup = new Error(`privacy scratch retained at ${released.retained.join(", ")}: ${released.failures.map((f) => f.message).join("; ")}`);
    // Carry the owned receipts so a caller can distinguish observed-safe cleanup
    // from an uncertain report and retain its own private copy instead of
    // deleting it while an owned run may still be live.
    cleanup.released = released;
    if (bodyError) cleanup.cause = bodyError;
    throw cleanup;
  }
  if (bodyError) { bodyError.released = released; throw bodyError; }
  return released;
}

/**
 * True only when every owned run was observed closed with its process group
 * absent and no ownership failure was recorded. A missing or partial receipt is
 * never treated as observed-safe.
 */
function ownedCleanupObserved(released) {
  return Boolean(released)
    && released.removed === true
    && released.failures.length === 0
    && released.receipts.length > 0
    && released.receipts.every((receipt) => receipt.closed === true && receipt.groupGone === true);
}

/**
 * A source-copy owner reclaims its private extension copy only after every owned
 * run is observed closed with its group absent. On uncertain cleanup it retains
 * the exact path — a still-live run may import it and the proof needs its source
 * evidence — and returns false so the caller surfaces the original cleanup error
 * rather than an expected-assert mismatch.
 */
function reclaimSourceCopy(scratch, released) {
  if (ownedCleanupObserved(released)) {
    rmSync(scratch, { recursive: true, force: true });
    return true;
  }
  console.error(`G09 retained private source copy at ${scratch} after uncertain cleanup`);
  return false;
}

// Share the guarded operation with the regression so bypassing it is observable.
function reclaimControlArtifacts(scratch, released, receipt) {
  const actualSafety = receipt
    ? { removed: true, failures: [], receipts: [receipt], retained: [] }
    : undefined;
  if (!ownedCleanupObserved(actualSafety)) return false;
  for (const path of released?.retained ?? []) rmSync(path, { recursive: true, force: true });
  return reclaimSourceCopy(scratch, actualSafety);
}

// ── artifact helpers ────────────────────────────────────────────

function artifact(project, name) {
  const path = join(project, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function assertNoCanaries(text, label) {
  assert.equal(typeof text, "string", `${label}: artifact must exist`);
  for (const marker of RAW_LEAK_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} must not contain canary ${marker}`);
  }
}

function debugRows(project) {
  const raw = artifact(project, "bifrost-debug.jsonl");
  if (raw === undefined) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertDebugDecisionRows(raw) {
  const rows = debugRowsFrom(raw).filter((row) => row.event === "route_decision" && row.decision !== undefined);
  assert.ok(rows.length > 0, "debug trace must contain a route-decision summary");
  for (const row of rows) assertRouteDecisionSummary(row.decision, `${row.module}/${row.event}.decision`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Sensitive keys carrying raw text. A key like probe's numeric `error` count is
 * permitted; a non-empty string under a sensitive key is a leak.
 */
function sensitiveStringKeys(row) {
  return Object.keys(row).filter((key) => SENSITIVE_KEYS.has(key) && typeof row[key] === "string" && row[key].length > 0);
}

/** Mirrors cache.ts normalize: lowercased, punctuation-flattened, ordered tokens. */
function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean).join(" ");
}

// ── declared persistence key sets (reliability sidecars) ────────
// Bifrost writes three independent reliability sidecars. Every object either can
// persist has a declared key set and validated values, so text-carrying fields
// cannot hide behind a keys-only check. These sets derive from v1, provider and
// v2 state implementations and must change deliberately with them.

const RELIABILITY_ARTIFACT_KEYS = ["models", "version"];
const RELIABILITY_RECORD_KEYS = new Set([
  "failures", "openUntil", "trialActive", "cooldownMultiplier", "lastFailureAt",
  "lastFailureSource", "lastFailureReason", "lastSuccessAt", "lastSuccessSource",
]);
const PROVIDER_ARTIFACT_KEYS = ["dispatches", "revision", "scopes", "settledOutcomes", "version"];
const PROVIDER_SCOPE_KEYS = new Set(["generation", "failures", "openUntil", "cooldownMultiplier", "lease"]);
const PROVIDER_LEASE_KEYS = new Set(["ownerToken", "dispatchId", "outcomeId", "leaseId", "generation", "expiresAt", "maxExpiresAt"]);
const PROVIDER_DISPATCH_KEYS = new Set(["ownerToken", "dispatchId", "outcomeId", "admittedAt", "proofUntil", "scopes", "settledAt", "settledKind"]);
const PROVIDER_SCOPE_RECEIPT_KEYS = new Set(["scopeKey", "modelKey", "generation", "leaseId", "expiresAt", "maxExpiresAt"]);
const PROVIDER_OUTCOME_KEYS = new Set(["expiresAt", "observation"]);
const PROVIDER_OBSERVATION_KEYS = new Set(["modelKey", "category", "categoryEvidence", "observedAt", "retryAt", "source"]);

function assertDeclaredKeys(record, declared, label) {
  const allowed = declared instanceof Set ? declared : new Set(declared);
  for (const key of Object.keys(record)) {
    assert.equal(allowed.has(key), true, `${label}: key outside declared set: ${key}`);
  }
}

/** Every string value in a parsed artifact, recursively. */
function stringValues(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringValues(item, found);
  return found;
}

function assertNoCanaryValues(value, label) {
  const values = stringValues(value);
  const keys = [];
  const collectKeys = (item) => {
    if (Array.isArray(item)) for (const child of item) collectKeys(child);
    else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) { keys.push(key); collectKeys(child); }
    }
  };
  collectKeys(value);
  for (const marker of RAW_LEAK_MARKERS) {
    assert.equal(values.some((text) => text.includes(marker)) || keys.some((key) => key.includes(marker)), false,
      `${label} must not carry canary ${marker} in a string value or key`);
  }
}

function assertExactKeys(record, required, optional = [], label) {
  assert.ok(record && typeof record === "object" && !Array.isArray(record), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert.equal(Object.hasOwn(record, key), true, `${label}: missing key ${key}`);
  for (const key of Object.keys(record)) assert.equal(allowed.has(key), true, `${label}: unexpected key ${key}`);
}

const V2_STATE_KEYS = ["version", "revision", "scopes", "dispatches", "settledOutcomes"];
const V2_SCOPE_KEYS = ["generation", "failures"];
const V2_SCOPE_OPTIONAL_KEYS = ["openUntil", "cooldownMultiplier", "lease"];
const V2_LEASE_KEYS = ["ownerToken", "dispatchId", "outcomeId", "leaseId", "generation", "expiresAt", "maxExpiresAt"];
const V2_DISPATCH_KEYS = ["ownerToken", "dispatchId", "outcomeId", "admittedAt", "proofUntil", "scopes"];
const V2_DISPATCH_OPTIONAL_KEYS = ["settledAt", "settledKind"];
const V2_SCOPE_RECEIPT_KEYS = ["scopeKey", "modelKey", "generation"];
const V2_SCOPE_RECEIPT_OPTIONAL_KEYS = ["leaseId", "expiresAt", "maxExpiresAt"];
const V2_OUTCOME_KEYS = ["expiresAt"];
const V2_OUTCOME_OPTIONAL_KEYS = ["observation"];
const V2_OBSERVATION_KEYS = ["modelKey", "category", "categoryEvidence", "observedAt", "source"];
const V2_OBSERVATION_OPTIONAL_KEYS = ["retryAt"];
const V2_CATEGORIES = new Set(["rate_limit", "allowance_exhausted", "authentication", "billing_denied", "overload", "transport", "model_unavailable", "invalid_request", "capability_mismatch", "context_limit", "tool_protocol", "activation_failed", "unknown"]);
const V2_CATEGORY_EVIDENCE = new Set(["structured", "http_status", "text_heuristic", "unknown"]);

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  for (const [index, entry] of value.entries()) assertBoundedString(entry, `${label}[${index}]`);
}

function assertDecisionPool(pool, label) {
  assertExactKeys(pool, ["tier", "strategy", "patterns", "candidates"], ["billingPreference", "unresolvedPatterns"], label);
  assertBoundedString(pool.tier, `${label}.tier`);
  assertBoundedString(pool.strategy, `${label}.strategy`);
  assertStringArray(pool.patterns, `${label}.patterns`);
  assert.ok(Array.isArray(pool.candidates), `${label}.candidates must be an array`);
  for (const [index, candidate] of pool.candidates.entries()) {
    const path = `${label}.candidates[${index}]`;
    assertExactKeys(candidate, ["model", "status"], ["exclusion", "exclusionEvidence", "reserve"], path);
    assertBoundedString(candidate.model, `${path}.model`);
    assert.ok(["eligible", "excluded"].includes(candidate.status));
    if (candidate.exclusion !== undefined) assertBoundedString(candidate.exclusion, `${path}.exclusion`);
    if (candidate.exclusionEvidence !== undefined) {
      assert.ok(Array.isArray(candidate.exclusionEvidence));
      for (const [evidenceIndex, evidence] of candidate.exclusionEvidence.entries()) {
        assertExactKeys(evidence, ["code", "source"], [], `${path}.exclusionEvidence[${evidenceIndex}]`);
        assertBoundedString(evidence.code, `${path}.exclusionEvidence[${evidenceIndex}].code`);
        assertBoundedString(evidence.source, `${path}.exclusionEvidence[${evidenceIndex}].source`);
      }
    }
    if (candidate.reserve !== undefined) {
      assertExactKeys(candidate.reserve, ["disposition", "wouldReject", "reasons"], [], `${path}.reserve`);
      assertBoundedString(candidate.reserve.disposition, `${path}.reserve.disposition`);
      assert.equal(typeof candidate.reserve.wouldReject, "boolean");
      assertStringArray(candidate.reserve.reasons, `${path}.reserve.reasons`);
    }
  }
  if (pool.unresolvedPatterns !== undefined) {
    assert.ok(Array.isArray(pool.unresolvedPatterns));
    for (const [index, entry] of pool.unresolvedPatterns.entries()) {
      const path = `${label}.unresolvedPatterns[${index}]`;
      assertExactKeys(entry, ["pattern", "exclusion", "exclusionEvidence"], [], path);
      assertBoundedString(entry.pattern, `${path}.pattern`);
      assert.ok(["model_unavailable", "pattern_unavailable"].includes(entry.exclusion));
      assert.ok(Array.isArray(entry.exclusionEvidence) && entry.exclusionEvidence.length > 0);
      for (const [evidenceIndex, evidence] of entry.exclusionEvidence.entries()) {
        assertExactKeys(evidence, ["code", "source"], [], `${path}.exclusionEvidence[${evidenceIndex}]`);
        assert.equal(evidence.code, entry.exclusion);
        assert.equal(evidence.source, "registry_snapshot");
      }
    }
  }
  if (pool.billingPreference !== undefined) {
    const pref = pool.billingPreference;
    assertExactKeys(pref, ["mode", "preferredClass", "eligibleCount", "preferredCount", "selectionCount", "candidates"], [], `${label}.billingPreference`);
    for (const key of ["mode", "preferredClass"]) assertBoundedString(pref[key], `${label}.billingPreference.${key}`);
    for (const key of ["eligibleCount", "preferredCount", "selectionCount"]) assert.ok(Number.isSafeInteger(pref[key]) && pref[key] >= 0);
    assert.ok(Array.isArray(pref.candidates));
    for (const [index, trace] of pref.candidates.entries()) {
      const tracePath = `${label}.billingPreference.candidates[${index}]`;
      assertExactKeys(trace, ["model", "billingClass", "sourceAliases", "authorities", "freshness", "effect"], [], tracePath);
      for (const key of ["model", "billingClass", "freshness", "effect"]) assertBoundedString(trace[key], `${tracePath}.${key}`);
      assertStringArray(trace.sourceAliases, `${tracePath}.sourceAliases`);
      assertStringArray(trace.authorities, `${tracePath}.authorities`);
    }
  }
}

function assertRouteDecisionSummary(decision, label = "decision") {
  assertExactKeys(decision, ["version", "kind", "outcome", "classification"], ["error", "requested", "fallback", "attempted", "explicitBoundary", "selectedTier", "selected", "selectedStrategy", "fallbackReason", "classificationOutcome", "classifierAttempt", "affinity"], label);
  assert.equal(decision.version, 1);
  assert.equal(decision.kind, "route-decision");
  assert.ok(["selected", "unresolved", "unclassified", "usage", "config_invalid"].includes(decision.outcome));
  if (decision.error !== undefined) assert.ok(["usage", "config_invalid"].includes(decision.error));
  const classification = decision.classification;
  assertExactKeys(classification, ["source"], ["tier", "classifier"], `${label}.classification`);
  assert.ok(["cache", "classifier", "regex", "inline", "fallback", "unclassified"].includes(classification.source));
  if (classification.tier !== undefined) assertBoundedString(classification.tier, `${label}.classification.tier`);
  if (classification.classifier !== undefined) {
    assertExactKeys(classification.classifier, ["backend"], ["model", "confidence"], `${label}.classification.classifier`);
    assertBoundedString(classification.classifier.backend, `${label}.classification.classifier.backend`);
    if (classification.classifier.model !== undefined) assertBoundedString(classification.classifier.model, `${label}.classification.classifier.model`);
    if (classification.classifier.confidence !== undefined) assert.ok(Number.isFinite(classification.classifier.confidence));
  }
  for (const key of ["requested", "fallback"]) if (decision[key] !== undefined) assertDecisionPool(decision[key], `${label}.${key}`);
  if (decision.attempted !== undefined) {
    assert.ok(Array.isArray(decision.attempted));
    for (const [index, pool] of decision.attempted.entries()) assertDecisionPool(pool, `${label}.attempted[${index}]`);
  }
  if (decision.explicitBoundary !== undefined) assert.equal(typeof decision.explicitBoundary, "boolean");
  for (const key of ["selectedTier", "selected", "selectedStrategy", "fallbackReason"]) if (decision[key] !== undefined) assertBoundedString(decision[key], `${label}.${key}`);
  if (decision.classificationOutcome !== undefined) assert.ok(["deadline", "aborted"].includes(decision.classificationOutcome));
  if (decision.classifierAttempt !== undefined) {
    const attempt = decision.classifierAttempt;
    assertExactKeys(attempt, ["backend", "outcome", "fallbackKind"], ["model", "circuitOpenUntil", "fallbackModel"], `${label}.classifierAttempt`);
    for (const key of ["backend", "outcome", "fallbackKind"]) assertBoundedString(attempt[key], `${label}.classifierAttempt.${key}`);
    for (const key of ["model", "fallbackModel"]) if (attempt[key] !== undefined) assertBoundedString(attempt[key], `${label}.classifierAttempt.${key}`);
    if (attempt.circuitOpenUntil !== undefined) assertTimestamp(attempt.circuitOpenUntil, `${label}.classifierAttempt.circuitOpenUntil`);
  }
  if (decision.affinity !== undefined) {
    const affinity = decision.affinity;
    assertExactKeys(affinity, ["version", "status", "snapshotAsOf", "mode", "selection"], ["modeSource", "anchor", "baseStrategyWinner", "baseStrategyComparison", "sameProviderCandidateAvailable", "strategyWinner", "selectedModel", "selectedTier"], `${label}.affinity`);
    assert.equal(affinity.version, 1);
    for (const key of ["status", "mode", "selection"]) assertBoundedString(affinity[key], `${label}.affinity.${key}`);
    assertTimestamp(affinity.snapshotAsOf, `${label}.affinity.snapshotAsOf`);
    for (const key of ["modeSource", "baseStrategyWinner", "baseStrategyComparison", "strategyWinner", "selectedModel", "selectedTier"]) if (affinity[key] !== undefined) assertBoundedString(affinity[key], `${label}.affinity.${key}`);
    if (affinity.sameProviderCandidateAvailable !== undefined) assert.equal(typeof affinity.sameProviderCandidateAvailable, "boolean");
    if (affinity.anchor !== undefined) {
      assertExactKeys(affinity.anchor, ["modelKey", "provider", "lastSuccessfulDispatchAt", "ageMs"], [], `${label}.affinity.anchor`);
      assertBoundedString(affinity.anchor.modelKey, `${label}.affinity.anchor.modelKey`);
      assertBoundedString(affinity.anchor.provider, `${label}.affinity.anchor.provider`);
      assertTimestamp(affinity.anchor.lastSuccessfulDispatchAt, `${label}.affinity.anchor.lastSuccessfulDispatchAt`);
      assert.ok(Number.isFinite(affinity.anchor.ageMs) && affinity.anchor.ageMs >= 0);
    }
  }
  assertNoCanaryValues(decision, label);
}

function assertBoundedString(value, label, maxLength = 256) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0 && value.length <= maxLength, `${label} must be nonempty and bounded`);
  assert.doesNotMatch(value, /[\x00-\x1f\x7f]/u, `${label} must not contain control characters`);
}

function assertTimestamp(value, label) {
  assert.equal(Number.isSafeInteger(value), true, `${label} must be a safe integer timestamp`);
  assert.ok(value >= 0 && value <= 8_640_000_000_000_000, `${label} must be within the supported epoch range`);
}

const V2_MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*\/[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/u;
const V2_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function assertV2ModelKey(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, V2_MODEL_KEY, `${label} must match production model-key schema`);
}

function assertV2OpaqueId(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, V2_OPAQUE_ID, `${label} must match production opaque-ID schema`);
}

function assertV2ModelScopeKey(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  const encoded = /^model:(\d+):(.+)$/u.exec(value);
  assert.ok(encoded, `${label} must encode a model scope`);
  assert.equal(Number(encoded[1]), encoded[2].length, `${label} model-key length prefix must match`);
  assertV2ModelKey(encoded[2], `${label} model key`);
}

/** Persisted v2 model-circuit state: production schema, configured capacity, and no text canaries. */
function assertReliabilityV2Artifact(text) {
  assert.equal(typeof text, "string", "bifrost-reliability-v2.json must exist");
  assert.ok(Buffer.byteLength(text) <= 32 * 1024 * 1024, "v2 reliability artifact must stay within production 32 MiB read limit");
  const state = JSON.parse(text);
  assertExactKeys(state, V2_STATE_KEYS, [], "v2 reliability state");
  assert.equal(state.version, 2);
  assert.ok(Number.isSafeInteger(state.revision) && state.revision >= 0);
  for (const key of ["scopes", "dispatches", "settledOutcomes"]) {
    assert.ok(state[key] && typeof state[key] === "object" && !Array.isArray(state[key]), `v2 ${key} must be a record`);
  }
  for (const [scopeKey, scope] of Object.entries(state.scopes)) {
    assertV2ModelScopeKey(scopeKey, "v2 scope map key");
    assertExactKeys(scope, V2_SCOPE_KEYS, V2_SCOPE_OPTIONAL_KEYS, `v2 scopes[${scopeKey}]`);
    assert.ok(Number.isSafeInteger(scope.generation) && scope.generation >= 0);
    assert.ok(Array.isArray(scope.failures) && scope.failures.length <= 10_000,
      "v2 failure history must stay within production MAX_FAILURE_TIMESTAMPS");
    for (const [index, time] of scope.failures.entries()) assertTimestamp(time, `v2 scopes[${scopeKey}].failures[${index}]`);
    if (scope.openUntil !== undefined) assertTimestamp(scope.openUntil, `v2 scopes[${scopeKey}].openUntil`);
    if (scope.cooldownMultiplier !== undefined) assert.ok(Number.isFinite(scope.cooldownMultiplier) && scope.cooldownMultiplier >= 1);
    if (scope.lease !== undefined) {
      assertExactKeys(scope.lease, V2_LEASE_KEYS, [], `v2 scopes[${scopeKey}].lease`);
      for (const key of ["ownerToken", "dispatchId", "outcomeId", "leaseId"]) assertV2OpaqueId(scope.lease[key], `v2 scope lease ${key}`);
      assert.ok(Number.isSafeInteger(scope.lease.generation) && scope.lease.generation >= 0);
      assertTimestamp(scope.lease.expiresAt, "v2 scope lease expiresAt");
      assertTimestamp(scope.lease.maxExpiresAt, "v2 scope lease maxExpiresAt");
    }
  }
  const runtimeLimits = reliabilityV2Config();
  assert.ok(Object.keys(state.dispatches).length <= runtimeLimits.maxDispatchReceipts);
  assert.ok(Object.keys(state.settledOutcomes).length <= runtimeLimits.maxDedupEntries);
  for (const [id, receipt] of Object.entries(state.dispatches)) {
    assertV2OpaqueId(id, "v2 dispatch map key");
    assertExactKeys(receipt, V2_DISPATCH_KEYS, V2_DISPATCH_OPTIONAL_KEYS, `v2 dispatches[${id}]`);
    for (const key of ["ownerToken", "dispatchId", "outcomeId"]) assertV2OpaqueId(receipt[key], `v2 dispatch ${key}`);
    assert.equal(receipt.dispatchId, id, "dispatch map key must match receipt dispatchId");
    for (const key of ["admittedAt", "proofUntil", ...(receipt.settledAt === undefined ? [] : ["settledAt"])]) assertTimestamp(receipt[key], `v2 dispatch ${key}`);
    if (receipt.settledKind !== undefined) assert.ok(["success", "failure", "cancelled"].includes(receipt.settledKind));
    assert.ok(Array.isArray(receipt.scopes) && receipt.scopes.length > 0);
    for (const [index, ref] of receipt.scopes.entries()) {
      assertExactKeys(ref, V2_SCOPE_RECEIPT_KEYS, V2_SCOPE_RECEIPT_OPTIONAL_KEYS, `v2 dispatches[${id}].scopes[${index}]`);
      assertV2ModelScopeKey(ref.scopeKey, "v2 scope receipt scopeKey");
      assertV2ModelKey(ref.modelKey, "v2 scope receipt modelKey");
      assert.equal(ref.scopeKey, `model:${ref.modelKey.length}:${ref.modelKey}`);
      assert.ok(Number.isSafeInteger(ref.generation) && ref.generation >= 0);
      for (const key of ["expiresAt", "maxExpiresAt"]) if (ref[key] !== undefined) assertTimestamp(ref[key], `v2 scope receipt ${key}`);
      if (ref.leaseId !== undefined) assertV2OpaqueId(ref.leaseId, "v2 scope receipt leaseId");
    }
  }
  for (const [id, outcome] of Object.entries(state.settledOutcomes)) {
    assertV2OpaqueId(id, "v2 outcome map key");
    assertExactKeys(outcome, V2_OUTCOME_KEYS, V2_OUTCOME_OPTIONAL_KEYS, `v2 settledOutcomes[${id}]`);
    assertTimestamp(outcome.expiresAt, `v2 settledOutcomes[${id}].expiresAt`);
    if (outcome.observation !== undefined) {
      const observation = outcome.observation;
      assertExactKeys(observation, V2_OBSERVATION_KEYS, V2_OBSERVATION_OPTIONAL_KEYS, `v2 settledOutcomes[${id}].observation`);
      assertV2ModelKey(observation.modelKey, "v2 observation modelKey");
      assert.ok(V2_CATEGORIES.has(observation.category), "v2 observation category must be enumerated");
      assert.ok(V2_CATEGORY_EVIDENCE.has(observation.categoryEvidence), "v2 observation evidence must be enumerated");
      assertTimestamp(observation.observedAt, "v2 observation observedAt");
      assert.ok(["runtime", "activation", "probe"].includes(observation.source));
      if (observation.retryAt !== undefined) assertTimestamp(observation.retryAt, "v2 observation retryAt");
    }
  }
  assertNoCanaryValues(state, "bifrost-reliability-v2.json");
  return state;
}

/** Legacy v1 model circuit: exact envelope and exact record key set. */
function assertReliabilityArtifact(text) {
  assert.equal(typeof text, "string", "bifrost-reliability.json must exist");
  const state = JSON.parse(text);
  assertDeclaredKeys(state, RELIABILITY_ARTIFACT_KEYS, "bifrost-reliability.json");
  assert.equal(state.version, 1, "legacy reliability artifact must be version 1");
  assert.equal(typeof state.models, "object");
  for (const [model, record] of Object.entries(state.models)) {
    assertDeclaredKeys(record, RELIABILITY_RECORD_KEYS, `bifrost-reliability.json models["${model}"]`);
  }
  return state;
}

/** Provider-scoped v2 sidecar: exact envelope and nested key sets at every level. */
function assertProviderReliabilityArtifact(text) {
  assert.equal(typeof text, "string", "bifrost-provider-reliability.json must exist");
  const state = JSON.parse(text);
  assertDeclaredKeys(state, PROVIDER_ARTIFACT_KEYS, "bifrost-provider-reliability.json");
  assert.equal(state.version, 2, "provider reliability artifact must be version 2");
  for (const [scopeKey, scope] of Object.entries(state.scopes)) {
    const encoded = /^model:(\d+):(.+)$/.exec(scopeKey);
    assert.ok(encoded, `provider scope key must encode model:<length>:<model>: ${scopeKey}`);
    assert.equal(Number(encoded[1]), encoded[2].length, `provider scope key length prefix must match: ${scopeKey}`);
    assertDeclaredKeys(scope, PROVIDER_SCOPE_KEYS, `scopes["${scopeKey}"]`);
    if (scope.lease !== undefined) assertDeclaredKeys(scope.lease, PROVIDER_LEASE_KEYS, `scopes["${scopeKey}"].lease`);
  }
  for (const [id, receipt] of Object.entries(state.dispatches)) {
    assertDeclaredKeys(receipt, PROVIDER_DISPATCH_KEYS, `dispatches["${id}"]`);
    for (const [index, scopeReceipt] of receipt.scopes.entries()) {
      assertDeclaredKeys(scopeReceipt, PROVIDER_SCOPE_RECEIPT_KEYS, `dispatches["${id}"].scopes[${index}]`);
    }
  }
  for (const [id, outcome] of Object.entries(state.settledOutcomes)) {
    assertDeclaredKeys(outcome, PROVIDER_OUTCOME_KEYS, `settledOutcomes["${id}"]`);
    if (outcome.observation !== undefined) assertDeclaredKeys(outcome.observation, PROVIDER_OBSERVATION_KEYS, `settledOutcomes["${id}"].observation`);
  }
  return state;
}

// ── named redaction assertion (shared by the live case and its fault control) ──

/** Run a real Pi turn and return closed-process debug evidence for nested-summary checks. */
async function debugDecisionScenario(extension) {
  let raw;
  const released = await scenario({
    fixtureOptions: {
      extension,
      config: {
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: false },
        models: { general: ["fake/chat"] },
        debug: { enabled: true },
      },
    },
    body: async ({ env, sessions }) => {
      const rpc = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(rpc);
      await rpc.userTurn(CANARY_PROMPT);
      await rpc.close(env.home);
      raw = artifact(env.project, "bifrost-debug.jsonl");
    },
  });
  return { raw, released };
}

/** Run one actual Auto/v2 failure and inspect its persisted state after Pi closes. */
async function v2ReliabilityScenario(extension) {
  let state;
  let raw;
  const released = await scenario({
    fixtureOptions: {
      extension,
      models: ["chat", "credits-exhausted"],
      config: {
        schemaVersion: 2,
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: false },
        models: { general: ["fake/credits-exhausted"] },
        reliability: { enabled: true, stateVersion: 2, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 1 },
        debug: { enabled: true },
      },
    },
    body: async ({ env, sessions }) => {
      const rpc = startRpc({ home: env.home, work: env.work, extension, model: "bifrost/auto" });
      sessions.push(rpc);
      const migrated = await rpc.prompt("/bifrost reliability migrate --fresh");
      assert.equal(migrated.response.data?.disposition, "handled", "real Pi command must initialize the v2 store");
      const before = await stats();
      await rpc.userTurn(CANARY_PROMPT);
      const after = await stats();
      assert.equal(attemptDelta(before, after, "credits-exhausted"), 1,
        `Auto/v2 witness must reach configured fake model; debug: ${artifact(env.project, "bifrost-debug.jsonl") ?? "missing"}`);
      await rpc.close(env.home);
      raw = artifact(env.project, "bifrost-reliability-v2.json");
      state = assertReliabilityV2Artifact(raw);
      assert.ok(Object.keys(state.dispatches).length > 0, "Auto failure must persist a v2 dispatch receipt");
      assert.ok(Object.keys(state.scopes).length > 0, "Auto failure must persist a v2 model scope");
      assert.ok(Object.keys(state.settledOutcomes).length > 0, "Auto failure must persist a bounded settled outcome");
    },
  });
  return { released, raw, state };
}

/**
 * Run one real Pi turn with debug tracing enabled and assert the debug prompt
 * projection stays content-free. Returns the raw debug text plus the owned
 * cleanup outcome so a source-copy owner can gate its private-copy reclamation
 * on observed close and group absence. The exact named assertion below is what
 * the fault control must break.
 */
async function debugProjectionScenario(extension) {
  let raw = "";
  const released = await scenario({
    fixtureOptions: {
      extension,
      config: {
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: false },
        models: { general: ["fake/chat"] },
        debug: { enabled: true },
      },
    },
    body: async ({ env, sessions }) => {
      const rpc = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(rpc);
      await rpc.userTurn(CANARY_PROMPT);
      // Close inside the body so Pi's exit flush completes before the artifact
      // is read; scenario cleanup stays idempotent for the same session.
      await rpc.close(env.home);
      raw = artifact(env.project, "bifrost-debug.jsonl") ?? "";
    },
  });
  try {
    assert.notEqual(raw, "", "debug artifact must be written");
    const promptRows = debugRowsFrom(raw).filter((row) => row.module === "input" && row.event === "prompt");
    assert.equal(promptRows.length, 1, `exactly one debug prompt record; trace was:\n${raw}`);
    assert.deepEqual(
      Object.keys(promptRows[0]).sort(),
      ["entryType", "event", "length", "module", "ts"],
      "debug prompt projection must stay content-free",
    );
    assertNoCanaries(raw, "debug trace");
    return { raw, released };
  } catch (error) {
    error.released = released;
    throw error;
  }
}

function debugRowsFrom(raw) {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Run one real Pi turn through the pi-native classifier with global debug on and
 * enforce the named per-backend trace contract. `extension` lets the fault
 * control point at a private mutated copy of the tree instead of production.
 * Returns the emitted rows plus the owned cleanup outcome so a source-copy owner
 * can reclaim its private copy only after observed close and group absence.
 */
async function assertPiNativeTraceScenario(extension) {
  let rows = [];
  const released = await scenario({
    fixtureOptions: {
      extension,
      config: {
        enabled: true, default: "general", strategy: "first",
        classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
        models: { general: ["fake/chat"] }, debug: { enabled: true },
      },
    },
    body: async ({ env, sessions }) => {
      const rpc = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(rpc);
      await rpc.userTurn(CANARY_PROMPT);
      await rpc.close(env.home);
      rows = debugRows(env.project);
    },
  });
  try {
    const own = assertBackendTraceContract(rows, "pi-native", PI_NATIVE_TRACE_KEYS);
    assert.ok(own.some((row) => row.event === "model_missing"), "pi-native witness must reach the detailed trace");
    assert.equal(rows.some((row) => sensitiveStringKeys(row).length > 0), false, "pi-native trace must not carry sensitive string channels");
    // An allowed key name does not constrain its value. `cause` is a declared
    // pi-native key, so a free-form prompt/error could ride inside it; scan every
    // emitted row for the seeded canaries. This runs after the key-contract
    // assertions so the undeclared-key control still reaches its named assertion.
    assertNoCanaries(JSON.stringify(rows), "pi-native trace");
    return { rows, released };
  } catch (error) {
    // Propagate the owned cleanup outcome so a source-copy owner can gate its
    // private-copy reclamation on observed close and group absence.
    error.released = released;
    throw error;
  }
}

// ── scenarios ───────────────────────────────────────────────────

describe("command and artifact privacy acceptance", { timeout: 600_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeProviderServer(); });
  after(async () => { await server?.stop(); });

  it("keeps the debug trace inside an explicit key allowlist and free of canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: {
            enabled: true,
            backend: "prompt",
            model: "fake/classifier",
            // Endpoint canary: a same-origin path that resolves to a 404. The
            // classifier must record the status without persisting the URL.
            endpoint: `http://127.0.0.1:${server.port}/v1/${ENDPOINT_CANARY}`,
          },
          models: { general: ["fake/chat", "fake/missing"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-debug.jsonl");
        assertNoCanaries(raw, "debug trace");
        const rows = debugRowsFrom(raw);
        assert.ok(rows.length > 0, "debug trace must contain events");
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            assert.equal(DEBUG_KEY_ALLOWLIST.has(key), true, `debug key outside allowlist: ${key} (${row.module}/${row.event})`);
          }
          assert.deepEqual(sensitiveStringKeys(row), [], `sensitive string channel persisted (${row.module}/${row.event})`);
          if (row.decision !== undefined) assertRouteDecisionSummary(row.decision, `${row.module}/${row.event}.decision`);
        }
        const decisionRows = rows.filter((row) => row.event === "route_decision" && row.decision !== undefined);
        assert.ok(decisionRows.length > 0, "routing trace must witness its nested decision summary");
        const missingDecision = decisionRows.find((row) => row.decision.requested?.unresolvedPatterns?.some((entry) => entry.pattern === "fake/missing"))?.decision;
        assert.ok(missingDecision, "trace must include missing-pattern evidence");
        const mutated = structuredClone(missingDecision);
        mutated.requested.unresolvedPatterns[0].leaked_nested = "fault";
        assert.throws(() => assertRouteDecisionSummary(mutated), /unexpected key leaked_nested/u);
        const promptRows = rows.filter((row) => row.module === "input" && row.event === "prompt");
        assert.equal(promptRows.length, 1);
        assert.equal(promptRows[0].length, CANARY_PROMPT.length);
        assert.equal(Object.keys(promptRows[0]).includes("prompt"), false, "prompt text must never be a debug field");
      },
    });
  });

  it("writes a content-free classifier metrics artifact with no canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
          models: { general: ["fake/chat"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-classifier-metrics.json");
        assertNoCanaries(raw, "classifier metrics artifact");
        const state = JSON.parse(raw);
        assert.deepEqual(
          Object.keys(state).sort(),
          ["confidenceBands", "latencyBuckets", "lastObservedAt", "model", "outcomes", "tiers", "total", "totalAttempts", "totalLatencyMs", "version"].sort(),
          "metrics artifact must hold only the declared aggregate contract fields",
        );
        assert.equal(typeof state.model, "string");
        assert.equal(JSON.stringify(state).includes("prompt"), false, "metrics must not persist prompt state");
      },
    });
  });

  it("persists reliability and runtime state inside declared key sets without canaries", async () => {
    await scenario({
      fixtureOptions: {
        models: ["chat", "classifier", "credits-exhausted"],
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/credits-exhausted"] },
          reliability: { enabled: true },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        // Opt out of the classifier: persist that preference to runtime state.
        const off = await rpc.prompt("/bifrost classifier off");
        assert.equal(off.response.data?.disposition, "handled");
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        // Bifrost writes two independent reliability sidecars for this witness:
        // the legacy v1 model circuit and the provider-scoped v2 cooldown. Both
        // are inspected against their declared key sets — not merely
        // canary-scanned — and both must carry a real witness.
        const reliabilityText = artifact(env.project, "bifrost-reliability.json");
        const reliability = assertReliabilityArtifact(reliabilityText);
        assertNoCanaries(reliabilityText, "bifrost-reliability.json");
        assertNoCanaryValues(reliability, "bifrost-reliability.json");
        const exhausted = reliability.models["fake/credits-exhausted"];
        assert.ok(exhausted, "legacy reliability artifact must witness the exhausted model");
        assert.ok(exhausted.failures.length >= 1, "legacy witness must carry at least one recorded failure");
        assert.equal(exhausted.trialActive, false, "legacy witness must not claim a half-open trial");
        assert.equal(exhausted.lastFailureSource, "agent_settled", "legacy witness must preserve the documented failure-source marker");
        assert.equal(exhausted.lastFailureReason, "allowance_exhausted", "legacy witness must preserve the documented allowance marker; a free-form value here would hide unsanctioned text");

        // A missing provider artifact cannot prove the provider-side contract, so
        // existence is asserted directly rather than defaulted to an empty string.
        const providerText = artifact(env.project, "bifrost-provider-reliability.json");
        const provider = assertProviderReliabilityArtifact(providerText);
        assertNoCanaries(providerText, "bifrost-provider-reliability.json");
        assertNoCanaryValues(provider, "bifrost-provider-reliability.json");
        const scopeKeys = Object.keys(provider.scopes);
        assert.ok(scopeKeys.length >= 1, "provider witness must carry at least one cooldown scope");
        assert.ok(scopeKeys.some((key) => provider.scopes[key].openUntil > 0), "provider witness must carry an open cooldown");

        const runtime = artifact(env.project, "bifrost-state.json");
        assertNoCanaries(runtime, "runtime mode state");
        assert.deepEqual(Object.keys(JSON.parse(runtime)).sort(), ["classifierEnabled", "enabled"], "runtime state must hold only mode booleans");
        assert.equal(JSON.parse(runtime).classifierEnabled, false);
      },
    });
  });

  it("audits bounded redacted reliability v2 state from a real Pi Auto failure", async () => {
    const { state } = await v2ReliabilityScenario(EXTENSION);
    assert.ok(Object.values(state.dispatches).some((receipt) => receipt.settledKind === "failure"),
      "real Auto/v2 failure must leave a settled failure receipt in the audited artifact");
  });

  it("persists the classifier opt-out across restart and suppresses classifier dispatch", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
        },
      },
      body: async ({ env, sessions }) => {
        const first = startRpc({ home: env.home, work: env.work });
        sessions.push(first);
        const before = await stats();
        await first.userTurn(CANARY_PROMPT);
        const after = await stats();
        assert.equal(attemptDelta(before, after, "classifier"), 1, "classifier runs before opt-out");
        assert.equal(attemptDelta(before, after, "chat"), 1, "generation runs before opt-out");
        const off = await first.prompt("/bifrost classifier off");
        assert.equal(off.response.data?.disposition, "handled");
        const closed = await first.close(env.home);
        assert.equal(closed.closed, true);
        assert.equal(closed.groupGone, true);

        const beforeRestart = await stats();
        const second = startRpc({ home: env.home, work: env.work });
        sessions.push(second);
        await second.userTurn(CANARY_PROMPT);
        const afterRestart = await stats();
        assert.equal(attemptDelta(beforeRestart, afterRestart, "classifier"), 0, "persisted opt-out must survive restart");
        assert.equal(attemptDelta(beforeRestart, afterRestart, "chat"), 1, "generation continues while classifier is off");
      },
    });
  });

  it("persists normalized prompt text in the local cache and excludes unnormalized canaries", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
          cache: { enabled: true, maxEntries: 50, threshold: 0.85, ttlHours: 720 },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-cache.jsonl");
        assert.equal(typeof raw, "string", "normalized cache artifact must exist");
        // The cache retains lowercased, ordered prompt tokens and can therefore
        // contain potentially sensitive user text. It is not a content-free trace.
        // Original casing, punctuation, secret, and endpoint canaries must not
        // survive; error-canary words remain visible in normalized text.
        assert.equal(raw.includes(PROMPT_CANARY), false, "cache must not persist original prompt casing");
        for (const marker of [SECRET_CANARY, ENDPOINT_CANARY, ERROR_CANARY]) {
          assert.equal(raw.includes(marker), false, `cache must not persist ${marker}`);
        }
        const [entry] = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(entry.normalized, normalize(CANARY_PROMPT), "cache must persist only normalized prompt words");
        assert.deepEqual(
          Object.keys(entry).sort(),
          ["category", "hits", "lastUsed", "normalized", "semanticKey", "seq"],
          "cache entry must hold only the declared contract fields",
        );
        assert.doesNotMatch(raw, /"response"|"content"|"messages"/u, "cache must not persist response payloads");
      },
    });
  });

  it("writes a content-free completed probe report and saves nothing on abort", async () => {
    // (a) Real Pi RPC probe over fast fixture models: the report is written and
    // carries only the declared probe fields, with no canaries.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: false },
          models: { general: ["fake/chat"] },
          probe: { timeoutMs: 15_000, concurrency: 2 },
          debug: { enabled: true },
        },
        models: ["chat", "probe-fast"],
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        const probed = await rpc.prompt("/bifrost probe");
        assert.equal(probed.response.data?.disposition, "handled");
        await rpc.close(env.home);
        const raw = artifact(env.project, "bifrost-probe.json");
        assertNoCanaries(raw, "probe report");
        const report = JSON.parse(raw);
        assert.equal(Array.isArray(report), true, "probe report must be an array of results");
        const allowed = new Set(["provider", "model", "cost_input", "cost_output", "status", "duration_ms", "transport", "error", "tokens"]);
        for (const row of report) {
          for (const key of Object.keys(row)) assert.equal(allowed.has(key), true, `probe field outside allowlist: ${key}`);
        }
        assertNoCanaries(artifact(env.project, "bifrost-debug.jsonl"), "probe debug trace");
      },
    });

    // (b) Deterministic abort boundary (unit-level, matching tests/probe.test.ts):
    // an aborted run saves no report and records a cancelled completion with no
    // canaries or sensitive keys.
    const { runProbe } = await import("../../probe.ts");
    const { setupDebug, flushDebug } = await import("../../debug.ts");
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-privacy-probe-abort-"));
    const previousCwd = process.cwd();
    const controller = new AbortController();
    try {
      process.chdir(cwd);
      setupDebug({ enabled: true, path: join(cwd, "probe-debug.jsonl") }, cwd);
      const models = [
        { provider: "fake", id: "held-one", api: "openai-completions" },
        { provider: "fake", id: "held-two", api: "openai-completions" },
      ];
      const ctx = { modelRegistry: { getAvailable: () => models, streamSimple: () => ({ result: () => new Promise(() => {}) }) } };
      const pending = runProbe(ctx, { concurrency: 1, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      const result = await pending;
      await flushDebug(1_000);
      assert.equal(result.cancelled, true, "aborted probe must report cancellation");
      assert.equal(existsSync(join(cwd, ".pi", "bifrost-probe.json")), false, "aborted probe must save no partial report");
      const rows = readFileSync(join(cwd, "probe-debug.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const complete = rows.find((row) => row.event === "complete");
      assert.equal(complete?.cancelled, true, "probe abort must record a cancelled completion");
      assert.equal(rows.some((row) => sensitiveStringKeys(row).length > 0), false, "probe abort trace must not carry sensitive string channels");
      assertNoCanaries(JSON.stringify(rows), "probe abort trace");
    } finally {
      setupDebug({ enabled: false, path: join(cwd, "probe-debug.jsonl") }, cwd);
      process.chdir(previousCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gates the pi-native detailed trace on global debug and the typesafe trace on both gates", async () => {
    // pi-native: only the global debug.enabled gate. The witness is a real Pi
    // turn whose classifier model is absent from the fixture catalog, so it
    // reaches start/model_missing/finish. That proves the gate and the row
    // contract, not a completed pi-native classification against a live model.
    await assertPiNativeTraceScenario(EXTENSION);
    // pi-native: global debug off -> no trace at all.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
          models: { general: ["fake/chat"] }, debug: { enabled: false },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        assert.equal(existsSync(join(env.project, "bifrost-debug.jsonl")), false, "disabled debug must write no trace artifact");
      },
    });
    // typesafe: global on but typesafe.debug off -> no typesafe rows.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "typesafe", typesafe: {} },
          models: { general: ["fake/chat"] }, debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const rows = debugRows(env.project);
        assert.equal(rows.some((row) => row.module === "typesafe"), false, "typesafe trace must stay off without typesafe.debug");
      },
    });
    // typesafe: both gates on -> trace rows appear and stay inside the declared
    // backend key set. Boundary: with no auth.json the witness reaches
    // start/credential_missing/finish(missing_key), so it proves both trace gates
    // and the row contract, not a completed TypeSafe classification. That path
    // never emits the gated `request` row whose pinned `endpoint` key is in
    // SENSITIVE_KEYS, so no sensitive string can appear here.
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true, default: "general", strategy: "first",
          classifier: { enabled: true, backend: "typesafe", typesafe: { debug: true } },
          models: { general: ["fake/chat"] }, debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        await rpc.userTurn(CANARY_PROMPT);
        await rpc.close(env.home);
        const rows = debugRows(env.project);
        const typesafe = assertBackendTraceContract(rows, "typesafe", TYPESAFE_TRACE_KEYS);
        assert.ok(typesafe.some((row) => row.event === "credential_missing"), "typesafe witness must reach the credential-missing trace");
        for (const row of typesafe) {
          assert.equal(sensitiveStringKeys(row).length, 0, "typesafe trace must not carry sensitive string channels");
        }
        assertNoCanaries(artifact(env.project, "bifrost-debug.jsonl"), "typesafe debug trace");
      },
    });
  });

  it("runs the classifier test and benchmark commands without leaking canaries into artifacts", async () => {
    await scenario({
      fixtureOptions: {
        config: {
          enabled: true,
          default: "general",
          strategy: "first",
          classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
          models: { general: ["fake/chat"] },
          debug: { enabled: true },
        },
      },
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work });
        sessions.push(rpc);
        const tested = await rpc.prompt("/bifrost classifier test");
        assert.equal(tested.response.data?.disposition, "handled");
        const benchmarked = await rpc.prompt(`/bifrost benchmark ${CANARY_PROMPT}`);
        assert.equal(benchmarked.response.data?.disposition, "handled");
        await rpc.close(env.home);
        // The command output may echo the prompt to the user, but no persisted
        // artifact may contain any canary.
        for (const name of ["bifrost-debug.jsonl", "bifrost-classifier-metrics.json", "bifrost-reliability.json", "bifrost-state.json"]) {
          const text = artifact(env.project, name);
          if (text !== undefined) assertNoCanaries(text, name);
        }
      },
    });
  });

  it("fault controls: nested unknown fields and prompt canaries fail decision schema audit", async () => {
    const sourcePath = join(ROOT, "index.ts");
    const original = readFileSync(sourcePath, "utf8");
    const originalHash = sha256(original);
    const anchor = `debug("input", "route_decision", {\n          decision: buildRouteDecisionSummary(classification, attempt),\n        });`;
    assert.ok(original.includes(anchor), "input route-decision projection anchor must exist");
    const mutants = [
      {
        name: "nested unknown key",
        expected: /unexpected key leaked_nested/u,
        replacement: `debug("input", "route_decision", {\n          decision: (() => { const summary = buildRouteDecisionSummary(classification, attempt); return { ...summary, leaked_nested: "fault" }; })(),\n        });`,
      },
      {
        name: "nested prompt value",
        expected: /must not carry canary CANARY_PROMPT_alpaca_7f3d/u,
        replacement: `debug("input", "route_decision", {\n          decision: (() => { const summary = buildRouteDecisionSummary(classification, attempt); return { ...summary, classification: { ...summary.classification, tier: "CANARY_PROMPT_alpaca_7f3d" } }; })(),\n        });`,
      },
    ];
    for (const mutant of mutants) {
      const mutated = original.replace(anchor, mutant.replacement);
      assert.notEqual(mutated, original, `${mutant.name} mutation must apply`);
      const scratch = mkdtempSync(join(tmpdir(), "bifrost-decision-privacy-fault-"));
      let released;
      let proofError;
      try {
        for (const entry of readdirSync(ROOT)) {
          if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
            copyFileSync(join(ROOT, entry), join(scratch, entry));
          }
        }
        symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
        writeFileSync(join(scratch, "index.ts"), mutated);
        const run = await debugDecisionScenario(join(scratch, "index.ts"));
        released = run.released;
        try { assertDebugDecisionRows(run.raw); }
        catch (error) { proofError = error; }
        if (!ownedCleanupObserved(released)) throw proofError ?? new Error(`${mutant.name} cleanup was not observed safe`);
        assert.ok(proofError, `${mutant.name} fault must turn the recursive audit RED`);
        assert.match(String(proofError.message), mutant.expected, `${mutant.name} must fail its named guard`);
        assert.equal(proofError.name, "AssertionError");
        assert.equal(sha256(readFileSync(sourcePath, "utf8")), originalHash, "production index.ts must remain unchanged");
        const restored = await debugDecisionScenario(EXTENSION);
        assertDebugDecisionRows(restored.raw);
      } finally {
        reclaimSourceCopy(scratch, released);
      }
    }
  });

  it("fault control: leaking the prompt projection turns the named redaction assertion RED", async () => {
    const sourcePath = join(ROOT, "index.ts");
    const original = readFileSync(sourcePath, "utf8");
    assert.equal(sha256(original), PRODUCTION_INDEX_SHA256, "production index.ts must match the recorded baseline before the proof");
    const anchor = 'debug("input", "prompt", { length: promptText.length });';
    assert.ok(original.includes(anchor), "debug prompt projection anchor must exist");
    const mutated = original.replace(anchor, 'debug("input", "prompt", { length: promptText.length, prompt: promptText });');
    assert.notEqual(mutated, original, "debug projection mutation must apply");
    assert.notEqual(sha256(mutated), PRODUCTION_INDEX_SHA256, "mutation must be a real source change");

    const scratch = mkdtempSync(join(tmpdir(), "bifrost-privacy-fault-"));
    let released;
    let proofError;
    try {
      for (const entry of readdirSync(ROOT)) {
        if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
          copyFileSync(join(ROOT, entry), join(scratch, entry));
        }
      }
      symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
      writeFileSync(join(scratch, "index.ts"), mutated);

      // RED: the mutated private copy must fail the named assertion, not a
      // startup or syntax error.
      try {
        ({ released } = await debugProjectionScenario(join(scratch, "index.ts")));
      } catch (error) {
        proofError = error;
        released = error.released;
      }
      // Retain the private copy and surface the real cleanup error when the owned
      // run's cleanup was not observed safe, instead of masking it with the
      // expected assertion mismatch or deleting a source a live run may import.
      if (!ownedCleanupObserved(released)) throw proofError ?? new Error("prompt projection fault cleanup was not observed safe");
      assert.ok(proofError, "mutated prompt projection must fail the redaction assertion");
      assert.match(String(proofError.message), /debug prompt projection must stay content-free/u, "mutation must fail the named assertion");
      assert.equal(proofError.name, "AssertionError", "mutation must fail by assertion, not by startup or runtime error");
      assert.equal(sha256(readFileSync(join(scratch, "index.ts"), "utf8")), sha256(mutated), "mutated copy must stay mutated");

      // GREEN + restore: the committed source is untouched and still passes.
      assert.equal(sha256(readFileSync(sourcePath, "utf8")), PRODUCTION_INDEX_SHA256, "production source must be unchanged after the proof");
      await debugProjectionScenario(sourcePath);
    } finally {
      reclaimSourceCopy(scratch, released);
    }
  });

  it("fault control: a canary added to persisted v2 state turns the exact-schema assertion RED", async () => {
    const sourcePath = join(ROOT, "reliability-v2-store.ts");
    const original = readFileSync(sourcePath, "utf8");
    const originalHash = sha256(original);
    const anchor = "  writeState: writeJsonFile,";
    assert.ok(original.includes(anchor), "v2 store writer anchor must exist");
    const mutated = original.replace(anchor,
      '  writeState(path, state) { writeJsonFile(path, state.dispatches && Object.keys(state.dispatches).length > 0 ? { ...state, prompt: "CANARY_PROMPT_alpaca_7f3d" } : state); },');
    assert.notEqual(mutated, original, "v2 persistence mutation must apply");
    assert.notEqual(sha256(mutated), originalHash, "v2 persistence mutation must change source bytes");

    const scratch = mkdtempSync(join(tmpdir(), "bifrost-v2-privacy-fault-"));
    let released;
    let proofError;
    try {
      for (const entry of readdirSync(ROOT)) {
        if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
          copyFileSync(join(ROOT, entry), join(scratch, entry));
        }
      }
      symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
      writeFileSync(join(scratch, "reliability-v2-store.ts"), mutated);
      try { ({ released } = await v2ReliabilityScenario(join(scratch, "index.ts"))); }
      catch (error) { proofError = error; released = error.released; }
      if (!ownedCleanupObserved(released)) throw proofError ?? new Error("v2 privacy fault cleanup was not observed safe");
      assert.ok(proofError, "mutant v2 writer must fail the persisted-state audit");
      assert.match(String(proofError.message), /v2 reliability state: unexpected key prompt/u,
        "fault must fail recursive exact schema assertion, not startup or unrelated behavior");
      assert.equal(proofError.name, "AssertionError");
      assert.equal(sha256(readFileSync(sourcePath, "utf8")), originalHash, "production store source must stay unchanged");
      await v2ReliabilityScenario(EXTENSION);
    } finally {
      reclaimSourceCopy(scratch, released);
    }
  });

  it("fault control: an undeclared pi-native trace key turns the per-backend allowlist assertion RED", async () => {
    const sourcePath = join(ROOT, "classifier-pi-native.ts");
    const original = readFileSync(sourcePath, "utf8");
    const originalHash = sha256(original);
    const anchor = 'trace("start", { tiers: request.tiers, prompt_length: request.prompt.length, timeout_ms: timeoutMs, max_attempts: maxAttempts });';
    assert.ok(original.includes(anchor), "pi-native start trace anchor must exist");
    const mutated = original.replace(anchor, 'trace("start", { tiers: request.tiers, prompt_length: request.prompt.length, timeout_ms: timeoutMs, max_attempts: maxAttempts, leaked_prompt: request.prompt });');
    assert.notEqual(mutated, original, "pi-native trace mutation must apply");
    assert.notEqual(sha256(mutated), originalHash, "mutation must be a real source change");

    const scratch = mkdtempSync(join(tmpdir(), "bifrost-trace-key-fault-"));
    let released;
    let proofError;
    try {
      for (const entry of readdirSync(ROOT)) {
        if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
          copyFileSync(join(ROOT, entry), join(scratch, entry));
        }
      }
      symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));
      writeFileSync(join(scratch, "classifier-pi-native.ts"), mutated);

      // RED: the mutated private copy must fail the named per-backend assertion,
      // which runs before any canary or value check.
      try {
        ({ released } = await assertPiNativeTraceScenario(join(scratch, "index.ts")));
      } catch (error) {
        proofError = error;
        released = error.released;
      }
      // Retain the private copy and surface the real cleanup error when the owned
      // run's cleanup was not observed safe, instead of masking it with the
      // expected assertion mismatch or deleting a source a live run may import.
      if (!ownedCleanupObserved(released)) throw proofError ?? new Error("pi-native trace fault cleanup was not observed safe");
      assert.ok(proofError, "an undeclared pi-native trace key must fail the backend allowlist assertion");
      assert.match(String(proofError.message), /pi-native trace key outside declared backend set/u, "mutation must fail the named trace-contract assertion");
      assert.equal(proofError.name, "AssertionError", "mutation must fail by assertion, not by startup or runtime error");
      assert.equal(sha256(readFileSync(join(scratch, "classifier-pi-native.ts"), "utf8")), sha256(mutated), "mutated copy must stay mutated");

      // GREEN + restore: production is untouched and still inside its declared set.
      assert.equal(sha256(readFileSync(sourcePath, "utf8")), originalHash, "production classifier source must be unchanged after the proof");
      await assertPiNativeTraceScenario(join(ROOT, "index.ts"));
    } finally {
      reclaimSourceCopy(scratch, released);
    }
  });

  it("cleanup control: an uncertain reported receipt retains the private source copy and preserves the real cleanup error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-trace-cleanup-control-"));
    let observedReceipt;
    let actualSafetyReceipt;
    let released;
    let cleanupError;
    try {
      try {
        for (const entry of readdirSync(ROOT)) {
          if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
            copyFileSync(join(ROOT, entry), join(scratch, entry));
          }
        }
        symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));

        const extension = join(scratch, "index.ts");
        released = await scenario({
          fixtureOptions: {
            extension,
            config: {
              enabled: true, default: "general", strategy: "first",
              classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
              models: { general: ["fake/chat"] }, debug: { enabled: true },
            },
          },
          body: async ({ env, sessions }) => {
            const rpc = startRpc({ home: env.home, work: env.work, extension });
            // The real owned run closes and its group dies inside rpc.close();
            // only the REPORTED receipt is made uncertain, and only afterwards.
            sessions.push({
              close: async (home) => {
                const receipt = await rpc.close(home);
                // Capture the actual safety receipt independently of the reported
                // receipt, which is deliberately made uncertain below. This is test
                // hygiene only and never clears the submitted unknown cleanup.
                actualSafetyReceipt = receipt;
                observedReceipt = receipt;
                return { ...receipt, closed: false, groupGone: false };
              },
            });
            await rpc.userTurn(CANARY_PROMPT);
            await rpc.close(env.home);
          },
        });
      } catch (error) {
        cleanupError = error;
        released = error.released;
      }

      // Actual safety was observed first; only the report was uncertain.
      assert.ok(observedReceipt, "the real owned run must report its receipt");
      assert.equal(observedReceipt.closed, true, "the real owned run must actually close");
      assert.equal(observedReceipt.groupGone, true, "the real owned process group must actually be absent");
      assert.equal(observedReceipt.violations, "", "the real owned run must report no network violations");
      assert.equal(ownedCleanupObserved(released), false, "an uncertain reported receipt must not count as observed-safe cleanup");
      assert.ok(cleanupError, "uncertain cleanup must surface its real error");
      assert.match(String(cleanupError.message), /privacy scratch retained at/u, "the real cleanup error must be preserved, not an expected-assert mismatch");
      assert.equal(cleanupError.released, released, "the cleanup error must carry the owned receipts");

      // The source-copy owner retains its private copy while the report is uncertain.
      assert.equal(reclaimSourceCopy(scratch, released), false, "an uncertain reported receipt must retain the private source copy");
      assert.equal(existsSync(scratch), true, "the private source copy must survive an uncertain report");
      assert.equal(existsSync(join(scratch, "classifier-pi-native.ts")), true, "the retained copy must keep its source evidence");

      // The outer control reclaims with the actual creation receipts, now that
      // the reported uncertainty is resolved by the observed close and group death.
      const actual = { removed: true, failures: [], receipts: [observedReceipt], retained: [] };
      assert.equal(ownedCleanupObserved(actual), true, "the actual receipts must prove every owned run closed with its group absent");
      assert.equal(reclaimSourceCopy(scratch, actual), true, "the owner must reclaim once actual safety is observed");
      assert.equal(existsSync(scratch), false, "the reclaimed private copy must be gone");
    } finally {
      reclaimControlArtifacts(scratch, released, actualSafetyReceipt);
    }
  });

  it("cleanup control: a missing actual receipt retains every owned path and preserves the real cleanup error", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "bifrost-trace-cleanup-missing-receipt-"));
    let actualSafetyReceipt;
    let observedReceipt;
    let released;
    let cleanupError;
    try {
      try {
        for (const entry of readdirSync(ROOT)) {
          if (entry.endsWith(".ts") || ["schema.json", "package.json"].includes(entry)) {
            copyFileSync(join(ROOT, entry), join(scratch, entry));
          }
        }
        symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"));

        const extension = join(scratch, "index.ts");
        released = await scenario({
          fixtureOptions: {
            extension,
            config: {
              enabled: true, default: "general", strategy: "first",
              classifier: { enabled: true, backend: "pi-native", piNative: { model: "fake/classifier" } },
              models: { general: ["fake/chat"] }, debug: { enabled: true },
            },
          },
          body: async ({ env, sessions }) => {
            const rpc = startRpc({ home: env.home, work: env.work, extension });
            sessions.push({
              close: async (home) => {
                const receipt = await rpc.close(home);
                // The actual owned run is already safe here, but the reported/
                // assigned receipt is deliberately lost before assignment. This is
                // test hygiene only; it must not clear the submitted unknown cleanup.
                actualSafetyReceipt = receipt;
                throw new Error("G09_INJECTED_CLOSE_FAILURE");
              },
            });
            await rpc.userTurn(CANARY_PROMPT);
            await rpc.close(env.home);
          },
        });
      } catch (error) {
        cleanupError = error;
        released = error.released;
      }

      // The submitted cleanup outcome has no actual receipt, so it must not be
      // treated as observed-safe even though a separate safe receipt exists.
      assert.equal(observedReceipt, undefined, "the reported receipt must be missing");
      assert.ok(actualSafetyReceipt, "the real owned run must have produced a separate safe receipt");
      assert.equal(actualSafetyReceipt.closed, true, "the real owned run must actually close");
      assert.equal(actualSafetyReceipt.groupGone, true, "the real owned process group must actually be absent");
      assert.equal(actualSafetyReceipt.violations, "", "the real owned run must report no network violations");
      assert.equal(ownedCleanupObserved(released), false, "a missing actual receipt must not count as observed-safe cleanup");
      assert.ok(cleanupError, "missing-actual-receipt cleanup must surface its real error");
      assert.match(String(cleanupError.message), /privacy scratch retained at/u, "the real cleanup error must be preserved");
      assert.equal(cleanupError.released, released, "the cleanup error must carry the owned receipts");

      // Exercise the same outer teardown with the submitted unknown receipt,
      // then inspect retention after finally. The safe receipt is hygiene only.
      let propagatedError;
      try {
        try { throw cleanupError; }
        finally { reclaimControlArtifacts(scratch, released, observedReceipt); }
      } catch (error) {
        propagatedError = error;
      }
      assert.equal(propagatedError, cleanupError, "outer teardown must preserve the original cleanup Error identity");
      assert.equal(released.retained.length, 2, "the missing-receipt proof must witness both home and work paths");
      assert.equal(existsSync(scratch), true, "the private source copy must survive a missing actual receipt");
      assert.equal(existsSync(join(scratch, "classifier-pi-native.ts")), true, "the retained copy must keep its source evidence");
      for (const path of released?.retained ?? []) {
        assert.equal(existsSync(path), true, `retained owned path must survive a missing actual receipt: ${path}`);
      }
    } finally {
      reclaimControlArtifacts(scratch, released, actualSafetyReceipt);
    }
  });
});
