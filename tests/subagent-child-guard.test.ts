import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Deterministic coverage for the subagent child guard in the `input` hook:
 * a process marked PI_SUBAGENT_CHILD keeps the model its parent pinned
 * (no classification, no model switch), while an unmarked parent turn
 * routes normally. No live provider is involved.
 */

interface FakeModel {
  provider: string;
  id: string;
  api: string;
  contextWindow: number;
}

const PINNED_MODEL: FakeModel = { provider: "provider-x", id: "test-model", api: "openai-completions", contextWindow: 128_000 };
const PARENT_MODEL: FakeModel = { provider: "provider-parent", id: "current", api: "openai-completions", contextWindow: 128_000 };

function fakeCtx(model: FakeModel) {
  return {
    mode: "print" as const,
    hasUI: false,
    sessionManager: {},
    model,
    thinkingLevel: "medium" as const,
    modelRegistry: {
      find: (_provider: string, id: string) => (id === PINNED_MODEL.id ? PINNED_MODEL : undefined),
      getAvailable: () => [PINNED_MODEL],
    },
  };
}

function makeFakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
  const setModelCalls: FakeModel[] = [];
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    setModel: async (model: FakeModel) => {
      setModelCalls.push(model);
      return true;
    },
    setThinkingLevel: () => {},
    setStatus: () => {},
    registerVirtualModel: () => {},
    registerCommand: () => {},
  };
  return { pi, handlers, setModelCalls };
}

describe("input hook: subagent child guard", () => {
  let workDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousChild: string | undefined;
  let consoleErrors: string[];
  let previousConsoleError: typeof console.error;
  let host: ReturnType<typeof makeFakePi>;
  let inputHandler: (event: unknown, ctx: unknown) => Promise<unknown>;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "bifrost-child-guard-"));
    writeFileSync(
      join(workDir, "bifrost.json"),
      JSON.stringify({
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: false },
        reliability: { enabled: false },
        models: { general: ["provider-x/test-model"] },
      }),
    );
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousChild = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_CODING_AGENT_DIR = workDir; // keep the real agent dir out of config discovery
    delete process.env.PI_SUBAGENT_CHILD;
    process.chdir(workDir);

    consoleErrors = [];
    previousConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };

    // Register the extension against the fake host, with env and cwd already
    // pointed at the isolated config. The module import is cached by Node;
    // the default export is stateless, so each test registers its own host.
    const { default: bifrostExtension } = await import("../index.ts");
    host = makeFakePi();
    bifrostExtension(host.pi as never);
    inputHandler = host.handlers.get("input")![0];
    assert.ok(inputHandler, "extension did not register an input handler");
  });

  afterEach(() => {
    console.error = previousConsoleError;
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("routes an unmarked parent turn to the tier model", async () => {
    // pi-subagents spawns child processes with `--mode rpc`, so child prompts
    // arrive with source "rpc"; using it here keeps the fake event faithful.
    const result = await inputHandler({ source: "rpc", text: "general please fix the test" }, fakeCtx(PARENT_MODEL));

    assert.deepEqual(result, { action: "transform", text: "please fix the test" });
    assert.match(consoleErrors.join("\n"), /classify: general \[!\]/, "parent turn should be classified via inline override");
    assert.equal(host.setModelCalls.length, 1, "parent turn should switch to the tier model");
    assert.equal(`${host.setModelCalls[0].provider}/${host.setModelCalls[0].id}`, "provider-x/test-model");
  });

  it("keeps the pinned model for a subagent child and skips routing", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";

    const result = await inputHandler({ source: "rpc", text: "general please fix the test" }, fakeCtx(PINNED_MODEL));

    assert.deepEqual(result, { action: "continue" }, "child turn must not be transformed by tier overrides");
    assert.equal(host.setModelCalls.length, 0, "child session must not switch models");
    assert.doesNotMatch(consoleErrors.join("\n"), /classify:/, "child session must not be classified");
  });
});
