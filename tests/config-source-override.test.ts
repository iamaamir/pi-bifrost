import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUNDLED_PUBLIC_INIT_DEFAULTS } from "../config.ts";
import { loadConfigForReload, loadConfigWithSourceOverride } from "../config-load.ts";

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
      assert.deepEqual(loaded.sourceFields, [
        { layer: "extension", fields: ["models"] },
        { layer: "global", fields: ["models"] },
        { layer: "workspace", fields: ["models"] },
        { layer: "project", fields: ["models"] },
      ]);
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

  it("rejects malformed UTF-8 equally in saved and prospective config", () => {
    withConfigTree(({ cwd, extensionDir }) => {
      const bytes = Buffer.concat([
        Buffer.from('{"debug":{"path":"'), Buffer.from([0xff]), Buffer.from('"}}'),
      ]);
      const path = join(cwd, ".pi", "bifrost.json");
      fs.mkdirSync(join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path, bytes);
      const saved = loadConfigForReload(cwd, extensionDir);
      const prospective = loadConfigWithSourceOverride(cwd, extensionDir, "project", bytes);
      assert.deepEqual(saved.diagnostics, prospective.diagnostics);
      assert.deepEqual(saved.diagnostics.map(({ layer, message }) => [layer, message]),
        [["project", "project config is not valid UTF-8."]]);
      assert.equal(saved.sourceFields.some(({ layer }) => layer === "project"), false);
    });
  });

  it("rejects an unsupported version in the selected layer before a higher layer can mask it", () => {
    withConfigTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), { schemaVersion: 2 });
      const loaded = loadConfigWithSourceOverride(cwd, extensionDir, "workspace", Buffer.from(JSON.stringify({
        schemaVersion: 999,
      }), "utf8"));
      assert.equal(loaded.diagnostics.length, 1);
      assert.equal(loaded.diagnostics[0]!.layer, "workspace");
      assert.match(loaded.diagnostics[0]!.message, /schemaVersion is unsupported/u);
    });
  });

  it("qualifies only exact bundled public extension defaults without exposing source values", () => {
    withConfigTree(({ cwd, extensionDir }) => {
      const defaults = BUNDLED_PUBLIC_INIT_DEFAULTS;
      writeJson(join(extensionDir, "bifrost.json"), {
        cache: { threshold: 1, maxEntries: 500, enabled: true },
        classifier: { fallbackToRegex: true, temperature: 0, maxTokens: 20, method: "auto", enabled: true },
        customNote: "private extension setting",
      });

      const canonical = loadConfigWithSourceOverride(cwd, extensionDir, "project", Buffer.from("{}"));
      assert.deepEqual(canonical.publicDefaultFields, ["classifier", "cache"]);
      assert.deepEqual(canonical.sourceFields, [{
        layer: "extension",
        fields: ["cache", "classifier", "customNote"],
      }, { layer: "project", fields: [] }]);
      assert.deepEqual(defaults.classifier, {
        enabled: true, method: "auto", maxTokens: 20, temperature: 0, fallbackToRegex: true,
      });

      writeJson(join(extensionDir, "bifrost.json"), {
        cache: { enabled: false, maxEntries: 500, threshold: 0.88 },
        classifier: {
          enabled: true, method: "auto", maxTokens: 20, temperature: 0, fallbackToRegex: true,
          systemPrompt: "private custom prompt",
        },
      });
      const customized = loadConfigWithSourceOverride(cwd, extensionDir, "project", Buffer.from("{}"));
      assert.deepEqual(customized.publicDefaultFields, []);
      assert.deepEqual(customized.sourceFields, [
        { layer: "extension", fields: ["cache", "classifier"] },
        { layer: "project", fields: [] },
      ]);
      assert.equal(JSON.stringify(customized.publicDefaultFields).includes("private custom prompt"), false);
      assert.equal(JSON.stringify(customized.sourceFields).includes("private custom prompt"), false);
    });
  });

  it("rejects source-local self, duplicate, and cycle errors before higher layers mask them", () => {
    withConfigTree(({ cwd, extensionDir, agentDir }) => {
      writeJson(join(extensionDir, "bifrost.json"), {
        tierPolicies: {
          self: { fallbackTiers: ["self"] },
          duplicate: { fallbackTiers: ["other", "other"] },
          cycleA: { fallbackTiers: ["cycleB"] },
          cycleB: { fallbackTiers: ["cycleA"] },
        },
      });
      writeJson(join(agentDir, "bifrost.json"), { tierPolicies: { self: { fallbackTiers: [] } } });
      writeJson(join(cwd, "bifrost.json"), { tierPolicies: { duplicate: { fallbackTiers: [] } } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { tierPolicies: { cycleA: { fallbackTiers: [] }, cycleB: { fallbackTiers: [] } } });

      const loaded = loadConfigForReload(cwd, extensionDir);
      const extensionDiagnostics = loaded.diagnostics.filter(({ layer }) => layer === "extension");
      assert.equal(extensionDiagnostics.length, 1);
      assert.match(extensionDiagnostics[0]!.message, /source-local policy/u);
    });
  });

  it("checks every on-disk source layer and each prospective editable source", () => {
    const sourceFiles = {
      extension: (extensionDir: string, _agentDir: string, _cwd: string) => join(extensionDir, "bifrost.json"),
      global: (_extensionDir: string, agentDir: string, _cwd: string) => join(agentDir, "bifrost.json"),
      workspace: (_extensionDir: string, _agentDir: string, cwd: string) => join(cwd, "bifrost.json"),
      project: (_extensionDir: string, _agentDir: string, cwd: string) => join(cwd, ".pi", "bifrost.json"),
    };
    for (const source of ["extension", "global", "workspace", "project"] as const) {
      withConfigTree(({ cwd, extensionDir, agentDir }) => {
        writeJson(sourceFiles[source](extensionDir, agentDir, cwd), {
          tierPolicies: { general: { fallbackTiers: ["general"] } },
        });
        if (source !== "project") {
          writeJson(join(cwd, ".pi", "bifrost.json"), { tierPolicies: { general: { fallbackTiers: [] } } });
        }
        const loaded = loadConfigForReload(cwd, extensionDir);
        const expectedLayer = source === "global" ? "global" : source;
        assert.ok(loaded.diagnostics.some(({ layer }) => layer === expectedLayer), `${source} source should be diagnosed`);
      });
    }

    for (const source of ["project", "workspace", "user"] as const) {
      withConfigTree(({ cwd, extensionDir }) => {
        writeJson(join(cwd, ".pi", "bifrost.json"), { tierPolicies: { general: { fallbackTiers: [] } } });
        const loaded = loadConfigWithSourceOverride(cwd, extensionDir, source, Buffer.from(JSON.stringify({
          tierPolicies: { general: { fallbackTiers: ["general"] } },
        }), "utf8"));
        const expectedLayer = source === "user" ? "global" : source;
        assert.ok(loaded.diagnostics.some(({ layer }) => layer === expectedLayer), `${source} prospective source should be diagnosed`);
      });
    }
  });

  it("rejects invalid source-local economics before a valid higher namespace replaces it", () => {
    withConfigTree(({ cwd, extensionDir, agentDir }) => {
      writeJson(join(agentDir, "bifrost.json"), {
        schemaVersion: 2,
        economics: {
          mode: "policy",
          scopes: { selected: { kind: "model", model: "fixture/model" } },
          sources: [],
          admission: [{ id: "daily", scopeRef: "selected", windowId: "day", reserveRatio: 2 }],
        },
      });
      writeJson(join(cwd, "bifrost.json"), {
        economics: { mode: "observe", scopes: {}, sources: [], admission: [] },
      });

      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.ok(loaded.diagnostics.some(({ layer, message }) => layer === "global" && /economics/u.test(message)));
    });
  });

  it("rejects oversized prospective config bytes before decoding or applying them", () => {
    withConfigTree(({ cwd, extensionDir }) => {
      const bytes = Buffer.alloc(10_000_001, 0x20);
      const loaded = loadConfigWithSourceOverride(cwd, extensionDir, "project", bytes);
      assert.equal(loaded.diagnostics.length, 1);
      assert.match(loaded.diagnostics[0]!.message, /size limit/u);
    });
  });

  it("bounds source diagnostics and never includes source values", () => {
    withConfigTree(({ cwd, extensionDir, agentDir }) => {
      const secret = `PRIVATE_CONFIG_VALUE_${"x".repeat(10_000)}`;
      for (const path of [
        join(extensionDir, "bifrost.json"),
        join(agentDir, "bifrost.json"),
        join(cwd, "bifrost.json"),
        join(cwd, ".pi", "bifrost.json"),
      ]) writeJson(path, { schemaVersion: secret, affinity: { mode: "private-invalid-value" } });

      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.ok(loaded.diagnostics.length <= 32);
      assert.ok(loaded.diagnostics.every(({ message }) => message.length <= 192));
      assert.equal(JSON.stringify(loaded.diagnostics).includes(secret), false);
    });
  });
});
