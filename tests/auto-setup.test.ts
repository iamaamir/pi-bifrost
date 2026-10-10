import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canBootstrapModels, buildBootstrapPools, hasBlockingRuntimePreferences, hasExplicitExtensionRoutingFile, hasExplicitExtensionRoutingOverride, hasUserBootstrapFiles, pathPresentOrUnsafe } from "../auto-setup.ts";
import { makeModel } from "./helpers.ts";
import { DEFAULT_RULES } from "../config.ts";

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
    ]);
    assert.deepEqual(result, {
      default: "general",
      models: { quick: ["z-provider/quick"], general: ["a-provider/general"] },
    });
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
