import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, isTypeSafeTrusted, loadConfig, loadRules } from "../config.ts";

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

  it("does not let project config self-approve TypeSafe", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(cwd, "bifrost.json"), { classifier: { backend: "typesafe", typesafe: { trustedProjects: [cwd] } } });
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.classifier?.typesafe?.trustedProjects, undefined);
      assert.equal(isTypeSafeTrusted(config), false);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses global TypeSafe approval only for matching project", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const other = mkdtempSync(join(tmpdir(), "bifrost-other-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(getAgentDir(), "bifrost.json"), { classifier: { typesafe: { trustedProjects: [cwd] } } });
      writeJson(join(cwd, "bifrost.json"), { classifier: { backend: "typesafe" } });
      writeJson(join(other, "bifrost.json"), { classifier: { backend: "typesafe" } });
      assert.equal(isTypeSafeTrusted(loadConfig(cwd, extensionDir)), true);
      assert.equal(isTypeSafeTrusted(loadConfig(other, extensionDir)), false);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
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
});
