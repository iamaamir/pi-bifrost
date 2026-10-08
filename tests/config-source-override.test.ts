import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfigWithSourceOverride } from "../config.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function withConfigTree<T>(run: (paths: { cwd: string; extensionDir: string; agentDir: string }) => T): T {
  const root = fs.mkdtempSync(join(tmpdir(), "bifrost-source-override-"));
  const paths = {
    cwd: join(root, "project"),
    extensionDir: join(root, "extension"),
    agentDir: join(root, "agent"),
  };
  fs.mkdirSync(paths.cwd, { recursive: true });
  fs.mkdirSync(paths.extensionDir, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = paths.agentDir;
  try { return run(paths); }
  finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("config source override loading", () => {
  it("replaces the user layer, keeps higher project precedence, and preserves per-tier layer merging", () => {
    withConfigTree(({ cwd, extensionDir, agentDir }) => {
      writeJson(join(extensionDir, "bifrost.json"), { models: { extension: ["extension/model"] } });
      writeJson(join(agentDir, "bifrost.json"), { models: { general: ["disk-user/model"], quick: ["user/quick"] } });
      writeJson(join(cwd, "bifrost.json"), { models: { general: ["workspace/model"] } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { models: { general: ["project/model"] } });

      const loaded = loadConfigWithSourceOverride(cwd, extensionDir, "user", Buffer.from(JSON.stringify({
        models: { general: ["candidate-user/model"], quick: ["candidate/quick"] },
      }), "utf8"));

      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.config.models, {
        extension: ["extension/model"],
        general: ["project/model"],
        quick: ["candidate/quick"],
      });
    });
  });

  it("substitutes only the selected project source and does not flatten inherited user models", () => {
    withConfigTree(({ cwd, extensionDir, agentDir }) => {
      writeJson(join(agentDir, "bifrost.json"), { models: { general: ["user/general"], quick: ["user/quick"] } });
      writeJson(join(cwd, "bifrost.json"), { models: { frontier: ["workspace/frontier"] } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { models: { general: ["disk-project/general"] } });

      const loaded = loadConfigWithSourceOverride(cwd, extensionDir, "project", Buffer.from(JSON.stringify({
        models: { general: ["candidate-project/general"] },
      }), "utf8"));

      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.config.models, {
        general: ["candidate-project/general"],
        quick: ["user/quick"],
        frontier: ["workspace/frontier"],
      });
    });
  });

  it("retains strict diagnostics for invalid selected bytes and invalid overlay layers", () => {
    withConfigTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), []);
      const selectedInvalid = loadConfigWithSourceOverride(cwd, extensionDir, "project", Buffer.from("not-json"));
      assert.deepEqual(selectedInvalid.diagnostics.map(({ layer }) => layer), ["project"]);
      assert.match(selectedInvalid.diagnostics[0]!.message, /not valid JSON/u);

      const overlayInvalid = loadConfigWithSourceOverride(cwd, extensionDir, "user", Buffer.from("{}"));
      assert.deepEqual(overlayInvalid.diagnostics.map(({ layer }) => layer), ["project"]);
      assert.match(overlayInvalid.diagnostics[0]!.message, /must contain an object/u);
    });
  });
});
