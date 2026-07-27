import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  setBifrostStatus,
  setBifrostWorkingMessage,
  setBifrostModeStatus,
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
        setFooter: (value?: unknown) => {
          calls.push({ kind: "footer", key: "footer", value });
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
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.match(String(calls[0]?.value ?? ""), /Bifrost · classifying prompt/);
  });

  it("clears Bifrost status line", () => {
    const { ctx, calls } = makeCtx();
    setBifrostStatus(ctx as never, undefined);
    assert.equal(calls[0]?.kind, "status");
    assert.equal(calls[0]?.key, "bifrost-state");
    assert.equal(calls[0]?.value, undefined);
  });

  it("sets working message", () => {
    const { ctx, calls } = makeCtx();
    setBifrostWorkingMessage(ctx as never, "Bifrost classifying...");
    assert.equal(calls[0]?.kind, "working");
    assert.equal(calls[0]?.value, "Bifrost classifying...");
  });

  it("renders persistent mode state", () => {
    const { ctx, calls } = makeCtx();
    setBifrostModeStatus(ctx as never, { enabled: true, pinned: false, classifierEnabled: true });
    assert.equal(calls[0]?.kind, "footer");
    const footerFactory = calls[0]?.value as ((tui: any, theme: any, footerData: any) => { render(width: number): string[] });
    const footer = footerFactory(
      { requestRender() {} },
      { fg: (_: string, text: string) => text },
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 0,
        onBranchChange: () => () => {},
      },
    );
    assert.match(footer.render(120)[0] ?? "", /Bifrost · on/);
    assert.match(footer.render(120)[0] ?? "", /current=/);

    calls.length = 0;
    setBifrostModeStatus(ctx as never, { enabled: false, pinned: false, classifierEnabled: true });
    const footerFactory2 = calls[0]?.value as typeof footerFactory;
    const footer2 = footerFactory2(
      { requestRender() {} },
      { fg: (_: string, text: string) => text },
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 0,
        onBranchChange: () => () => {},
      },
    );
    assert.match(footer2.render(120)[0] ?? "", /Bifrost · off/);

    calls.length = 0;
    setBifrostModeStatus(ctx as never, { enabled: true, pinned: true, classifierEnabled: true });
    const footerFactory3 = calls[0]?.value as typeof footerFactory;
    const footer3 = footerFactory3(
      { requestRender() {} },
      { fg: (_: string, text: string) => text },
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 0,
        onBranchChange: () => () => {},
      },
    );
    assert.match(footer3.render(120)[0] ?? "", /Bifrost · pinned/);
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
