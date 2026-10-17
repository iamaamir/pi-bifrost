// Generated-boundary properties for the persisted reliability circuit.
//
// A separate reference machine predicts the circuit after every generated
// operation, so a regression in `reliability.ts` cannot silently redefine the
// contract. Operations cover failure, success, clock advance, trial start,
// trial abandon, circuit read, save and restart; the logical clock is injected
// as a number, so every boundary is exact and no test depends on wall time or
// sleeping. Generated sequences shrink to a minimal replayable case.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  abandonTrial,
  beginTrial,
  emptyReliabilityState,
  getCircuitState,
  hasActiveAllowanceCooldown,
  loadReliability,
  recordModelFailure,
  recordModelSuccess,
  reliabilityPath,
  saveReliability,
  type CircuitState,
  type ReliabilityConfig,
  type ReliabilityState,
} from "../reliability.ts";
import { reliabilitySourceFencePath } from "../reliability-v1-fence.ts";

const MINUTE_MS = 60_000;
/** Fixed logical origin; the clock only ever moves forward by generated deltas. */
const ORIGIN = Date.UTC(2026, 0, 1, 12, 0, 0);
/** Several identities so an operation on one must never move another. */
const IDENTITIES = ["openai/gpt-5.4", "anthropic/claude-sonnet-4", "google/gemini-3-pro"] as const;
const FAILURE_SOURCE = "runtime";
const FAILURE_REASON = "timeout";

interface ScenarioConfig {
  readonly enabled: boolean;
  readonly failureThreshold: number;
  readonly windowMinutes: number;
  readonly cooldownMinutes: number;
}

const DOCUMENTED_DEFAULTS: ScenarioConfig = { enabled: true, failureThreshold: 3, windowMinutes: 5, cooldownMinutes: 60 };
/** Opens on the first failure, which keeps the fault scenarios minimal. */
const IMMEDIATE: ScenarioConfig = { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 60 };

function reliabilityConfig(config: ScenarioConfig): ReliabilityConfig {
  return { ...config };
}

// ── Reference implementation ─────────────────────────────────────

interface ReferenceRecord {
  /** Raw recorded failure instants, oldest first. */
  failures: number[];
  /** When the cooldown ends; `undefined` while the circuit is closed. */
  openUntil: number | undefined;
  trialActive: boolean;
  /** Cooldown multiplier. Stays at 1 until a trial failure doubles it. */
  backoff: number;
}

type ReferenceSnapshot = ReadonlyMap<string, Readonly<ReferenceRecord>>;

/** Independent model of the documented circuit rules, over its own representation. */
class Reference {
  private readonly records = new Map<string, ReferenceRecord>();
  private readonly config: ScenarioConfig;

  constructor(config: ScenarioConfig) {
    this.config = config;
  }

  private counted(record: ReferenceRecord, now: number): number[] {
    const oldestCounted = now - this.config.windowMinutes * MINUTE_MS;
    return record.failures.filter((at) => at >= oldestCounted);
  }

  circuit(identity: string, now: number): CircuitState {
    const record = this.records.get(identity);
    const openUntil = record?.openUntil;
    const cooldownElapsed = openUntil !== undefined && openUntil <= now;
    return {
      open: openUntil !== undefined && openUntil > now,
      halfOpen: cooldownElapsed && record?.trialActive !== true,
      trialActive: record?.trialActive === true,
      openUntil,
      recentFailures: record ? this.counted(record, now).length : 0,
    };
  }

  fail(identity: string, now: number): void {
    if (!this.config.enabled) return;
    const record = this.records.get(identity);
    const trialing = record?.trialActive === true;
    const backoff = trialing ? record.backoff * 2 : record?.backoff ?? 1;
    const failures = [...(record ? this.counted(record, now) : []), now];
    // A failed trial reopens immediately; otherwise the window has to fill up.
    const shouldOpen = trialing || failures.length >= this.config.failureThreshold;
    this.records.set(identity, {
      failures,
      openUntil: shouldOpen ? now + this.config.cooldownMinutes * MINUTE_MS * backoff : record?.openUntil,
      trialActive: false,
      backoff: trialing ? backoff : record?.backoff ?? 1,
    });
  }

  success(identity: string): void {
    this.records.set(identity, { failures: [], openUntil: undefined, trialActive: false, backoff: 1 });
  }

  beginTrial(identity: string): void {
    const record = this.records.get(identity);
    if (!record || record.trialActive) return;
    record.trialActive = true;
  }

