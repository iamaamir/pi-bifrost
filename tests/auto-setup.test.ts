import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canBootstrapModels, buildBootstrapPools, hasBlockingRuntimePreferences, hasExplicitExtensionRoutingFile, hasExplicitExtensionRoutingOverride, hasUserBootstrapFiles, pathPresentOrUnsafe, serializeBootstrapConfig } from "../auto-setup.ts";
import { makeModel } from "./helpers.ts";
import { DEFAULT_RULES, type BifrostConfig } from "../config.ts";

describe("automatic first-run setup", () => {
  it("only starts when no user config, route file, runtime preferences, or extension routing override exists", () => {
    const fresh = { userConfig: false, routeFile: false, runtimePreferences: false, extensionRoutingOverride: false };
    assert.equal(canBootstrapModels(fresh), true);
    for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) {
      assert.equal(canBootstrapModels({ ...fresh, [key]: true }), false, `${key} blocks setup`);
    }
  });

  it("builds stable pools from listed chat models and ignores unknown and virtual entries", () => {
    const result = buildBootstrapPools([
      makeModel("z-provider", "quick", 0, 0),
      makeModel("a-provider", "general", 1, 1),
      { ...makeModel("bifrost", "auto", 0, 0), api: "pi-virtual" },
      { ...makeModel("classifier-provider", "classifier", 0, 0), type: "classifier" } as never,
    ]);
    assert.deepEqual(result, {
      default: "general",
      models: { quick: ["z-provider/quick"], general: ["a-provider/general"] },
    });
  });

  it("keeps supported extension settings but excludes inherited classifier prompt text from generated project config", () => {
    const extensionSettings: BifrostConfig = {
      enabled: true,
      default: "general",
      strategy: "first",
      categoryStrategies: { quick: "random", general: "first", frontier: "first" },
      rules: [{ pattern: "\\btests?\\b", model: "quick" }],
      classifier: {
        enabled: true,
        backend: "prompt",
        model: "fixture/classifier",
        method: "auto",
        maxTokens: 20,
        temperature: 0,
        fallbackToRegex: true,
        totalTimeoutMs: 15_000,
        typesafe: { model: "jev-test", timeoutMs: 250, maxAttempts: 3, debug: false, metrics: { enabled: true } },
        systemPrompt: "PRIVATE_EXTENSION_PROMPT_CANARY_7f02",
        criteria: { quick: "PRIVATE_EXTENSION_CRITERION_CANARY_91ca" },
      },
      cache: { enabled: true, maxEntries: 333, threshold: 0.88, ttlHours: 48, path: ".pi/custom-cache.jsonl" },
      debug: { enabled: false, path: ".pi/custom-debug.jsonl" },
      reliability: { enabled: true, stateVersion: 2, cooldownMinutes: 45, failureThreshold: 4, path: ".pi/custom-reliability.json" },
      probe: { concurrency: 3, timeoutMs: 12_000 },
      models: {},
    };
    (extensionSettings.classifier as Record<string, unknown>).apiKeyEnv = "BIFROST_TEST_CLASSIFIER_KEY_NAME";
    (extensionSettings.classifier as Record<string, unknown>).unknownControl = "PRIVATE_EXTENSION_UNKNOWN_CANARY_d061";
    (extensionSettings as BifrostConfig & Record<string, unknown>).extensionPrivateSetting = "PRIVATE_EXTENSION_UNKNOWN_ROOT_CANARY_1d9a";
    const saved = serializeBootstrapConfig(extensionSettings, "quick", { quick: ["fixture/verified"], general: [], frontier: [] });
    const serialized = JSON.stringify(saved);
    for (const privateValue of ["PRIVATE_EXTENSION_PROMPT_CANARY_7f02", "PRIVATE_EXTENSION_CRITERION_CANARY_91ca",
      "PRIVATE_EXTENSION_UNKNOWN_CANARY_d061", "PRIVATE_EXTENSION_UNKNOWN_ROOT_CANARY_1d9a"]) {
      assert.equal(serialized.includes(privateValue), false, `${privateValue} must remain inherited from its source layer`);
    }
    assert.deepEqual(saved.models, { quick: ["fixture/verified"], general: [], frontier: [] });
    assert.deepEqual(saved.classifier, {
      enabled: true, backend: "prompt", model: "fixture/classifier", method: "auto", maxTokens: 20,
      temperature: 0, fallbackToRegex: true, totalTimeoutMs: 15_000, apiKeyEnv: "BIFROST_TEST_CLASSIFIER_KEY_NAME",
      typesafe: { model: "jev-test", timeoutMs: 250, maxAttempts: 3, debug: false, metrics: { enabled: true } },
    });
    assert.deepEqual(saved.cache, extensionSettings.cache);
    assert.deepEqual(saved.debug, extensionSettings.debug);
    assert.deepEqual(saved.reliability, extensionSettings.reliability);
    assert.deepEqual(saved.probe, extensionSettings.probe);
    assert.deepEqual(saved.categoryStrategies, extensionSettings.categoryStrategies);
    assert.deepEqual(saved.rules, extensionSettings.rules);
  });

  it("preserves explicit routing scopes in generated project config and drops malformed entries", () => {
    const saved = serializeBootstrapConfig({
      models: {},
      routingScope: {
        providers: ["anthropic", "openai"],
        tiers: { quick: { providers: ["openai"] }, general: { providers: ["anthropic", 7] as unknown as string[] } },
      },
    }, "quick", { quick: ["fixture/verified"], general: [], frontier: [] });
    assert.deepEqual(saved.routingScope, {
      providers: ["anthropic", "openai"],
      tiers: { quick: { providers: ["openai"] } },
    });

    const malformed = serializeBootstrapConfig({
      models: {},
      routingScope: { providers: ["anthropic", 7] as unknown as string[] },
    }, "quick", { quick: ["fixture/verified"], general: [], frontier: [] });
    assert.equal(Object.hasOwn(malformed, "routingScope"), false);

    const empty = serializeBootstrapConfig({ models: {}, routingScope: {} }, "quick", { quick: ["fixture/verified"], general: [], frontier: [] });
    assert.equal(Object.hasOwn(empty, "routingScope"), false);
  });

  it("allows valid enabled runtime preferences and fails closed on off or invalid preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "bifrost-runtime-bootstrap-"));
    const path = join(root, "bifrost-state.json");
    try {
      assert.equal(hasBlockingRuntimePreferences(path), false);
      writeFileSync(path, JSON.stringify({ enabled: true, classifierEnabled: true }));
      assert.equal(hasBlockingRuntimePreferences(path), false);
      writeFileSync(path, JSON.stringify({ enabled: true, classifierEnabled: false }));
      assert.equal(hasBlockingRuntimePreferences(path), false);
      writeFileSync(path, JSON.stringify({ enabled: false, classifierEnabled: true }));
      assert.equal(hasBlockingRuntimePreferences(path), true);
      writeFileSync(path, JSON.stringify({ enabled: true, classifierEnabled: false, pinned: true }));
      assert.equal(hasBlockingRuntimePreferences(path), true);
      writeFileSync(path, "{invalid");
      assert.equal(hasBlockingRuntimePreferences(path), true);
      rmSync(path);
      symlinkSync(join(root, "missing-state"), path);
      assert.equal(hasBlockingRuntimePreferences(path), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records blocked external requests even when the provider transport catches them", () => {
    const root = mkdtempSync(join(tmpdir(), "bifrost-network-guard-"));
    const guard = join(process.cwd(), "scripts", "test-outbound-guard.cjs");
    const violations = join(root, "violations.log");
    try {
      const result = spawnSync(process.execPath, ["-e", "try { fetch('https://example.com'); } catch {}"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_OPTIONS: "--require=" + guard,
          BIFROST_TEST_ALLOWED_ORIGIN: "http://127.0.0.1:12345",
          BIFROST_TEST_NETWORK_VIOLATIONS: violations,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(violations, "utf8"), /blocked fetch to https:\/\/example\.com/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows the shipped empty-pool defaults but blocks edited extension routing policy", () => {
    assert.equal(hasExplicitExtensionRoutingOverride({
      enabled: true,
      default: "general",
      strategy: "first",
      categoryStrategies: { quick: "random", general: "first", frontier: "first" },
      models: { quick: [], general: [], frontier: [] },
    }), false);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: false, models: {} }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, disabled: true, models: {} }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, models: { general: ["manual/model"] } }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, models: 4 }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, models: { general: [4] } }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, tierPolicies: "bad" }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, categoryStrategies: "bad" }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, models: { general: [""] } }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({ enabled: true, models: { other: [] } }), true);
  });

  it("compares shipped strategies and rules structurally while preserving rule order", () => {
    const reorderedDefaults = {
      enabled: true,
      categoryStrategies: { frontier: "first", general: "first", quick: "random" },
      rules: DEFAULT_RULES.map(({ pattern, model }) => ({ model, pattern })),
    };
    assert.equal(hasExplicitExtensionRoutingOverride(reorderedDefaults), false);
    assert.equal(hasExplicitExtensionRoutingOverride({
      ...reorderedDefaults,
      categoryStrategies: { ...reorderedDefaults.categoryStrategies, quick: "first" },
    }), true);
    assert.equal(hasExplicitExtensionRoutingOverride({
      ...reorderedDefaults,
      rules: [...reorderedDefaults.rules].reverse(),
    }), true);
  });

  it("ignores empty config objects but keeps meaningful, unsafe, and malformed files blocking", () => {
    const root = mkdtempSync(join(tmpdir(), "bifrost-auto-setup-"));
    const cwd = join(root, "project");
    const globalDir = join(root, "global");
    mkdirSync(cwd);
    mkdirSync(globalDir);
    try {
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: false, routeFile: false });
      mkdirSync(join(cwd, ".pi"));
      for (const path of [join(globalDir, "bifrost.json"), join(cwd, "bifrost.json"), join(cwd, ".pi", "bifrost.json")]) {
        writeFileSync(path, "{}\n");
      }
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: false, routeFile: false });
      rmSync(join(globalDir, "bifrost.json"));
      rmSync(join(cwd, ".pi", "bifrost.json"));
      writeFileSync(join(cwd, "bifrost.json"), JSON.stringify({ models: { quick: [] } }));
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: true, routeFile: false });
      rmSync(join(cwd, "bifrost.json"));
      writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify({ models: {} }));
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: true, routeFile: false });
      rmSync(join(cwd, ".pi", "bifrost.json"));
      writeFileSync(join(cwd, ".pi", "bifrost-routes.json"), "[]");
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: false, routeFile: true });
      rmSync(join(cwd, ".pi", "bifrost-routes.json"));
      symlinkSync(join(root, "missing-config-target"), join(cwd, "bifrost.json"));
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: true, routeFile: false });
      rmSync(join(cwd, "bifrost.json"));
      writeFileSync(join(cwd, "bifrost.json"), "{invalid");
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi"), { userConfig: true, routeFile: false });
      rmSync(join(cwd, "bifrost.json"));

      const extensionConfig = join(cwd, "bifrost.json");
      writeFileSync(extensionConfig, JSON.stringify({
        enabled: true,
        default: "general",
        strategy: "first",
        categoryStrategies: { quick: "random", general: "first", frontier: "first" },
        models: { quick: [], general: [], frontier: [] },
      }));
      assert.equal(hasExplicitExtensionRoutingFile(extensionConfig), false);
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi", extensionConfig), { userConfig: false, routeFile: false });
      writeFileSync(extensionConfig, JSON.stringify({ enabled: true, models: { general: ["manual/model"] } }));
      assert.equal(hasExplicitExtensionRoutingFile(extensionConfig), true);
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi", extensionConfig), { userConfig: true, routeFile: false });

      const unsafeExtensionConfig = join(root, "extension-bifrost.json");
      symlinkSync(join(root, "missing-extension-target"), unsafeExtensionConfig);
      assert.equal(hasExplicitExtensionRoutingFile(unsafeExtensionConfig), true);
      const safeTarget = join(root, "safe-target.json");
      writeFileSync(safeTarget, "{}");
      const safeLookingSymlink = join(cwd, "bifrost.json");
      rmSync(safeLookingSymlink);
      symlinkSync(safeTarget, safeLookingSymlink);
      assert.deepEqual(hasUserBootstrapFiles(cwd, globalDir, ".pi", safeLookingSymlink), { userConfig: true, routeFile: false });
      rmSync(safeLookingSymlink);
      const invalidExtensionConfig = join(root, "invalid-extension-bifrost.json");
      writeFileSync(invalidExtensionConfig, "{invalid");
      assert.equal(hasExplicitExtensionRoutingFile(invalidExtensionConfig), true);
      assert.equal(pathPresentOrUnsafe(join(root, "missing-extension-target")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
