// Verify the native run, provider requests and persisted legacy trial together.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Input text includes an explicit tier override. The host's input transform
// strips that tier before both the user message and the provider request.
export const PROMPTS = ["please", "one", "two"];
export const MODELS = ["slow", "strong", "fast"];
const digest = (text) => createHash("sha256").update(text).digest("hex");
const keys = (models) => models.map((model) => "fake/" + model);

function assertSession(events) {
  assert.ok(events.length && events[0].session, "missing native session");
  assert.ok(events.every((event) => event.session === events[0].session), "mixed native sessions");
}

function assertRunBoundaries(events, runs) {
  assertSession(events);
  const types = runs.flatMap((count) => ["start", ...Array(count).fill("turn"), "settled"]);
  assert.deepEqual(events.map((event) => event.type), types, "incorrect run boundaries or turn count");
  const identities = runs.flatMap((count, index) => Array(count + 2).fill(index + 1));
  assert.deepEqual(events.map((event) => event.run), identities, "wrong run attribution");
}

function assertTurns(events, prompts, models) {
  const turns = events.filter((event) => event.type === "turn");
  assert.deepEqual(turns.map((turn) => [turn.provider, turn.model, turn.stopReason]),
    models.map((model) => ["fake", model, "stop"]), "incorrect native turn outcomes");
  const messages = events.at(-1).messages;
  // Pinned Pi persists one leading system message; do not discard any
  // other entry or permit system messages to interrupt the user/assistant sequence.
  assert.equal(messages[0]?.role, "system", "missing leading system message");
  assert.deepEqual(messages.slice(1).map((message) => message.role === "user"
    ? ["user", message.text] : [message.role, message.provider, message.model, message.stopReason]),
  prompts.flatMap((prompt, index) => [["user", prompt], ["assistant", "fake", models[index], "stop"]]),
  "incorrect final branch transcript");
  assert.deepEqual(turns.map((turn) => turn.entryId),
    messages.filter((message) => message.role === "assistant").map((message) => message.id),
    "turn completion is not bound to the final transcript");
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length, "duplicate message entries");
  assert.ok(messages.every((message) => typeof message.id === "string" && message.id), "missing message identity");
}

function assertRequests(requests, prompts, models) {
  assert.deepEqual(requests.map(({ provider, model, kind, userMessageDigest, completed, clientClosed }) =>
    [provider, model, kind, userMessageDigest, completed, Boolean(clientClosed)]),
  models.map((model, index) => ["fake", model, "generation", digest(prompts[index]), true, false]),
  "incorrect provider request identity, order or completion");
}

function assertDebug(debug, models, runs) {
  const dispatches = debug.filter((event) => event.event === "dispatch" && event.module === "virtual" && event.session_correlation_id);
  assert.deepEqual(dispatches.map((event) => event.model), keys(models), "incorrect correlated dispatch sequence");
  const session = dispatches[0]?.session_correlation_id;
  assert.ok(session && dispatches.every((event) => event.session_correlation_id === session), "mixed dispatch sessions");
  assert.ok(dispatches.every((event) => event.turn_correlation_id && event.request_correlation_id), "missing dispatch correlation");
  assert.equal(new Set(dispatches.map((event) => event.request_correlation_id)).size, models.length, "duplicate dispatch request");
  const outcomes = debug.filter((event) => event.event === "legacy_outcome_observed");
  assert.deepEqual(outcomes.map((event) => [event.model, event.outcome, event.session_correlation_id]),
    models.map((model) => ["fake/" + model, "success", session]), "incorrect observed settlement outcomes");
  const claims = debug.filter((event) => event.event === "trial" && event.claimed === true);
  assert.deepEqual(claims.map((event) => [event.model, event.allowed]), models.includes("fast") ? [["fake/fast", true]] : [],
    "incorrect half-open claim");
  // Legacy outcome traces are model/session attributed, not turn attributed.
  // Native run boundaries plus isolated process and exact provider/branch identity
  // establish the relationship; do not invent a legacy per-dispatch receipt.
  const lifecycle = debug.filter((event) => dispatches.includes(event) || outcomes.includes(event));
  let offset = 0;
  const expected = runs.flatMap((count) => {
    const group = keys(models.slice(offset, offset + count));
    offset += count;
    return [...group.map((model) => ["dispatch", model]),
      ...group.map((model) => ["legacy_outcome_observed", model])];
  });
  assert.deepEqual(lifecycle.map(({ event, model }) => [event, model]), expected,
    "settlement occurred outside the expected dispatch group");
  if (claims.length) {
    assert.ok(debug.indexOf(claims[0]) > debug.indexOf(dispatches.find((event) => event.model === "fake/fast"))
      && debug.indexOf(claims[0]) < debug.indexOf(outcomes.find((event) => event.model === "fake/fast")),
    "half-open claim does not precede its outcome");
  }
}