  abandonTrial(identity: string): void {
    const record = this.records.get(identity);
    if (!record?.trialActive) return;
    record.trialActive = false;
  }

  snapshot(): ReferenceSnapshot {
    return new Map([...this.records].map(([identity, record]) => [identity, { ...record, failures: [...record.failures] }]));
  }

  restore(snapshot: ReferenceSnapshot): void {
    this.records.clear();
    for (const [identity, record] of snapshot) {
      this.records.set(identity, { ...record, failures: [...record.failures] });
    }
  }
}

// ── Operations ───────────────────────────────────────────────────

type OpName = "advance" | "fail" | "success" | "beginTrial" | "abandonTrial" | "circuit" | "save" | "load";

interface Op {
  readonly op: OpName;
  readonly identity: number;
  readonly deltaMs: number;
}

function describeOp(op: Op): string {
  const identity = IDENTITIES[op.identity] ?? "?";
  if (op.op === "advance") return `advance(${identity} clock +${op.deltaMs}ms)`;
  return `${op.op}(${identity})`;
}

interface ScenarioModel {
  state: ReliabilityState;
}

interface ScenarioContext {
  readonly config: ScenarioConfig;
  readonly fault: Fault;
  readonly path: string;
  readonly reference: Reference;
  now: number;
  /** What a restart is expected to bring back. */
  persisted: ReferenceSnapshot | undefined;
}

type Fault = "none" | "successIsIgnored" | "trialFailureSkipsBackoff" | "failureLeaksToOtherIdentity"
  | "saveDiscardsState" | "loadKeepsMemory";

const NEIGHBOUR = IDENTITIES[1];

function projections(state: ReliabilityState, now: number, config: ScenarioConfig): Record<string, CircuitState> {
  return Object.fromEntries(IDENTITIES.map((identity) => [identity, getCircuitState(state, identity, now, reliabilityConfig(config))]));
}

interface Baseline {
  /** The clock reading every comparison in this step is pinned to. */
  readonly now: number;
  readonly circuits: Record<string, CircuitState>;
}

function baseline(state: ReliabilityState, now: number, config: ScenarioConfig): Baseline {
  return { now, circuits: projections(state, now, config) };
}

function verify(op: Op, model: ScenarioModel, context: ScenarioContext, before: Baseline): void {
  const { config, reference } = context;
  const target = IDENTITIES[op.identity];
  const settings = reliabilityConfig(config);

  for (const identity of IDENTITIES) {
    const circuit = getCircuitState(model.state, identity, context.now, settings);
    assert.deepEqual(circuit, reference.circuit(identity, context.now), `${describeOp(op)}: circuit diverged for ${identity}`);
    assert.equal(
      hasActiveAllowanceCooldown(model.state, identity, context.now),
      false,
      `${describeOp(op)}: an ordinary failure must never publish an allowance cooldown for ${identity}`,
    );
    assert.equal(circuit.open && circuit.halfOpen, false, `${describeOp(op)}: ${identity} cannot be open and half-open at once`);
    if (circuit.halfOpen) {
      assert.equal(circuit.trialActive, false, `${describeOp(op)}: ${identity} cannot be half-open while its trial is active`);
    }
  }

  const targetCircuit = getCircuitState(model.state, target, context.now, settings);
  if (op.op === "success") {
    assert.equal(targetCircuit.open, false, `${describeOp(op)}: success must close the circuit`);
    assert.equal(targetCircuit.halfOpen, false, `${describeOp(op)}: success must clear half-open recovery`);
    assert.equal(targetCircuit.trialActive, false, `${describeOp(op)}: success must end the trial`);
    assert.equal(targetCircuit.recentFailures, 0, `${describeOp(op)}: success must clear recorded failures`);
  }
  if (op.op === "abandonTrial") {
    assert.equal(targetCircuit.trialActive, false, `${describeOp(op)}: abandoning must end the trial`);
  }

  assert.equal(model.state.version, 1, `${describeOp(op)}: persisted state must stay on version 1`);
  const oldestCounted = context.now - config.windowMinutes * MINUTE_MS;
  // Only a failure or success on that same identity rewrites its record, so any
  // other record may still hold instants the window already stopped counting.
  const rewroteRecord = op.op === "fail" || op.op === "success";
  for (const [identity, record] of Object.entries(model.state.models)) {
    assert.ok((IDENTITIES as readonly string[]).includes(identity), `${describeOp(op)}: unexpected identity ${identity}`);
    assert.deepEqual(
      record.failures,
      [...record.failures].sort((left, right) => left - right),
      `${describeOp(op)}: ${identity} recorded failures out of order`,
    );
    for (const at of record.failures) {
      assert.ok(Number.isFinite(at) && at <= context.now, `${describeOp(op)}: ${identity} kept a future failure at ${at}`);
      if (rewroteRecord && identity === target) {
        assert.ok(at >= oldestCounted, `${describeOp(op)}: ${identity} kept a failure from outside the window at ${at}`);
      }
    }
    if (record.cooldownMultiplier !== undefined) {
      assert.equal(
        Math.log2(record.cooldownMultiplier) % 1,
        0,
        `${describeOp(op)}: ${identity} backoff must only ever double`,
      );
    }
  }

  // Restart deliberately replaces the whole state; every other operation must
  // leave every other identity untouched at the same clock reading.
  if (op.op !== "load") {
    const after = projections(model.state, before.now, config);
    for (const identity of IDENTITIES) {
      if (identity === target) continue;
      assert.deepEqual(after[identity], before.circuits[identity], `${describeOp(op)}: ${identity} changed without being targeted`);
    }
  }
}

