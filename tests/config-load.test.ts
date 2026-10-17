import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, loadConfig, loadConfigForReload, loadRules, validateConfig, validateTierPolicyConfig } from "../config.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("config load", () => {
  it("uses in-code defaults when config files missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "general");
      assert.deepEqual(config.categoryStrategies, {
        quick: "random",
        general: "first",
        frontier: "first",
      });
      assert.deepEqual(config.models, {});
      assert.equal(config.rules, DEFAULT_RULES);
      assert.deepEqual(loadRules(cwd, config), DEFAULT_RULES);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges extension, global, cwd, and project configs in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(extensionDir, "bifrost.json"), {
        enabled: false,
        default: "quick",
        strategy: "cheapest",
        categoryStrategies: { quick: "cheapest" },
        models: {
          quick: ["ext-quick"],
          general: ["ext-general"],
        },
      });

      writeJson(join(getAgentDir(), "bifrost.json"), {
        default: "frontier",
        categoryStrategies: { general: "cheapest" },
        models: { general: ["global-general"] },
      });

      writeJson(join(cwd, "bifrost.json"), {
        enabled: true,
        strategy: "random",
        models: { frontier: ["cwd-frontier"] },
      });

      writeJson(join(cwd, ".pi", "bifrost.json"), {
        default: "frontier",
        models: { quick: ["project-quick"], general: ["project-general"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.enabled, true);
      assert.equal(config.default, "frontier");
      assert.equal(config.strategy, "random");
      assert.deepEqual(config.categoryStrategies, {
        quick: "cheapest",
        general: "cheapest",
        frontier: "first",
      });
      assert.deepEqual(config.models, {
        quick: ["project-quick"],
        general: ["project-general"],
        frontier: ["cwd-frontier"],
      });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("deep-merges tier criteria and lets null remove inherited criteria", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(extensionDir, "bifrost.json"), { classifier: { criteria: {
        quick: { what: "bounded", examples: ["format"] },
        frontier: "complex",
      } } });
      writeJson(join(getAgentDir(), "bifrost.json"), { classifier: { criteria: { general: "normal" } } });
      writeJson(join(cwd, "bifrost.json"), { classifier: { criteria: {
        quick: { notFor: "architecture" },
        frontier: null,
      } } });
      assert.deepEqual(loadConfig(cwd, extensionDir).classifier?.criteria, {
        quick: { what: "bounded", examples: ["format"], notFor: "architecture" },
        general: "normal",
      });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("activates TypeSafe from explicit project backend selection", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(cwd, "bifrost.json"), { classifier: { backend: "typesafe" } });
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.classifier?.backend, "typesafe");
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores corrupt config layers and keeps later valid layers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeFileSync(join(extensionDir, "bifrost.json"), "{not json", "utf8");
      writeJson(join(cwd, "bifrost.json"), {
        default: "quick",
        models: { quick: ["cwd-quick"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "quick");
      assert.deepEqual(config.models, { quick: ["cwd-quick"] });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves invalid strict namespaces from project config for startup rejection", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      for (const tierPolicies of [null, "invalid", []]) {
        writeJson(join(cwd, "bifrost.json"), {
          schemaVersion: 2,
          models: { general: ["fixture/model"] },
          tierPolicies,
        });
        const loaded = loadConfigForReload(cwd, extensionDir);
        assert.ok(loaded.diagnostics.some(({ message }) => message.includes("tierPolicies must be an object")));
      }
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("diagnoses a masked future version while allowing tier references split across layers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(cwd, "bifrost.json"), {
        schemaVersion: 999,
        models: { quick: [], general: ["fixture/general"], frontier: [] },
      });
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        models: { frontier: ["fixture/frontier"] },
        tierPolicies: { general: { fallbackTiers: ["frontier"] } },
      });
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.ok(loaded.diagnostics.some(({ layer, message }) => layer === "workspace" && /schemaVersion is unsupported/u.test(message)));

      writeJson(join(cwd, "bifrost.json"), {
        schemaVersion: 2,
        models: { quick: [], general: ["fixture/general"], frontier: [] },
      });
      const split = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(split.diagnostics, []);
      assert.deepEqual(validateConfig(split.config).filter((issue) => issue.code?.startsWith("config.tier_policy_")), []);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validates each strict source while preserving legal partial object overrides", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(cwd, "bifrost.json"), {
        schemaVersion: 2,
        models: { quick: [], general: ["fixture/general"], frontier: [] },
        tierPolicies: { general: { fallbackTiers: [] } },
        affinity: { mode: "observe", providerAdvisory: true },
        reliability: { failureThreshold: 5, cooldownOnAllowanceExhausted: false },
      });
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        tierPolicies: { general: {} },
        affinity: { mode: "off" },
        reliability: { stateVersion: 1 },
      });
      const partial = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(partial.diagnostics, []);
      assert.deepEqual(partial.config.tierPolicies?.general?.fallbackTiers, []);
      assert.deepEqual(partial.config.affinity, { mode: "off" });
      assert.deepEqual(partial.config.reliability, { failureThreshold: 5, cooldownOnAllowanceExhausted: false, stateVersion: 1 });
      assert.deepEqual(validateConfig(partial.config).filter((issue) => issue.severity === "error"), []);

      writeJson(join(cwd, "bifrost.json"), { schemaVersion: 2, affinity: { mode: "invalid" } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { affinity: { mode: "off" } });
      const badAffinity = loadConfigForReload(cwd, extensionDir);
      assert.ok(badAffinity.diagnostics.some(({ layer, message }) => layer === "workspace" && /affinity/u.test(message)));

      writeJson(join(cwd, "bifrost.json"), { schemaVersion: 2, affinity: {} });
      const emptyAffinity = loadConfigForReload(cwd, extensionDir);
      assert.ok(emptyAffinity.diagnostics.some(({ layer, message }) => layer === "workspace" && /affinity/u.test(message)));

      writeJson(join(cwd, "bifrost.json"), { schemaVersion: 2, reliability: { stateVersion: 999 } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { reliability: { stateVersion: 1 } });
      const badReliability = loadConfigForReload(cwd, extensionDir);
      assert.ok(badReliability.diagnostics.some(({ layer, message }) => layer === "workspace" && /reliability/u.test(message)));

      writeJson(join(cwd, "bifrost.json"), {
        schemaVersion: 2,
        models: { quick: [], general: ["fixture/general"], frontier: [] },
      });
      writeJson(join(cwd, ".pi", "bifrost.json"), { tierPolicies: { general: {} } });
      const emptyFinalPolicy = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(emptyFinalPolicy.diagnostics, []);
      assert.ok(validateConfig(emptyFinalPolicy.config).some((issue) => issue.code === "config.tier_policy_fallback_invalid"));
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("bounds config reads while following symlinks to regular config files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const configPath = join(extensionDir, "bifrost.json");
    const targetPath = join(extensionDir, "linked-config.json");
    try {
      writeJson(targetPath, { models: { general: ["fixture/linked"] } });
      symlinkSync(targetPath, configPath);
      const linked = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(linked.diagnostics, []);
      assert.deepEqual(linked.config.models?.general, ["fixture/linked"]);

      rmSync(configPath);
      writeFileSync(configPath, Buffer.alloc(10_000_001, 0x20));
      const oversized = loadConfigForReload(cwd, extensionDir);
      assert.equal(oversized.diagnostics.length, 1);
      assert.match(oversized.diagnostics[0]!.message, /size limit/u);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
    }
  });

  it("validates large acyclic and cyclic tier graphs without recursive stack growth", () => {
    const tiers = 6_000;
    const models = Object.fromEntries(Array.from({ length: tiers }, (_, index) => [`tier-${index}`, []]));
    const acyclic = Object.fromEntries(Array.from({ length: tiers }, (_, index) => [
      `tier-${index}`,
      { fallbackTiers: index + 1 < tiers ? [`tier-${index + 1}`] : [] },
    ]));
    const invalid = Object.fromEntries(Object.entries(acyclic));
    invalid[`tier-${tiers - 1}`] = { fallbackTiers: ["tier-0"] };

    assert.deepEqual(validateTierPolicyConfig({ schemaVersion: 2, models, tierPolicies: acyclic }), []);
    assert.ok(validateTierPolicyConfig({ schemaVersion: 2, models, tierPolicies: invalid })
      .some(({ code }) => code === "config.tier_policy_cycle"));
  });
});
