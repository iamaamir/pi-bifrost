import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVirtualRoute, dispatchTrialPolicy, noModelError, poolProblem } from "../virtual-routing.ts";
import { VirtualOverride } from "../virtual-override.ts";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { errorMessage, makeModel } from "./helpers.ts";

const first = makeModel("fixture", "fast");
const second = makeModel("fixture", "strong");
const user = (text: string) => [{ role: "user", content: [{ type: "text", text }] }];
// One documented cast pair at the fixture seam; call sites now typecheck
// against ModelRouteRequest, so fixture drift fails the build.
const virtualModel = { ...makeModel("bifrost", "auto"), api: "pi-virtual" } as unknown as ModelRouteRequest["model"];
const request = (reason: ModelRouteRequest["reason"], text: string, extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest => ({
  model: virtualModel,
  thinkingLevel: "low",
  reason,
  messages: user(text) as unknown as ModelRouteRequest["messages"],
  ...extra,
});

function setup() {
  const overrides = new VirtualOverride();
  const calls: string[] = [];
  const route = createVirtualRoute({
    overrides,
    select: async (prompt, tier) => {
      calls.push(`${tier ?? "classify"}:${prompt}`);
      return tier === "frontier" ? second : first;
    },
    fallback: () => first,
  });
  return { route, overrides, calls };
}

describe("virtual fail-closed errors", () => {
  it("tells the user an empty pool needs configured models", () => {
    const message = noModelError("general", [], "requested_tier_unavailable");
    assert.match(message, /0 models configured for "general"/);
    assert.match(message, /bifrost init/);
    assert.match(poolProblem("general", undefined), /0 models configured/);
    assert.match(poolProblem("general", ["x/y"]), /resolved 0 available models/);
    assert.match(
      poolProblem("general", ["x/y"], [{ key: "x/y", reason: "open_circuit" }]),
      /all excluded: x\/y \(open circuit\)/,
    );
  });

  it("distinguishes a configured pool that resolved no available model", () => {
    const message = noModelError("general", ["openai-codex/gpt-5.6-luna"], "requested_tier_unavailable");
    assert.match(message, /pool \[openai-codex\/gpt-5\.6-luna\] resolved 0 available models/);
    assert.match(message, /credentials/);
  });

  it("explains reserve-excluded candidates without calling them unavailable", () => {
    const message = noModelError("restricted", ["fixture/reserved"], "requested_tier_excluded", undefined, { count: 1, reasonCodes: ["reserve_reached"] });
    assert.match(message, /no eligible physical model/);
    assert.match(message, /reserve policy exclusion\): reserve policy excluded 1 configured candidate\(s\) \(reasons: reserve_reached\)/);
    assert.doesNotMatch(message, /resolved 0 available models|credentials/);
  });

  it("shows reserve and reliability exclusions together for mixed blocked pools", () => {
    for (const reason of ["open_circuit", "trial_active"] as const) {
      const message = noModelError("restricted", ["fixture/reserved", "fixture/blocked"], "all_tiers_exhausted", [
        { key: "fixture/blocked", reason },
      ], { count: 1, reasonCodes: ["reserve_reached"] });
      assert.match(message, /reserve policy excluded 1 configured candidate\(s\) \(reasons: reserve_reached\)/u);
      assert.match(message, reason === "open_circuit" ? /fixture\/blocked \(open circuit\)/u : /fixture\/blocked \(trial in progress\)/u);
    }
  });

  it("delegates dispatch thinking level to pi-ai clampThinkingLevel", async () => {
    const nonReasoning = Object.assign(makeModel("fixture", "plain"), { reasoning: false });
    const limited = Object.assign(makeModel("fixture", "limited"), {
      reasoning: true,
      thinkingLevelMap: { medium: null },
    });
    const routes = [nonReasoning, limited].map((model) => createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => model,
      fallback: () => undefined,
    }));
    assert.equal((await routes[0](request("user", "prompt", { thinkingLevel: "low" }))).thinkingLevel, "off");
    assert.equal((await routes[1](request("user", "prompt", { thinkingLevel: "medium" }))).thinkingLevel, "high");
  });

  it("clamps a sticky level that the physical model does not support", async () => {
    const nonReasoning = Object.assign(makeModel("fixture", "plain"), { reasoning: false });
    const route = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => undefined,
      fallback: () => undefined,
    });
    const result = await route(request("continuation", "prompt", {
      previous: { model: nonReasoning, thinkingLevel: "high" },
    }));
    assert.equal(result.thinkingLevel, "off");
  });

  it("releases the dispatched model when dispatch bookkeeping throws", async () => {
    let released: unknown;
    const route = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => first,
      fallback: () => undefined,
      onDispatch: () => { throw new Error("bookkeeping failed"); },
      onDispatchFailed: (model) => { released = model; },
    });
    await assert.rejects(() => route(request("user", "prompt")), /bookkeeping failed/);
    assert.equal(released, first);
  });

  it("keeps the last dispatched model with a notice when no pool resolves", async () => {
    let degraded: unknown;
    const route = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => undefined,
      fallback: () => undefined,
      sticky: () => second,
      onDegrade: (model) => { degraded = model; },
    });
    const result = await route(request("user", "prompt"));
    assert.equal(result.model, second);
    assert.equal(degraded, second);
  });

  it("uses a custom error factory when the host provides one", async () => {
    const route = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => undefined,
      fallback: () => undefined,
      routeError: (detail) => new Error(`custom: ${detail}`),
    });
    await assert.rejects(() => route(request("user", "prompt")), /custom: no healthy physical model/);
  });
});

