import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  setBifrostStatus,
  setBifrostWorkingMessage,
  shouldRefreshRegistry,
  type RegistryRefreshState,
} from "../ux-status.ts";

function makeCtx() {
  const calls: Array<{ kind: string; key?: string; value?: unknown }> = [];
  return {
    calls,
    ctx: {
      hasUI: true,
      ui: {
        theme: {
          fg: (_: string, text: string) => text,
        },
        setStatus: (key?: string, value?: string) => {
          calls.push({ kind: "status", key, value });
        },
        setWorkingMessage: (value?: string) => {
          calls.push({ kind: "working", key: "working", value });
        },
      },
    },
  } as const;
}

describe("ux status helpers", () => {
  it("renders Bifrost status line", () => {
    const { ctx, calls } = makeCtx();
    setBifrostStatus(ctx as never, "classifying prompt…", "accent");
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-routing");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · classifying prompt/);
  });

  it("clears Bifrost status line", () => {
    const { ctx, calls } = makeCtx();
    setBifrostStatus(ctx as never, undefined);
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-routing");
    assert.equal(calls[0]?.value, undefined);
  });

  it("sets working message", () => {
    const { ctx, calls } = makeCtx();
    setBifrostWorkingMessage(ctx as never, "Bifrost classifying...");
    assert.equal(calls[0]?.kind, "working");
    assert.equal(calls[0]?.value, "Bifrost classifying...");
  });

  it("refreshes when there is no prior refresh", () => {
    const state: RegistryRefreshState = {};
    assert.equal(shouldRefreshRegistry(state, 1_000, 30_000), true);
  });

  it("skips refresh within ttl", () => {
    const state: RegistryRefreshState = { lastRegistryRefreshAt: 1_000 };
    assert.equal(shouldRefreshRegistry(state, 20_000, 30_000), false);
  });

  it("refreshes after ttl expires", () => {
    const state: RegistryRefreshState = { lastRegistryRefreshAt: 1_000 };
    assert.equal(shouldRefreshRegistry(state, 40_000, 30_000), true);
  });

  it("forces refresh after explicit miss", () => {
    const state: RegistryRefreshState = {
      lastRegistryRefreshAt: 20_000,
      forceRegistryRefresh: true,
    };
    assert.equal(shouldRefreshRegistry(state, 21_000, 30_000), true);
  });
});