function assertState(state, events) {
  const record = state.models?.["fake/fast"];
  assert.ok(record && record.trialActive === false && record.openUntil === undefined
    && Array.isArray(record.failures) && record.failures.length === 0
    && record.lastSuccessSource === "agent_settled"
    && Number.isFinite(record.lastSuccessAt) && record.lastSuccessAt >= events[0].at,
  "half-open trial did not persist successful settlement");
  assert.ok(Object.values(state.models).every((value) => !value.trialActive && value.openUntil === undefined),
    "another circuit remains active or open");
}

function assertObserved({ events, requests, debug, state }, prompts, models, runs, expectTrial) {
  assertRunBoundaries(events, runs);
  assertTurns(events, prompts, models);
  assertRequests(requests, prompts, models);
  assertDebug(debug, models, runs);
  if (expectTrial) assertState(state, events);
}

export function assertSingleRun(evidence) {
  assertObserved(evidence, PROMPTS, MODELS, [3], true);
}

export function assertPending(evidence) {
  assertSession(evidence.events);
  assert.deepEqual(evidence.events.map((event) => event.type), ["start", "turn", "turn"],
    "held final request must be in an unfinished three-dispatch run");
  assert.ok(evidence.events.every((event) => event.run === 1), "held request is in another run");
  assert.deepEqual(evidence.events.filter((event) => event.type === "turn")
    .map(({ provider, model, stopReason }) => [provider, model, stopReason]),
  [["fake", "slow", "stop"], ["fake", "strong", "stop"]], "held request must follow two successful turns");
  assert.deepEqual(evidence.requests.map(({ model, completed, userMessageDigest }) => [model, completed, userMessageDigest]),
    MODELS.map((model, index) => [model, index !== 2, digest(PROMPTS[index])]), "wrong pending provider requests");
  assert.equal(evidence.state.models["fake/fast"].trialActive, true, "held half-open trial was not claimed");
  assert.throws(() => assertSingleRun(evidence), /incorrect run boundaries or turn count/,
    "an unfinished real run must not pass");
}

export function assertControl(evidence, mode) {
  if (mode === "missing") {
    assertObserved(evidence, PROMPTS.slice(0, 2), MODELS.slice(0, 2), [2], false);
    const seed = evidence.state.models["fake/fast"];
    assert.equal(seed.trialActive, false);
    assert.equal(seed.openUntil, 1, "missing steer must not silently recover the trial");
    assert.equal(seed.lastSuccessAt, undefined);
  } else if (mode === "separate") {
    // Same three successful requests and final circuit, but distinct real runs.
    assertObserved(evidence, PROMPTS, MODELS, [1, 1, 1], true);
  } else {
    assert.fail("unknown control");
  }
  assert.throws(() => assertSingleRun(evidence), /incorrect run boundaries or turn count/,
    "the real negative run must fail the positive contract for its intended reason");
}

const jsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
function loadEvidence(work, beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  assert.deepEqual(after.stats.slice(0, before.stats.length), before.stats, "provider baseline changed");
  return {
    events: jsonl(join(work, ".pi", "ui-run.jsonl")),
    debug: jsonl(join(work, ".pi", "bifrost-debug.jsonl")),
    state: JSON.parse(readFileSync(join(work, ".pi", "bifrost-reliability.json"), "utf8")),
    requests: after.stats.slice(before.stats.length),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, work, before, after] = process.argv.slice(2);
  const evidence = loadEvidence(work, before, after);
  if (mode === "positive") assertSingleRun(evidence);
  else if (mode === "pending") assertPending(evidence);
  else assertControl(evidence, mode);
  console.log("scenario 6 " + mode + " lifecycle proof passed");
}
