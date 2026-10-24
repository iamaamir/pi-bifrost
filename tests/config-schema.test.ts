// The schema.json contract: the shipped schema is the single authoritative
// structural definition of Bifrost configuration. These tests pin the
// behaviors the contract depends on — partial vs effective validation,
// inline `description` metadata under every supported schema version, the
// schemaVersion 3 reserved-key semantics, and parity between the schema and
// the shapes the runtime itself produces.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  BUNDLED_PUBLIC_INIT_DEFAULTS,
  DEFAULT_RULES,
  hasExplicitTierPolicy,
  hasExplicitTierPolicies,
  validateConfig,
  validateTierPolicyConfig,
} from "../config.ts";
import {
  DYNAMIC_CONFIG_MAP_PATHS,
  configSchemaDigest,
  stripConfigMetadata,
  validateConfigSourceStructure,
  validateEffectiveConfigStructure,
} from "../config-schema.ts";
import { loadConfigForReload } from "../config-load.ts";
import { buildInitProposal } from "../commands.ts";
import { createRouter } from "../router.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function withTree(task: (paths: { cwd: string; extensionDir: string; home: string }) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-schema-contract-"));
  const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-schema-extension-"));
  const home = mkdtempSync(join(tmpdir(), "bifrost-schema-home-"));
  const agentDir = join(home, "agent");
  const oldHome = process.env.HOME;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    task({ cwd, extensionDir, home });
  } finally {
    process.env.HOME = oldHome;
    process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(extensionDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function issuePaths(issues: readonly { readonly path?: string; readonly code?: string }[]): string[] {
  return issues.map((issue) => `${issue.code ?? "none"}@${issue.path ?? ""}`);
}

describe("config schema contract", () => {
  it("loads the installed schema once and exposes a stable content digest", () => {
    const digest = configSchemaDigest();
    assert.match(digest, /^[0-9a-f]{64}$/u);
    assert.equal(configSchemaDigest(), digest, "the digest must be stable across calls");
    const onDisk = readFileSync(join(REPO_ROOT, "schema.json"), "utf-8");
    assert.equal(digest, createHash("sha256").update(onDisk, "utf-8").digest("hex"));
  });

  it("rejects unsupported fields, invalid values, and wrong types in source layers", () => {
    assert.deepEqual(issuePaths(validateConfigSourceStructure({ models: {}, bogus: 1 })),
      ["config.schema_unsupported_field@bogus"]);
    assert.deepEqual(issuePaths(validateConfigSourceStructure({ classifier: { bogus: 1 } })),
      ["config.schema_unsupported_field@classifier.bogus"]);
    assert.deepEqual(issuePaths(validateConfigSourceStructure({ cache: { bogus: 1 } })),
      ["config.schema_unsupported_field@cache.bogus"]);
    assert.deepEqual(issuePaths(validateConfigSourceStructure({ strategy: "teleport" })),
      ["config.schema_enum@strategy"]);
    assert.deepEqual(issuePaths(validateConfigSourceStructure({ enabled: "yes" })),
      ["config.schema_type@enabled"]);
    assert.deepEqual(validateConfigSourceStructure({
      $schema: "./schema.json",
      enabled: true,
      strategy: "first",
      models: { quick: ["fixture/quick"], general: "fixture/general" },
      rules: [{ pattern: "x", model: "quick" }],
    }), []);
  });

  it("validates partial layers without in-document version requirements and enforces them on the effective config", () => {
    const tierPoliciesLayer = { tierPolicies: { general: { fallbackTiers: [] } } };
    const economicsLayer = { economics: { mode: "observe", scopes: {}, sources: [], admission: [] } };
    assert.deepEqual(validateConfigSourceStructure(tierPoliciesLayer), [], "tierPolicies may rely on a layer-supplied schemaVersion");
    assert.deepEqual(validateConfigSourceStructure(economicsLayer), [], "economics may rely on a layer-supplied schemaVersion");
    assert.ok(validateEffectiveConfigStructure(tierPoliciesLayer).some((issue) => issue.code === "config.schema_missing_field"));
    assert.ok(validateEffectiveConfigStructure(economicsLayer).some((issue) => issue.code === "config.schema_missing_field"));
    assert.deepEqual(validateEffectiveConfigStructure({ schemaVersion: 2, ...tierPoliciesLayer }), []);
    assert.ok(validateEffectiveConfigStructure({ schemaVersion: 2, economics: { mode: "observe" } })
      .some((issue) => issue.code === "config.schema_missing_field"), "incomplete economics stays rejected");
  });

  it("accepts inline descriptions in every supported section and strips them at the load boundary", () => {
    const rich: Record<string, unknown> = {
      schemaVersion: 3,
      description: "Project routing policy for coding agents.",
      enabled: true,
      default: "general",
      models: { description: "Available model tiers.", general: ["fixture/general"], quick: ["fixture/quick"] },
      categoryStrategies: { description: "Per-tier strategies.", general: "first" },
      classifier: {
        description: "Control whether requests are classified dynamically.",
        enabled: false,
        typesafe: { description: "Transport notes.", model: "jev-1.13.0" },
      },
      cache: { description: "Cache notes.", enabled: true },
      debug: { description: "Debug notes.", enabled: false },
      reliability: { description: "Failure handling notes.", enabled: true, stateVersion: 2, observations: { description: "Obs notes.", enabled: false } },
      probe: { description: "Probe notes.", concurrency: 10 },
      affinity: { description: "Affinity notes.", mode: "off" },
      tierPolicies: { description: "Boundary notes.", general: { description: "Terminal.", fallbackTiers: [] } },
      rules: [{ description: "Review rule.", pattern: "review", model: "general" }],
    };
    assert.deepEqual(validateConfigSourceStructure(rich), []);
    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), rich);
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(loaded.diagnostics, []);
      const serialized = JSON.stringify(loaded.config);
      assert.equal(serialized.includes("description"), false, "no description may reach the runtime config");
      assert.equal(serialized.includes("Available model tiers."), false);
      assert.deepEqual(loaded.config.models, { general: ["fixture/general"], quick: ["fixture/quick"] });
      assert.deepEqual(loaded.config.tierPolicies, { general: { fallbackTiers: [] } });
      // The authored document keeps its metadata and reports it in fields.
      const onDisk = JSON.parse(readFileSync(join(cwd, ".pi", "bifrost.json"), "utf-8")) as Record<string, unknown>;
      assert.equal(onDisk.description, "Project routing policy for coding agents.");
      assert.ok(loaded.sourceFields.find(({ layer }) => layer === "project")?.fields.includes("description"));
    });
  });

  it("does not change effective routing when descriptions are added or removed", () => {
    const plain = {
      schemaVersion: 3,
      default: "general",
      models: { general: ["fixture/general"], quick: ["fixture/quick"] },
      classifier: { enabled: false },
      reliability: { enabled: true, failureThreshold: 4 },
    };
    const described = {
      schemaVersion: 3,
      description: "root",
      default: "general",
      models: { description: "tiers", general: ["fixture/general"], quick: ["fixture/quick"] },
      classifier: { description: "cls", enabled: false },
      reliability: { description: "rel", enabled: true, failureThreshold: 4 },
    };
    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), plain);
      const withoutDescriptions = loadConfigForReload(cwd, extensionDir);
      writeJson(join(cwd, ".pi", "bifrost.json"), described);
      const withDescriptions = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(withDescriptions.diagnostics, []);
      assert.deepEqual(withDescriptions.config, withoutDescriptions.config);
    });
  });

  it("keeps a user-defined description key meaning under versions 1 and 2", () => {
    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        schemaVersion: 2,
        default: "general",
        models: { general: ["fixture/general"], description: ["fixture/description-tier"] },
      });
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.config.models?.description, ["fixture/description-tier"],
        "a v2 tier named description must survive loading unchanged");
      // Fixed-shape section descriptions are additive metadata in every version.
      assert.deepEqual(validateConfigSourceStructure({ schemaVersion: 2, classifier: { description: "note", enabled: true } }), []);
      // ...while record-valued dynamic maps never accept string metadata before
      // v3; a single layer may defer version conditionals, so the effective
      // configuration is where they must fail.
      assert.ok(validateEffectiveConfigStructure({ schemaVersion: 2, tierPolicies: { description: "note" } }).length > 0);
      assert.ok(validateEffectiveConfigStructure({
        schemaVersion: 2,
        economics: { mode: "observe", scopes: { description: "note" }, sources: [], admission: [] },
      }).length > 0);
    });
  });

  it("reserves description keys in dynamically keyed maps under schemaVersion 3", () => {
    // Schema level: a non-string value cannot be metadata in v3.
    assert.ok(validateConfigSourceStructure({ schemaVersion: 3, models: { description: ["fixture/x"] } }).length > 0);
    // Semantic level: merged configs get a precise diagnostic naming the resolution.
    const issues = validateConfig({ schemaVersion: 3, models: { description: ["fixture/x"], general: ["fixture/general"] } });
    assert.ok(issues.some((issue) => issue.code === "config.v3_reserved_description" && issue.path === "models.description"));
    assert.ok(validateTierPolicyConfig({ schemaVersion: 3, models: { general: [] }, tierPolicies: { description: [] } } as never)
      .some((issue) => issue.code === "config.tier_policy_invalid" || issue.code === "config.v3_reserved_description"));
  });

  it("rejects a non-string reserved description inside a version 3 layer instead of stripping it", () => {
    // The schema reports the wrong type, but a warning alone would let the
    // loader strip the key and keep routing with the tier silently removed.
    assert.ok(validateConfigSourceStructure({ schemaVersion: 3, models: { description: ["fixture/x"] } }).length > 0);
    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        schemaVersion: 3,
        default: "general",
        models: { description: ["fixture/description-tier"], general: ["fixture/general"] },
      });
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.ok(loaded.diagnostics.some(({ layer, message }) => layer === "project"
        && message.includes("models.description")
        && message.includes("schemaVersion 3 reserves")), JSON.stringify(loaded.diagnostics));
      assert.equal(loaded.config.models?.description, undefined,
        "the uninterpretable key must not be silently deleted from a routing config");
    });
  });

  it("keeps an admission rule ID named description in every schema version", () => {
    // economics.tierOverrides.<tier> is keyed by admission rule IDs; a rule
    // named "description" is routing data, not metadata, in versions 1, 2, 3.
    const rule = { reserveRatio: 0.9, unknown: "block" as const };
    assert.deepEqual(
      stripConfigMetadata({ schemaVersion: 2, economics: { tierOverrides: { restricted: { description: rule } } } }).economics,
      { tierOverrides: { restricted: { description: rule } } },
      "a v2 rule ID named description must survive stripping");
    assert.deepEqual(
      stripConfigMetadata({
        schemaVersion: 3,
        economics: { description: "Economic notes.", tierOverrides: { restricted: { description: rule } } },
      }).economics,
      { tierOverrides: { restricted: { description: rule } } },
      "a v3 rule ID named description must survive stripping while the section note goes");

    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, ".pi", "bifrost.json"), {
        schemaVersion: 2,
        default: "general",
        models: { general: ["fixture/general"] },
        economics: {
          mode: "policy",
          scopes: { restricted: { kind: "model", model: "fixture/allowed" } },
          sources: [],
          admission: [{ id: "description", scopeRef: "restricted", windowId: "daily", reserveRatio: 0.9, unknown: "block" }],
          tierOverrides: { general: { description: { reserveRatio: 1, unknown: "block" } } },
        },
      });
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(loaded.diagnostics, []);
      const overrides = (loaded.config.economics as unknown as {
        tierOverrides: Record<string, Record<string, { reserveRatio: number; unknown: string }>>;
      }).tierOverrides;
      assert.deepEqual(overrides,
        { general: { description: { reserveRatio: 1, unknown: "block" } } },
        "the rule ID named description must reach routing unchanged");
    });
  });

  it("keeps the strategy enum enforced for every categoryStrategies key", () => {
    // Free text is allowed only at the version 3 metadata key; every other
    // key stays enum-checked so a strategy typo keeps producing a finding.
    assert.ok(validateEffectiveConfigStructure({ schemaVersion: 3, categoryStrategies: { quick: "randomn" } })
      .some((issue) => issue.code === "config.schema_enum" && issue.path === "categoryStrategies.quick"));
    assert.ok(validateEffectiveConfigStructure({ schemaVersion: 2, categoryStrategies: { description: "randomn" } })
      .some((issue) => issue.code === "config.schema_enum" && issue.path === "categoryStrategies.description"));
    assert.deepEqual(validateConfigSourceStructure({ categoryStrategies: { description: "Per-tier strategies.", general: "first" } }), []);
    assert.deepEqual(validateEffectiveConfigStructure({ schemaVersion: 3, categoryStrategies: { description: "Per-tier strategies.", general: "first" } }), []);
  });

  it("rejects an ambiguous v3 upgrade with a precise per-layer diagnostic", () => {
    withTree(({ cwd, extensionDir }) => {
      // A v2-authored workspace layer defines a tier named description; a higher
      // layer bumps the effective version to 3. The load must fail closed.
      writeJson(join(cwd, "bifrost.json"), {
        default: "general",
        models: { general: ["fixture/general"], description: ["fixture/description-tier"] },
      });
      writeJson(join(cwd, ".pi", "bifrost.json"), { schemaVersion: 3 });
      const ambiguous = loadConfigForReload(cwd, extensionDir);
      assert.ok(ambiguous.diagnostics.some(({ layer, message }) => layer === "workspace"
        && message.includes("models.description")
        && message.includes("schemaVersion 3 reserves")
        && message.includes("declare schemaVersion 3")), JSON.stringify(ambiguous.diagnostics));

      // Explicit opt-in resolves the ambiguity: the key becomes metadata.
      writeJson(join(cwd, "bifrost.json"), {
        schemaVersion: 3,
        default: "general",
        models: { description: "Inline tier notes.", general: ["fixture/general"] },
      });
      const resolved = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(resolved.diagnostics, []);
      assert.equal(JSON.stringify(resolved.config).includes("Inline tier notes."), false);
      assert.deepEqual(resolved.config.models, { general: ["fixture/general"] });
    });
  });

  it("merges description-bearing layers and reports structural layer findings", () => {
    withTree(({ cwd, extensionDir }) => {
      writeJson(join(cwd, "bifrost.json"), { schemaVersion: 3, description: "workspace", models: { description: "tiers" } });
      writeJson(join(cwd, ".pi", "bifrost.json"), { description: "project", models: { general: ["fixture/general"] } });
      const loaded = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(loaded.diagnostics, []);
      assert.deepEqual(loaded.config.models, { general: ["fixture/general"] });

      writeJson(join(cwd, ".pi", "bifrost.json"), { models: { general: ["fixture/general"] }, classifier: { bogus: 1 } });
      const unsupported = loadConfigForReload(cwd, extensionDir);
      assert.deepEqual(unsupported.diagnostics, [], "an unsupported field does not discard the layer");
      assert.ok(unsupported.warnings.some(({ layer, message }) => layer === "project"
        && message.includes("classifier.bogus")), JSON.stringify(unsupported.warnings));
      assert.deepEqual(unsupported.config.models, { general: ["fixture/general"] });
    });
  });

  it("keeps every version 2 routing capability under schemaVersion 3", async () => {
    const config = {
      schemaVersion: 3,
      default: "quick",
      models: { quick: ["fixture/quick"], backup: ["fixture/backup"] },
      tierPolicies: { quick: { fallbackTiers: ["backup"] } },
      affinity: { mode: "observe" as const },
      reliability: { stateVersion: 2 as const },
    };
    assert.deepEqual(validateTierPolicyConfig(config), []);
    assert.deepEqual(validateConfig(config), []);
    assert.equal(hasExplicitTierPolicy(config, "quick"), true);
    assert.equal(hasExplicitTierPolicies(config), true);

    // The resolver honors v3 fallback boundaries exactly like v2.
    const backupModel = { provider: "fixture", id: "backup-model", cost: { input: 1, output: 1 }, contextWindow: 8_000 };
    const router = createRouter({
      config: {
        schemaVersion: 3,
        models: { quick: ["fixture/missing-model"], backup: ["fixture/backup-model"] },
        default: "quick",
        strategy: "first",
        rules: [],
        tierPolicies: { quick: { fallbackTiers: ["backup"] } },
      },
      registry: { knownModels: [backupModel], availableModels: [backupModel] },
      now: 1_000,
    });
    const resolved = await router.resolve({ prompt: "request", forcedTier: "quick" });
    assert.equal(resolved.status, "completed");
    if (resolved.status !== "completed") return;
    assert.equal(resolved.decision.selected, "fixture/backup-model");
    assert.equal(resolved.decision.selectedTier, "backup");
  });

  it("keeps the runtime's own configuration shapes valid under the schema", () => {
    // Bundled defaults file.
    const bundled = JSON.parse(readFileSync(join(REPO_ROOT, "bifrost.json"), "utf-8")) as Record<string, unknown>;
    assert.deepEqual(validateConfigSourceStructure(bundled), []);
    assert.deepEqual(validateEffectiveConfigStructure(bundled), []);
    // Generated init proposals.
    const proposal = buildInitProposal({ quick: ["fixture/verified"] }, undefined, "/extension");
    assert.deepEqual(validateEffectiveConfigStructure(proposal), []);
    // Public default registry used to qualify bundled defaults.
    assert.deepEqual(validateEffectiveConfigStructure({ ...BUNDLED_PUBLIC_INIT_DEFAULTS, models: {}, rules: DEFAULT_RULES }), []);
    // Example recipes (route-file examples are not configuration documents).
    for (const file of ["classifier-pi-native.json", "direct-model-routing.json", "economic-billing-preference.json",
      "economic-reserve-observe.json", "economical-frontier-reliability.json", "economical-frontier.json",
      "exact-bindings.json", "large-context.json", "reliability-v2-auto.json", "rules-only-local.json",
      "advanced-classifier-prompt.json", "task-aware-routing.json"]) {
      const example = JSON.parse(readFileSync(join(REPO_ROOT, "examples", file), "utf-8")) as Record<string, unknown>;
      assert.deepEqual(validateConfigSourceStructure(example), [], file);
    }
    // A default tree loads with no diagnostics.
    withTree(({ cwd, extensionDir }) => {
      assert.deepEqual(loadConfigForReload(cwd, extensionDir).diagnostics, []);
    });
  });

  it("makes schema edits, not code edits, decide what is accepted", () => {
    // Adding a field to a schema copy makes it valid; the installed schema
    // keeps rejecting the same document. Acceptance is governed by the schema.
    const AjvConstructor = createRequire(import.meta.url)("ajv") as new (options?: object) => { compile(schema: object): (value: unknown) => boolean };
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schema.json"), "utf-8")) as Record<string, unknown>;
    const extended = structuredClone(schema) as Record<string, unknown>;
    const properties = structuredClone(schema.properties) as Record<string, unknown>;
    properties.futureKnob = { type: "boolean", description: "A hypothetical future setting." };
    extended.properties = properties;
    const ajv = new AjvConstructor({ allErrors: true, strict: false });
    const extendedValidate = ajv.compile(extended);
    const document = { models: {}, futureKnob: true };
    assert.equal(extendedValidate(document), true);
    assert.ok(validateConfigSourceStructure(document).some((issue) => issue.code === "config.schema_unsupported_field"));
  });

  it("strips metadata centrally without touching user-defined keys", () => {
    assert.deepEqual(stripConfigMetadata({
      description: "root",
      enabled: true,
      rules: [{ description: "note", pattern: "x", model: "quick" }],
      classifier: { description: "cls", criteria: { description: "tier notes", quick: { description: "c", what: "w" } } },
      models: { description: ["v2-style tier"], quick: ["fixture/quick"] },
      tierPolicies: { description: { fallbackTiers: [] } },
    }), {
      enabled: true,
      rules: [{ pattern: "x", model: "quick" }],
      // Under version 1, dynamically keyed maps keep their user-defined
      // `description` keys; fixed-shape section and criterion notes are stripped.
      classifier: { criteria: { description: "tier notes", quick: { what: "w" } } },
      models: { description: ["v2-style tier"], quick: ["fixture/quick"] },
      tierPolicies: { description: { fallbackTiers: [] } },
    });
    assert.deepEqual(stripConfigMetadata({
      schemaVersion: 3,
      models: { description: "metadata", quick: ["fixture/quick"] },
      economics: { scopes: { description: "metadata" } },
    }), {
      schemaVersion: 3,
      models: { quick: ["fixture/quick"] },
      economics: { scopes: {} },
    });
    for (const path of DYNAMIC_CONFIG_MAP_PATHS) {
      assert.ok(path.length > 0, "dynamic map paths stay addressed");
    }
  });
});
