import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVirtualRoute, noModelError, poolProblem } from "../virtual-routing.ts";
import { VirtualOverride } from "../virtual-override.ts";
import { makeModel } from "./helpers.ts";

const first = makeModel("fixture", "fast");
const second = makeModel("fixture", "strong");
const user = (text: string) => [{ role: "user", content: [{ type: "text", text }] }];
const request = (reason: string, text: string, extra: object = {}) => ({ reason, messages: user(text), thinkingLevel: "low", ...extra });

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
      /all excluded: x\/y \(open_circuit\)/,
    );
  });

  it("distinguishes a configured pool that resolved no available model", () => {
    const message = noModelError("general", ["openai-codex/gpt-5.6-luna"], "requested_tier_unavailable");
    assert.match(message, /pool \[openai-codex\/gpt-5\.6-luna\] resolved 0 available models/);
    assert.match(message, /credentials/);
  });

  it("dispatches a thinking level the physical model actually supports", async () => {
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
    assert.equal((await routes[0](request("user", "prompt", { thinkingLevel: "low" }) as never)).thinkingLevel, "off");
    assert.equal((await routes[1](request("user", "prompt", { thinkingLevel: "medium" }) as never)).thinkingLevel, "high");
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
    }) as never);
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
    await assert.rejects(() => route(request("user", "prompt") as never), /bookkeeping failed/);
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
    const result = await route(request("user", "prompt") as never);
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
    await assert.rejects(() => route(request("user", "prompt") as never), /custom: no healthy physical model/);
  });
});

describe("virtual Bifrost requests", () => {
  it("selects on user request using stripped prompt and forced tier", async () => {
    const { route, overrides, calls } = setup();
    overrides.prepare("frontier", "debug race");
    const result = await route(request("user", "debug race") as never);
    assert.equal(result.model, second);
    assert.deepEqual(calls, ["frontier:debug race"]);
  });

  it("keeps physical model and thinking level for tool continuation and retry", async () => {
    const { route, calls } = setup();
    const stickyModel = Object.assign(makeModel("fixture", "sticky-strong"), { reasoning: true });
    const sticky = { model: stickyModel, thinkingLevel: "high" as const };
    const continued = await route(request("continuation", "debug race", { previous: sticky }) as never);
    const retried = await route(request("retry", "debug race", { failed: { ...sticky, message: { stopReason: "error" } } }) as never);
    assert.deepEqual([continued.model, retried.model], [stickyModel, stickyModel]);
    assert.deepEqual([continued.thinkingLevel, retried.thinkingLevel], ["high", "high"]);
    assert.deepEqual(calls, []);
  });

  it("does not classify direct requests, and fails closed without an available fallback", async () => {
    const { route, calls } = setup();
    assert.equal((await route(request("direct", "summary") as never)).model, first);
    assert.deepEqual(calls, []);
    const noFallback = createVirtualRoute({ overrides: new VirtualOverride(), select: async () => undefined, fallback: () => undefined });
    await assert.rejects(() => noFallback(request("user", "prompt") as never), /no healthy physical model/);
  });
});
