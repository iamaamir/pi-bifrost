// ── Reliability settlement lifecycle regression ──────────────────
// Drives the real extension handlers (index.ts) through the event
// sequences that end a routed run. The invariant under test:
//
//   one logical completed run = exactly one settlement
//                             = at most one reliability state update
//
// Pi settles from `agent_settled`; omp never emits it and settles from a
// terminal `agent_end` (omp marks a still-continuing end with
// `willContinue: true`).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bifrostExtension from "../index.ts";
import { CONFIG_DIR_NAME } from "../host.ts";
import { makeModel } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The model this fixture config routes to. */
const ROUTED_PROVIDER = "fixture";
const ROUTED_ID = "alpha";
const ROUTED_KEY = `${ROUTED_PROVIDER}/${ROUTED_ID}`;

const FAILURE_LOG_FRAGMENT = "recorded provider failure";

interface Harness {
  /** Send a prompt through the real `input` handler (starts a routed run). */
  prompt(): Promise<unknown>;
  emit(event: string, payload: unknown): Promise<unknown>;
  /** Settlements that reached the reliability store for the routed model. */
  settledFailures(): number;
  /** Settlement log lines (one per recorded settlement with a reason). */
  settlementLogs(): number;
  setModelCalls(): number;
  cleanup(): void;
}

/** An assistant message that reports a provider failure for the routed model. */
function assistantFailure() {
  return {
    role: "assistant",
    provider: ROUTED_PROVIDER,
    model: ROUTED_ID,
    stopReason: "error",
    errorMessage: "provider request failed",
  };
}

function boot(host: "pi" | "omp"): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-lifecycle-"));

  // Config layers: the repo's bifrost.json is merged as the extension-dir
  // default, so the tier name and failure threshold are set explicitly here.
  const configJson = JSON.stringify({
    enabled: true,
    default: "smoke",
    classifier: { enabled: false },
    models: { smoke: [ROUTED_KEY] },
    reliability: { enabled: true, failureThreshold: 10, windowMinutes: 5, cooldownMinutes: 60 },
  });
  writeFileSync(join(cwd, "bifrost.json"), configJson);
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "bifrost.json"), configJson);

  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // Isolate the global config layer so a developer's own bifrost.json
  // cannot leak into the fixture.
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  process.chdir(cwd);

  const handlers = new Map<string, Handler[]>();
  const routed = makeModel(ROUTED_PROVIDER, ROUTED_ID);
  const active = makeModel("fixture", "current");
  const registry = {
    getAvailable: () => [routed],
    find: (provider: string, id: string) =>
      provider === routed.provider && id === routed.id ? routed : undefined,
  };
  const ctx = {
    hasUI: false,
    mode: "print",
    model: active,
    modelRegistry: registry,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWidget: () => {},
      notify: () => {},
      setEditorText: () => {},
    },
  };

  let setModelCalls = 0;
  const pi = {
    // omp's ExtensionAPI injects `zod`; Pi's does not (host detection).
    ...(host === "omp" ? { zod: {} } : {}),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event);
      if (list) list.push(handler);
      else handlers.set(event, [handler]);
    },
    registerCommand: () => {},
    setModel: async () => {
      setModelCalls += 1;
      return true;
    },
  };

  bifrostExtension(pi as never);

  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };

  const reliabilityFile = join(cwd, CONFIG_DIR_NAME, "bifrost-reliability.json");

  // Returns the last handler result so `input` results can be asserted.
  const emit = async (event: string, payload: unknown): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };

  return {
    prompt: () => emit("input", { type: "input", text: "smoke hello", source: "user" }),
    emit,
    settledFailures: () => {
      if (!existsSync(reliabilityFile)) return 0;
      const state = JSON.parse(readFileSync(reliabilityFile, "utf-8")) as {
        models?: Record<string, { failures?: unknown[] }>;
      };
      return state.models?.[ROUTED_KEY]?.failures?.length ?? 0;
    },
    settlementLogs: () => logs.filter((line) => line.includes(FAILURE_LOG_FRAGMENT)).length,
    setModelCalls: () => setModelCalls,
    cleanup: () => {
      console.error = originalError;
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Run a routed prompt: the precondition for a settleable run. */
async function startRun(harness: Harness): Promise<void> {
  const before = harness.setModelCalls();
  await harness.prompt();
  assert.equal(harness.setModelCalls(), before + 1, "fixture must route (begin) the run");
}

describe("agent_end reliability settlement", () => {
  it("Case A: an omp completion without continuation settles exactly once", async () => {
    const harness = boot("omp");
    try {
      const result = await harness.prompt();
      // omp input results replace text instead of using Pi's { action }.
      assert.deepEqual(result, { text: "hello" });
      assert.equal(harness.setModelCalls(), 1);

      await harness.emit("agent_end", { type: "agent_end", messages: [assistantFailure()] });

      assert.equal(harness.settledFailures(), 1);
      assert.equal(harness.settlementLogs(), 1);
    } finally {
      harness.cleanup();
    }
  });

  it("Case B: an omp continuation does not settle; the terminal end settles once", async () => {
    const harness = boot("omp");
    try {
      await startRun(harness);

      await harness.emit("agent_end", {
        type: "agent_end",
        willContinue: true,
        messages: [assistantFailure()],
      });
      assert.equal(harness.settledFailures(), 0, "non-terminal agent_end must not settle");
      assert.equal(harness.settlementLogs(), 0);

      await harness.emit("agent_end", {
        type: "agent_end",
        willContinue: false,
        messages: [assistantFailure()],
      });
      assert.equal(harness.settledFailures(), 1);
      assert.equal(harness.settlementLogs(), 1);
    } finally {
      harness.cleanup();
    }
  });

  it("Case C: a continuation leaves no stale state for the next run", async () => {
    const harness = boot("omp");
    try {
      // Run A: continuation, then the terminal end.
      await startRun(harness);
      await harness.emit("agent_end", {
        type: "agent_end",
        willContinue: true,
        messages: [assistantFailure()],
      });
      await harness.emit("agent_end", { type: "agent_end", messages: [assistantFailure()] });
      assert.equal(harness.settledFailures(), 1, "run A must settle exactly once");

      // Run B: an independent request after the continuation.
      await startRun(harness);
      await harness.emit("agent_end", { type: "agent_end", messages: [assistantFailure()] });
      assert.equal(harness.settledFailures(), 2, "run B must settle exactly once");

      // A stray terminal end with no run in flight must not record anything.
      await harness.emit("agent_end", { type: "agent_end", messages: [assistantFailure()] });
      assert.equal(harness.settledFailures(), 2);
      assert.equal(harness.settlementLogs(), 2);
    } finally {
      harness.cleanup();
    }
  });

  it("Case D: Pi keeps settling from agent_settled, not agent_end", async () => {
    const harness = boot("pi");
    try {
      const result = await harness.prompt();
      // Pi input results keep the { action } shape.
      assert.deepEqual(result, { action: "transform", text: "hello" });
      assert.equal(harness.setModelCalls(), 1);

      // Pi's AgentEndEvent has no willContinue field; an extra one must not
      // change Pi behavior either.
      await harness.emit("agent_end", {
        type: "agent_end",
        willContinue: true,
        messages: [assistantFailure()],
      });
      await harness.emit("agent_end", { type: "agent_end", messages: [assistantFailure()] });
      assert.equal(harness.settledFailures(), 0, "Pi must not settle from agent_end");

      await harness.emit("agent_settled", { type: "agent_settled" });
      assert.equal(harness.settledFailures(), 1);
      assert.equal(harness.settlementLogs(), 1);
    } finally {
      harness.cleanup();
    }
  });
});