function applyOp(op: Op, model: ScenarioModel, context: ScenarioContext): void {
  const { config, fault } = context;
  const settings = reliabilityConfig(config);
  const identity = IDENTITIES[op.identity];
  const before = baseline(model.state, context.now, config);

  switch (op.op) {
    case "advance":
      context.now += op.deltaMs;
      break;
    case "fail": {
      if (fault === "trialFailureSkipsBackoff" && getCircuitState(model.state, identity, context.now, settings).trialActive) {
        model.state = abandonTrial(model.state, identity);
      }
      if (fault === "failureLeaksToOtherIdentity") {
        model.state = recordModelFailure(model.state, NEIGHBOUR, settings, context.now, FAILURE_SOURCE, FAILURE_REASON);
      }
      model.state = recordModelFailure(model.state, identity, settings, context.now, FAILURE_SOURCE, FAILURE_REASON);
      context.reference.fail(identity, context.now);
      break;
    }
    case "success":
      if (fault !== "successIsIgnored") model.state = recordModelSuccess(model.state, identity, context.now, FAILURE_SOURCE);
      context.reference.success(identity);
      break;
    case "beginTrial":
      model.state = beginTrial(model.state, identity);
      context.reference.beginTrial(identity);
      break;
    case "abandonTrial":
      model.state = abandonTrial(model.state, identity);
      context.reference.abandonTrial(identity);
      break;
    case "circuit":
      break;
    case "save": {
      const persisted = fault === "saveDiscardsState" ? emptyReliabilityState() : model.state;
      assert.equal(saveReliability(context.path, persisted), true, `${describeOp(op)}: an uncontended save must succeed`);
      assert.equal(existsSync(reliabilitySourceFencePath(context.path)), false, `${describeOp(op)}: the source lock must be released`);
      assert.deepEqual(
        JSON.parse(readFileSync(context.path, "utf8")),
        JSON.parse(JSON.stringify(persisted)),
        `${describeOp(op)}: the persisted document must match the state handed to the store`,
      );
      context.persisted = context.reference.snapshot();
      break;
    }
    case "load":
      if (fault !== "loadKeepsMemory") model.state = loadReliability(context.path);
      context.reference.restore(context.persisted ?? new Map());
      break;
  }

  verify(op, model, context, before);
}

// ── Scenario runner ──────────────────────────────────────────────

function toCommand(op: Op): fc.Command<ScenarioModel, ScenarioContext> {
  return { check: () => true, run: applyOp.bind(null, op), toString: () => describeOp(op) };
}