describe("virtual Bifrost requests", () => {
  it("selects on user request using stripped prompt and forced tier", async () => {
    const { route, overrides, calls } = setup();
    overrides.prepare("frontier", "debug race");
    const result = await route(request("user", "debug race"));
    assert.equal(result.model, second);
    assert.deepEqual(calls, ["frontier:debug race"]);
  });

  it("keeps physical model and thinking level for tool continuation and retry", async () => {
    const { route, calls } = setup();
    const stickyModel = Object.assign(makeModel("fixture", "sticky-strong"), { reasoning: true });
    const sticky = { model: stickyModel, thinkingLevel: "high" as const };
    const continued = await route(request("continuation", "debug race", { previous: sticky }));
    const retried = await route(request("retry", "debug race", { failed: { ...sticky, message: errorMessage() } }));
    assert.deepEqual([continued.model, retried.model], [stickyModel, stickyModel]);
    assert.deepEqual([continued.thinkingLevel, retried.thinkingLevel], ["high", "high"]);
    assert.deepEqual(calls, []);
  });

  it("does not classify direct requests, and fails closed without an available fallback", async () => {
    const { route, calls } = setup();
    assert.equal((await route(request("direct", "summary"))).model, first);
    assert.deepEqual(calls, []);
    const noFallback = createVirtualRoute({ overrides: new VirtualOverride(), select: async () => undefined, fallback: () => undefined });
    await assert.rejects(() => noFallback(request("user", "prompt")), /no healthy physical model/);
  });

  it("trial contention is fail-closed only for explicit selection", () => {
    assert.equal(dispatchTrialPolicy("select"), "fail-closed");
    assert.equal(dispatchTrialPolicy("sticky"), "continuity");
    assert.equal(dispatchTrialPolicy("degrade"), "continuity");
  });

  it("tags every dispatch intent: select, sticky, and degrade", async () => {
    const intents: string[] = [];
    const plain = Object.assign(makeModel("fixture", "plain"), { reasoning: false });
    const stickyModel = Object.assign(makeModel("fixture", "sticky"), { reasoning: false });
    const level = "off" as const;
    const route = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => plain,
      fallback: () => undefined,
      onDispatch: (_model, _thinkingLevel, intent) => intents.push(intent),
    });
    await route(request("user", "prompt"));
    await route(request("continuation", "prompt", { previous: { model: stickyModel, thinkingLevel: level } }));
    await route(request("retry", "prompt", { failed: { model: stickyModel, thinkingLevel: level, message: errorMessage() } }));
    const degrading = createVirtualRoute({
      overrides: new VirtualOverride(),
      select: async () => undefined,
      fallback: () => undefined,
      sticky: () => stickyModel,
      onDispatch: (_model, _thinkingLevel, intent) => intents.push(intent),
    });
    await degrading(request("user", "prompt"));
    assert.deepEqual(intents, ["select", "sticky", "sticky", "degrade"]);
  });

  it("routes without a forced tier and never throws when prepared text does not match the dispatched prompt", async () => {
    const { route, overrides, calls } = setup();
    overrides.prepare("frontier", "frontier hello");
    const result = await route(request("user", "unrelated pasted text"));
    assert.equal(result.model, first);
    assert.deepEqual(calls, ["classify:unrelated pasted text"]);
  });
});
