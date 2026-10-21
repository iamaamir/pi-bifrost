import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { makeModel } from "./helpers.ts";

describe("invalid classifier deadline at the registered input hook", () => {
  it("keeps local default routing available without launching a classifier request", async () => {
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-invalid-deadline-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({
      enabled: true,
      default: "quick",
      strategy: "first",
      classifier: {
        enabled: true,
        backend: "prompt",
        model: "fixture/classifier",
        totalTimeoutMs: { private: "bad value" },
      },
      models: { quick: ["fixture/target"] },
      rules: [],
    }));
    process.chdir(cwd);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const target = makeModel("fixture", "target");
    const classifierModel = makeModel("fixture", "classifier");
    const available: Model<Api>[] = [target, classifierModel];
    const selected: string[] = [];
    let classifierRequests = 0;
    let input: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
    const active = makeModel("fixture", "active");
    const ctx = {
      cwd,
      mode: "rpc",
      hasUI: false,
      model: active,
      modelRegistry: {
        getAvailable: () => available,
        find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
        getProviderAuthStatus: () => ({ configured: false }),
        getAvailableOfType: async () => [],
        refresh: async () => ({ refreshed: [], errors: [] }),
        streamSimple: async () => { classifierRequests++; throw new Error("unexpected classifier request"); },
      },
      sessionManager: { getBranch: () => [] },
      ui: {},
    } as unknown as ExtensionContext;
    const pi = {
      registerVirtualModel: () => {},
      registerCommand: () => {},
      on: (event: string, handler: typeof input) => { if (event === "input") input = handler; return () => {}; },
      setModel: async (model: Model<Api>) => { selected.push(`${model.provider}/${model.id}`); return true; },
    } as unknown as ExtensionAPI;

    try {
      bifrostExtension(pi);
      assert.ok(input);
      const result = await input({ text: "do the task", source: "interactive", streamingBehavior: "steer" }, ctx);
      assert.deepEqual(result, { action: "continue" });
      assert.deepEqual(selected, ["fixture/target"]);
      assert.equal(classifierRequests, 0);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