/** Runs one generated sequence against the production circuit and the reference. */
function runScenario(config: ScenarioConfig, commands: Iterable<fc.Command<ScenarioModel, ScenarioContext>>, fault: Fault = "none"): void {
  const workspace = mkdtempSync(join(tmpdir(), "bifrost-reliability-fsm-"));
  try {
    const path = reliabilityPath(workspace);
    const context: ScenarioContext = {
      config,
      fault,
      path,
      reference: new Reference(config),
      now: ORIGIN,
      persisted: undefined,
    };
    fc.modelRun(() => ({ model: { state: emptyReliabilityState() }, real: context }), commands);
    assert.equal(existsSync(reliabilitySourceFencePath(path)), false, "the scenario must leave no reliability source lock behind");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runOps(config: ScenarioConfig, ops: readonly Op[], fault: Fault = "none"): void {
  runScenario(config, ops.map(toCommand), fault);
}

const IDENTITY_ARB = fc.integer({ min: 0, max: IDENTITIES.length - 1 });

function opArbitrary(name: OpName, deltas?: fc.Arbitrary<number>): fc.Arbitrary<fc.Command<ScenarioModel, ScenarioContext>> {
  return fc.tuple(fc.constant(name), IDENTITY_ARB, deltas ?? fc.constant(0)).map(([op, identity, deltaMs]) => toCommand({ op, identity, deltaMs }));
}

/** Every exact window and cooldown edge, so boundaries are reached by construction. */
function boundaryDeltas(config: ScenarioConfig): fc.Arbitrary<number> {
  const windowMs = config.windowMinutes * MINUTE_MS;
  const cooldownMs = config.cooldownMinutes * MINUTE_MS;
  return fc.constantFrom(
    0, 1, windowMs - 1, windowMs, windowMs + 1, cooldownMs - 1, cooldownMs, cooldownMs + 1, 2 * cooldownMs, 2 * cooldownMs + 1,
  );
}

const SCENARIO_OPS: readonly OpName[] = ["advance", "fail", "success", "beginTrial", "abandonTrial", "circuit", "save", "load"];

/** A fresh generator per run keeps fast-check's replay path independent. */
function scenarioArbitrary(deltas: fc.Arbitrary<number>, replayPath?: string): fc.Arbitrary<Iterable<fc.Command<ScenarioModel, ScenarioContext>>> {
  return fc.commands(
    SCENARIO_OPS.map((name) => opArbitrary(name, name === "advance" ? deltas : undefined)),
    { maxCommands: 20, ...(replayPath ? { replayPath } : {}) },
  );
}

function scenarioProperty(config: ScenarioConfig, fault: Fault = "none", replayPath?: string): fc.IProperty<[Iterable<fc.Command<ScenarioModel, ScenarioContext>>]> {
  return fc.property(scenarioArbitrary(boundaryDeltas(DOCUMENTED_DEFAULTS), replayPath), (commands) => runScenario(config, commands, fault));
}

// ── Tests ────────────────────────────────────────────────────────

/** Pinned seeds keep every reported counterexample replayable. */
const SEQUENCE_SEED = 20260101;
const SWEEP_SEED = 20260102;
const FAULT_SEED = 20260103;

describe("reliability state machine", () => {
  it("matches the reference circuit across generated operation sequences", () => {
    fc.assert(scenarioProperty(DOCUMENTED_DEFAULTS), { seed: SEQUENCE_SEED, numRuns: 200 });
  });

  it("matches the reference circuit across generated reliability configurations", () => {
    // Whole-minute clock steps keep every generated window and cooldown edge exact.
    const minuteStep = fc.integer({ min: 0, max: 130 }).map((minutes) => minutes * MINUTE_MS);
    const configArbitrary = fc.record({
      enabled: fc.boolean(),
      failureThreshold: fc.constantFrom(1, 2, 3, 4),
      windowMinutes: fc.constantFrom(1, 2, 5),
      cooldownMinutes: fc.constantFrom(1, 5, 60),
    });
    fc.assert(fc.property(configArbitrary, scenarioArbitrary(minuteStep), (config, generated) => {
      runScenario(config, generated);
    }), { seed: SWEEP_SEED, numRuns: 150 });
  });

  it("keeps exact window and cooldown boundaries", () => {
    const identity = IDENTITIES[0];
    const settings = reliabilityConfig(IMMEDIATE);

    // A failure recorded at the clock edge is still inside the window at the
    // exact edge, and only ages out one millisecond later.
    let state = recordModelFailure(emptyReliabilityState(), identity, settings, ORIGIN, FAILURE_SOURCE, FAILURE_REASON);
    const windowMs = IMMEDIATE.windowMinutes * MINUTE_MS;
    assert.equal(getCircuitState(state, identity, ORIGIN + windowMs - 1, settings).recentFailures, 1);
    assert.equal(getCircuitState(state, identity, ORIGIN + windowMs, settings).recentFailures, 1);
    assert.equal(getCircuitState(state, identity, ORIGIN + windowMs + 1, settings).recentFailures, 0);

    // The cooldown ends at its own edge: still open one millisecond before,
    // half-open exactly at it.
    const cooldownMs = IMMEDIATE.cooldownMinutes * MINUTE_MS;
    assert.equal(getCircuitState(state, identity, ORIGIN + cooldownMs - 1, settings).open, true);
    const expired = getCircuitState(state, identity, ORIGIN + cooldownMs, settings);
    assert.equal(expired.open, false);
    assert.equal(expired.halfOpen, true);

    // A failed trial doubles the cooldown from the failure instant.
    const reopened = recordModelFailure(beginTrial(state, identity), identity, settings, ORIGIN + cooldownMs, "trial", FAILURE_REASON);
    assert.equal(getCircuitState(reopened, identity, ORIGIN + cooldownMs, settings).openUntil, ORIGIN + cooldownMs + 2 * cooldownMs);
    assert.equal(getCircuitState(reopened, identity, ORIGIN + cooldownMs + 2 * cooldownMs - 1, settings).open, true);
    assert.equal(getCircuitState(reopened, identity, ORIGIN + cooldownMs + 2 * cooldownMs, settings).halfOpen, true);
  });

  it("restores an open circuit and an active trial across a restart", () => {
    const identity = IDENTITIES[0];
    const workspace = mkdtempSync(join(tmpdir(), "bifrost-reliability-restart-"));
    try {
      const path = reliabilityPath(workspace);
      const settings = reliabilityConfig(IMMEDIATE);
      let state = recordModelFailure(emptyReliabilityState(), identity, settings, ORIGIN, FAILURE_SOURCE, FAILURE_REASON);
      const openUntil = state.models[identity]!.openUntil!;
      assert.equal(saveReliability(path, state), true);

      let restarted = loadReliability(path);
      assert.equal(getCircuitState(restarted, identity, ORIGIN, settings).open, true, "an open circuit must survive a restart");
      assert.equal(getCircuitState(restarted, identity, openUntil, settings).halfOpen, true, "a restarted circuit must still reach half-open");

      state = beginTrial(state, identity);
      assert.equal(saveReliability(path, state), true);
      restarted = loadReliability(path);
      assert.equal(getCircuitState(restarted, identity, openUntil, settings).trialActive, true, "an active trial must survive a restart");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("isolates persisted stores from each other", () => {
    const first = mkdtempSync(join(tmpdir(), "bifrost-reliability-store-a-"));
    const second = mkdtempSync(join(tmpdir(), "bifrost-reliability-store-b-"));
    try {
      const identity = IDENTITIES[0];
      const settings = reliabilityConfig(IMMEDIATE);
      const pathA = reliabilityPath(first);
      const pathB = reliabilityPath(second);
      let stateA = recordModelFailure(emptyReliabilityState(), identity, settings, ORIGIN, FAILURE_SOURCE, FAILURE_REASON);
      const stateB = recordModelFailure(emptyReliabilityState(), identity, settings, ORIGIN, FAILURE_SOURCE, FAILURE_REASON);

      // One store records a success the other never sees.
      stateA = recordModelSuccess(stateA, identity, ORIGIN + MINUTE_MS, FAILURE_SOURCE);
      assert.equal(saveReliability(pathA, stateA), true);
      assert.equal(saveReliability(pathB, stateB), true);

      assert.equal(getCircuitState(loadReliability(pathA), identity, ORIGIN, settings).open, false, "the recovered store must stay closed");
      assert.equal(getCircuitState(loadReliability(pathB), identity, ORIGIN, settings).open, true, "the untouched store must keep its circuit");
      assert.equal(existsSync(reliabilitySourceFencePath(pathA)), false, "the first store must release its lock");
      assert.equal(existsSync(reliabilitySourceFencePath(pathB)), false, "the second store must release its lock");
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  describe("controlled fault sensitivity", () => {
    const failOp = (identity = 0, deltaMs = 0): Op => ({ op: "fail", identity, deltaMs });
    const advanceOp = (deltaMs: number, identity = 0): Op => ({ op: "advance", identity, deltaMs });
    const openCircuit: readonly Op[] = [failOp()];
    const openThenRecover: readonly Op[] = [failOp(), advanceOp(IMMEDIATE.cooldownMinutes * MINUTE_MS), { op: "beginTrial", identity: 0, deltaMs: 0 }, failOp()];
    // Restart must bring back the persisted circuit, not the newer in-memory one.
    const savedThenRestarted: readonly Op[] = [failOp(), { op: "save", identity: 0, deltaMs: 0 }, { op: "success", identity: 0, deltaMs: 0 }, { op: "load", identity: 0, deltaMs: 0 }];

    const faults: readonly { name: Fault; ops: readonly Op[] }[] = [
      { name: "successIsIgnored", ops: openCircuit.concat({ op: "success", identity: 0, deltaMs: 0 }) },
      { name: "trialFailureSkipsBackoff", ops: openThenRecover },
      { name: "failureLeaksToOtherIdentity", ops: openCircuit },
      { name: "saveDiscardsState", ops: savedThenRestarted },
      { name: "loadKeepsMemory", ops: savedThenRestarted },
    ];

    for (const { name, ops } of faults) {
      it(`rejects a circuit that ${name}`, () => {
        // The same sequence is legitimate for the real circuit, so a rejection
        // can only come from the injected fault.
        assert.doesNotThrow(() => runOps(IMMEDIATE, ops), `sequence rejected by the production circuit for ${name}`);
        assert.throws(() => runOps(IMMEDIATE, ops, name), assert.AssertionError, `controlled fault ${name} went undetected`);
      });
    }

    it("shrinks and replays a controlled fault to a minimal sequence", () => {
      const faultProperty = scenarioProperty(IMMEDIATE, "trialFailureSkipsBackoff");
      const rejected = fc.check(faultProperty, { seed: FAULT_SEED, numRuns: 250 });
      assert.equal(rejected.failed, true, "a trial failure that skips the backoff must be rejected");
      assert.ok(rejected.numShrinks > 0, "the failing sequence must shrink");
      assert.ok((rejected.counterexamplePath ?? "").length > 0, "a rejected fault must report a replay path");
      const replayPath = String(rejected.counterexample?.[0]).match(/replayPath="([^"]+)"/)?.[1];
      assert.ok(replayPath, "generated commands must expose their command-filter replay log");

      // Command shrinking drops commands after modelRun execution filters them.
      // Replay both fast-check's seed/path and the command arbitrary's replay log.
      const operations = (details: {
        counterexample: readonly [Iterable<fc.Command<ScenarioModel, ScenarioContext>>] | null;
      }): string[] => (details.counterexample === null ? [] : [...details.counterexample[0]].map((command) => String(command)));
      let replay;
      try {
        replay = fc.check(scenarioProperty(IMMEDIATE, "trialFailureSkipsBackoff", replayPath), {
          seed: rejected.seed,
          path: rejected.counterexamplePath ?? undefined,
          numRuns: 250,
        });
      } catch (error) {
        assert.fail(`seed=${rejected.seed} path=${rejected.counterexamplePath} runs=${rejected.numRuns}: ${(error as Error).message}`);
      }
      assert.equal(replay!.failed, true);
      assert.equal(replay!.counterexamplePath, rejected.counterexamplePath);
      assert.deepEqual(operations(replay!), operations(rejected), "reported seed and path must replay the same shrunk operation sequence");
    });

    it("shrinks a controlled fault to the shortest reproducing prefix", () => {
      const noise: readonly Op[] = [
        { op: "advance", identity: 2, deltaMs: 1 },
        { op: "circuit", identity: 1, deltaMs: 0 },
        { op: "success", identity: 2, deltaMs: 0 },
        { op: "save", identity: 1, deltaMs: 0 },
        { op: "load", identity: 1, deltaMs: 0 },
        { op: "abandonTrial", identity: 0, deltaMs: 0 },
      ];
      const padded = [...noise, ...openThenRecover, ...noise];
      const diagnostic = (ops: readonly Op[]): string => {
        try {
          runOps(IMMEDIATE, ops, "trialFailureSkipsBackoff");
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      };
      assert.match(diagnostic(padded), /circuit diverged/, "the padded sequence must fail the reference comparison");

      let shortest = -1;
      for (let length = 1; length <= padded.length; length += 1) {
        if (diagnostic(padded.slice(0, length)).length > 0) {
          shortest = length;
          break;
        }
      }
      assert.ok(
        shortest > openThenRecover.length,
        `the shortest reproducing prefix must drop the padding, got ${shortest} operations`,
      );

      const first = diagnostic(padded);
      assert.equal(diagnostic(padded), first, "the same sequence must replay to the same diagnostic");
    });
  });
});