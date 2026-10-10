import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import bifrostExtension from "../index.ts";
import { TYPE_SAFE_API_KEY_ENV } from "../classifier-backends.ts";
import { BIFROST_AUTO_ID, BIFROST_AUTO_PROVIDER } from "../virtual-model.ts";
import { makeModel } from "./helpers.ts";

type InputHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type RuntimeHarness = {
  cwd: string;
  ctx: ExtensionContext;
  input: InputHandler;
  command: CommandHandler;
  route: VirtualModelDefinition["route"];
  selected: string[];
  editor: { value: string };
  cleanup: () => void;
};

type Config = Record<string, unknown>;

function strictConfig(overrides: Config = {}): Config {
  return {
    schemaVersion: 2,
    enabled: true,
    default: "restricted",
    strategy: "first",
    classifier: { enabled: false },
    models: { restricted: ["fixture/missing"] },
    tierPolicies: { restricted: { fallbackTiers: [] } },
    rules: [],
    ...overrides,
  };
}

function makeHarness(config: Config, available: Model<Api>[] = [], options: {
  active?: Model<Api>;
  mode?: "tui" | "rpc";
  statusThrows?: boolean;
  statusThrowsAfterSetModel?: boolean;
  setModel?: (model: Model<Api>) => Promise<boolean>;
  refresh?: (options?: { signal?: AbortSignal }) => Promise<unknown>;
  classifierModel?: ClassifierModel<ClassifierApi>;
  classify?: (_model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: { signal?: AbortSignal }) => Promise<ClassifierResult>;
} = {}): RuntimeHarness {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTypeSafeKey = process.env[TYPE_SAFE_API_KEY_ENV];
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-strict-runtime-"));
  const agentDir = join(cwd, "agent");
  const configDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "bifrost.json");
  const writeConfig = (next: Config) => writeFileSync(configPath, JSON.stringify(next));
  writeConfig(config);
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env[TYPE_SAFE_API_KEY_ENV];

  const selected: string[] = [];
  const editor = { value: "" };
  const active = options.active ?? makeModel("fixture", "active");
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    getModelOfType: (_type: string, provider: string, id: string) => options.classifierModel?.provider === provider && options.classifierModel.id === id ? options.classifierModel : undefined,
    getAvailableOfType: async () => options.classifierModel ? [options.classifierModel] : [],
    classify: options.classify ?? (async () => { throw new Error("unexpected fake classifier request"); }),
    refresh: options.refresh ?? (async () => ({ refreshed: [], errors: [] })),
  };
  const sessionManager = { getBranch: () => [] };
  const ui = {
    getEditorText: () => editor.value,
    setEditorText: (text: string) => { editor.value = text; },
    setWidget: () => {},
    setStatus: () => {
      if (options.statusThrows || (options.statusThrowsAfterSetModel && selected.length > 0)) {
        throw new Error("injected status cleanup failure");
      }
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    notify: () => {},
    custom: async () => null,
    theme: { fg: (_color: string, text: string) => text },
  };
  const ctx = {
    cwd,
    mode: options.mode ?? "rpc",
    hasUI: options.mode === "tui",
    model: active,
    modelRegistry,
    sessionManager,
    ui,
    signal: undefined,
    thinkingLevel: "low",
  } as unknown as ExtensionContext;

  let input: InputHandler | undefined;
  let command: CommandHandler | undefined;
  let definition: VirtualModelDefinition | undefined;
  const pi = {
    registerVirtualModel: (registered: VirtualModelDefinition) => { definition = registered; },
    registerCommand: (_name: string, options: { handler: CommandHandler }) => { command = options.handler; },
    on: (event: string, handler: InputHandler) => { if (event === "input") input = handler; return () => {}; },
    setModel: async (model: Model<Api>) => {
      selected.push(`${model.provider}/${model.id}`);
      return options.setModel ? options.setModel(model) : true;
    },
  } as unknown as ExtensionAPI;
  bifrostExtension(pi);
  assert.ok(input, "extension registers its input handler");
  assert.ok(command, "extension registers its command handler");
  assert.ok(definition?.route, "extension registers its actual virtual route");

  return {
    cwd,
    ctx,
    input,
    command,
    route: definition.route,
    selected,
    editor,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousTypeSafeKey === undefined) delete process.env[TYPE_SAFE_API_KEY_ENV];
      else process.env[TYPE_SAFE_API_KEY_ENV] = previousTypeSafeKey;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function sendInput(harness: RuntimeHarness, text = "do the task"): Promise<unknown> {
  return harness.input({ text, source: "interactive", streamingBehavior: "steer" }, harness.ctx);
}

describe("strict runtime boundaries through registered Pi hooks", () => {
  it("handles a strict no-route without selecting the active or default model", async () => {
    const previous = makeModel("fixture", "previous");
    const harness = makeHarness(strictConfig(), [previous], { active: previous });
    try {
      const result = await sendInput(harness);
      assert.deepEqual(result, { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally {
      harness.cleanup();
    }
  });

  it("preserves legacy continue behavior when tier policies are absent", async () => {
    const harness = makeHarness({
      enabled: true,
      default: "ordinary",
      classifier: { enabled: false },
      models: { ordinary: ["fixture/missing"] },
      rules: [],
    });
    try {
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      assert.deepEqual(harness.selected, []);
    } finally {
      harness.cleanup();
    }
  });

  it("handles false and throwing physical activation inside a strict policy", async () => {
    for (const activate of [async () => false, async () => { throw new Error("injected activation failure"); }]) {
      const target = makeModel("fixture", "allowed");
      const harness = makeHarness(strictConfig({ models: { restricted: ["fixture/allowed"] } }), [target], {
        setModel: activate as (model: Model<Api>) => Promise<boolean>,
      });
      try {
        assert.deepEqual(await sendInput(harness), { action: "handled" });
        assert.deepEqual(harness.selected, ["fixture/allowed"]);
      } finally {
        harness.cleanup();
      }
    }
  });

  it("keeps strict rejection handled when UI status cleanup throws", async () => {
    const harness = makeHarness(strictConfig(), [], { mode: "tui", statusThrows: true });
    try {
      harness.editor.value = "do the task";
      assert.deepEqual(await sendInput(harness), { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally {
      harness.cleanup();
    }
  });

  it("does not convert successful activation into handled when later UI status cleanup throws", async () => {
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({ models: { restricted: ["fixture/allowed"] } }), [target], {
      mode: "tui",
      statusThrowsAfterSetModel: true,
    });
    try {
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/allowed"]);
    } finally {
      harness.cleanup();
    }
  });

  it("stops an aborted registry wait and preserves a newer editor draft", async () => {
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise<void>(() => {});
    const controller = new AbortController();
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({ classifier: { enabled: true } }), [target], {
      mode: "tui",
      refresh: async () => { markRefreshStarted(); return refreshGate; },
    });
    (harness.ctx as unknown as { signal: AbortSignal }).signal = controller.signal;
    harness.editor.value = "original request";
    let deadline: NodeJS.Timeout | undefined;
    try {
      const input = sendInput(harness, "original request");
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("strict abort test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      harness.editor.value = "newer draft";
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.equal(harness.editor.value, "newer draft");
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("lets a manual pin win over an input held in registry refresh", async () => {
    let markRefreshStarted!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const target = makeModel("fixture", "allowed");
    const active = makeModel("fixture", "active");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: { enabled: true, backend: "prompt", fallback: "regex" },
    }), [target, active], {
      active,
      refresh: async () => { markRefreshStarted(); await refreshGate; return { refreshed: [], errors: [] }; },
    });
    let deadline: NodeJS.Timeout | undefined;
    try {
      const input = sendInput(harness);
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("manual pin race exceeded 5-second deadline")), 5000);
      });
      await Promise.race([refreshStarted, timeout]);
      await harness.command("pin", harness.ctx);
      releaseRefresh();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "continue" });
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      releaseRefresh();
      harness.cleanup();
    }
  });

  it("handles cancellation after the fake classifier returns instead of continuing unclassified", async () => {
    const controller = new AbortController();
    let markClassificationStarted!: () => void;
    let releaseClassification!: (result: ClassifierResult) => void;
    const classificationStarted = new Promise<void>((resolve) => { markClassificationStarted = resolve; });
    const classificationGate = new Promise<ClassifierResult>((resolve) => { releaseClassification = resolve; });
    const classifierModel = { type: "classifier", provider: "typesafe", id: "fixture" } as ClassifierModel<ClassifierApi>;
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/allowed"] },
      classifier: {
        enabled: true,
        backend: "pi-native",
        criteria: { restricted: "Bounded fixture classification criterion." },
        minConfidence: 0.1,
        piNative: { model: "typesafe/fixture", timeoutMs: 5000, maxAttempts: 1 },
      },
    }), [target], {
      classifierModel,
      classify: async () => { markClassificationStarted(); return classificationGate; },
    });
    (harness.ctx as unknown as { signal: AbortSignal }).signal = controller.signal;
    let deadline: NodeJS.Timeout | undefined;
    try {
      const input = sendInput(harness);
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("classifier cancellation test exceeded 5-second deadline")), 5000);
      });
      await Promise.race([classificationStarted, timeout]);
      releaseClassification({
        api: "systemone",
        provider: "typesafe",
        model: "fixture",
        answers: { tier: { type: "choice", choice: "restricted", confidence: 0.9, probabilities: { restricted: 1 } } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as unknown as ClassifierResult);
      controller.abort();
      assert.deepEqual(await Promise.race([input, timeout]), { action: "handled" });
      assert.deepEqual(harness.selected, []);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      harness.cleanup();
    }
  });

  it("throws from strict Auto user routing instead of retaining last dispatch", async () => {
    const old = makeModel("fixture", "previous");
    const harness = makeHarness(strictConfig(), [old], {
      active: { ...makeModel(BIFROST_AUTO_PROVIDER, BIFROST_AUTO_ID), api: "pi-virtual" } as Model<Api>,
    });
    const ctx = harness.ctx as unknown as { sessionManager: { getBranch: () => unknown[] } };
    ctx.sessionManager.getBranch = () => [{
      type: "message",
      message: { role: "assistant", provider: "fixture", model: "previous" },
    }];
    try {
      const route = harness.route as unknown as (request: unknown, context: ExtensionContext) => Promise<unknown>;
      const routed = route({
        model: harness.ctx.model,
        reason: "user",
        thinkingLevel: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
      }, harness.ctx);
      await assert.rejects(Promise.resolve(routed), /no healthy|no available|no model/i);
      assert.deepEqual(harness.selected, []);
    } finally {
      harness.cleanup();
    }
  });

  it("follows the explicit fallback order and selects only an allowed candidate", async () => {
    const allowed = makeModel("fixture", "allowed-backup");
    const disallowed = makeModel("fixture", "disallowed");
    const harness = makeHarness(strictConfig({
      models: { restricted: ["fixture/missing"], backup: ["fixture/allowed-backup"] },
      tierPolicies: { restricted: { fallbackTiers: ["backup"] }, backup: { fallbackTiers: [] } },
    }), [allowed, disallowed]);
    try {
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/allowed-backup"]);
    } finally {
      harness.cleanup();
    }
  });

  it("blocks invalid policy at startup and retains last-good config on invalid reload", async () => {
    const invalid = strictConfig({ tierPolicies: { restricted: { fallbackTiers: ["unknown"] } } });
    const blocked = makeHarness(invalid, [makeModel("fixture", "allowed")]);
    try {
      assert.deepEqual(await sendInput(blocked), { action: "handled" });
      assert.deepEqual(blocked.selected, []);
    } finally {
      blocked.cleanup();
    }

    const valid = strictConfig({ models: { restricted: ["fixture/allowed"] } });
    const target = makeModel("fixture", "allowed");
    const harness = makeHarness(valid, [target]);
    try {
      writeFileSync(join(harness.cwd, ".pi", "bifrost.json"), JSON.stringify(invalid));
      await harness.command("reload", harness.ctx);
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      assert.deepEqual(harness.selected, ["fixture/allowed"]);
    } finally {
      harness.cleanup();
    }
  });

  it("lets explicit pin and off modes bypass strict routing", async () => {
    const harness = makeHarness(strictConfig());
    try {
      await harness.command("pin", harness.ctx);
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      await harness.command("unpin", harness.ctx);
      await harness.command("off", harness.ctx);
      assert.deepEqual(await sendInput(harness), { action: "continue" });
      assert.deepEqual(harness.selected, []);
    } finally {
      harness.cleanup();
    }
  });
});
