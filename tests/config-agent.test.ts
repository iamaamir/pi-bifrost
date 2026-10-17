// Deterministic coverage for the agent-facing Bifrost configuration tool.
// Every case uses a fake Pi model registry and local temp files: no provider
// call, no classifier call, and no live config is touched.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  BIFROST_CONFIG_TOOL_NAME,
  buildConfigAgentCatalog,
  createBifrostConfigTool,
  type ConfigAgentApplyResult,
  type ConfigAgentCheckResult,
  type ConfigAgentInspectResult,
  type ConfigAgentPreviewResult,
} from "../config-agent.ts";
import { loadConfigForReload } from "../config.ts";
import { makeModel } from "./helpers.ts";

interface HarnessOptions {
  readonly available?: readonly Model<Api>[];
  readonly knownOnly?: readonly Model<Api>[];
  readonly hasUI?: boolean;
  readonly confirm?: boolean;
  readonly reload?: boolean;
  readonly write?: (path: string, text: string) => void;
}

function freshHarness(options: HarnessOptions = {}) {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-agent-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  // The extension layer is the bundled config that ships with the package, so
  // the harness composes exactly the layers a real install starts from.
  const extensionDir = fileURLToPath(new URL("..", import.meta.url));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const available: Model<Api>[] = [...(options.available ?? [
    makeModel("alpha", "strong", 5, 15, 200_000),
    makeModel("beta", "code", 0.5, 1.5, 128_000),
    makeModel("gamma", "review", 2, 6, 128_000),
  ])];
  const knownOnly: Model<Api>[] = [...(options.knownOnly ?? [makeModel("beta", "retired", 1, 1, 64_000)])];
  let hasUI = options.hasUI ?? true;
  let confirmResult = options.confirm ?? true;
  let reloadResult = options.reload ?? true;
  let classifyCalls = 0;
  let reloadCalls = 0;
  const confirmations: { title: string; message: string }[] = [];

  const registry = {
    getAvailable: () => available,
    getAll: () => [...available, ...knownOnly],
    find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    classify: () => {
      classifyCalls += 1;
      throw new Error("no test may invoke a classifier");
    },
    refresh: () => {
      throw new Error("no test may refresh the catalog");
    },
  };

  const ctx = {
    cwd,
    mode: "tui",
    get hasUI() { return hasUI; },
    ui: {
      confirm: (title: string, message: string) => {
        confirmations.push({ title, message });
        return confirmResult;
      },
      notify: () => {},
    },
    modelRegistry: registry,
  } as unknown as ExtensionToolContext;

  const tool = createBifrostConfigTool({
    extensionDir,
    reload: () => {
      reloadCalls += 1;
      return reloadResult;
    },
    ...(options.write ? { write: options.write } : {}),
  });
  type ToolParams = Parameters<typeof tool.execute>[1];

  return {
    cwd,
    agentDir,
    extensionDir,
    ctx,
    tool,
    writeFile(relative: string, value: unknown): void {
      const path = join(cwd, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    },
    readFile(relative: string): string | undefined {
      const path = join(cwd, relative);
      return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
    },
    setAvailable(models: Model<Api>[]) {
      available.length = 0;
      available.push(...models);
    },
    setConfirm(value: boolean) { confirmResult = value; },
    setHasUI(value: boolean) { hasUI = value; },
    setReload(value: boolean) { reloadResult = value; },
    confirmations: () => confirmations,
    classifyCalls: () => classifyCalls,
    reloadCalls: () => reloadCalls,
    projectConfigPath: () => join(cwd, ".pi", "bifrost.json"),
    run: (params: Record<string, unknown>) =>
      tool.execute("call-1", params as unknown as ToolParams, undefined, undefined, ctx),
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof freshHarness>;

function detailsOf<T>(result: { details: unknown }): T {
  return result.details as T;
}

function contentOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function keysUnder(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysUnder(entry, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      found.add(key);
      keysUnder(entry, found);
    }
  }
  return found;
}

async function checkedCandidate(harness: Harness, params: Record<string, unknown>) {
  const result = await harness.run({ operation: "check", ...params });
  const details = detailsOf<ConfigAgentCheckResult>(result);
  assert.equal(details.status, "ok", details.issues.map((issue) => issue.message).join("; "));
  assert.ok(details.proposalDigest && details.guards);
  return { details, result };
}

function applyParams(details: ConfigAgentCheckResult, params: Record<string, unknown>): Record<string, unknown> {
  return {
    operation: "apply",
    ...params,
    proposalDigest: details.proposalDigest,
    sourceDigest: details.guards!.sourceDigest,
    effectiveDigest: details.guards!.effectiveDigest,
    catalogDigest: details.guards!.catalogDigest,
  };
}

describe("agent-facing configuration inspection", () => {
  it("reports the real catalog, config layers, and effective policy without secrets", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "fast",
        models: { fast: ["beta/code"], strict: ["alpha/strong"] },
        tierPolicies: { strict: { fallbackTiers: [] } },
      });

      const result = await harness.run({ operation: "inspect" });
      const details = detailsOf<ConfigAgentInspectResult>(result);
      const text = contentOf(result);

      assert.equal(result.isError, false);
      assert.equal(details.operation, "inspect");
      const project = details.layers.find((layer) => layer.layer === "project");
      assert.equal(project?.exists, true);
      assert.equal(project?.editable, true);
      assert.deepEqual(project?.fields, ["default", "models", "schemaVersion", "tierPolicies"]);
      assert.equal(details.layers.find((layer) => layer.layer === "extension")?.editable, false);
      assert.equal(details.layers.find((layer) => layer.layer === "workspace")?.exists, false);

      assert.equal(details.routing.defaultTier, "fast");
      assert.equal(details.routing.schemaVersion, 2);
      // The bundled extension layer always contributes the three baseline tiers.
      const tiers = new Map(details.routing.tiers.map((tier) => [tier.tier, tier]));
      assert.deepEqual(tiers.get("fast")?.pool, ["beta/code"]);
      assert.deepEqual(tiers.get("strict")?.pool, ["alpha/strong"]);
      assert.deepEqual(tiers.get("strict")?.fallbackTiers, []);
      assert.deepEqual(tiers.get("general")?.pool, []);
      assert.equal(details.issues.filter((issue) => issue.severity === "error").length, 0);

      // The inventory mirrors the registry, including cost and context metadata.
      assert.match(text, /alpha\/strong \(\$20\.00\/1M tokens, ctx 200000/);
      assert.match(text, /beta\/code \(\$2\.00\/1M tokens, ctx 128000/);
      assert.doesNotMatch(text, /beta\/retired/);

      // No credential or account field may appear anywhere in the payload.
      const forbidden = /(api[_-]?key|secret|password|bearer|authorization|credential)/i;
      for (const key of keysUnder(details)) assert.doesNotMatch(key, forbidden);
      assert.doesNotMatch(text, forbidden);
      assert.ok(details.restrictions.some((entry) => /prompt cache/i.test(entry)));
    } finally {
      harness.cleanup();
    }
  });

  it("narrows the reported inventory to one provider without changing the totals", async () => {
    const harness = freshHarness();
    try {
      const all = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(all.inventory.length, 3);
      assert.equal(all.availableModelCount, 3);
      assert.equal(all.inventoryProvider, undefined);

      const filtered = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect", provider: "beta" }));
      assert.deepEqual(filtered.inventory.map((model) => model.key), ["beta/code"]);
      assert.equal(filtered.availableModelCount, 3);
      assert.equal(filtered.inventoryProvider, "beta");
      assert.equal(filtered.knownUnavailableCount, 1);
      assert.match(contentOf(await harness.run({ operation: "inspect", provider: "beta" })), /available models: 1 of 3/);
      assert.match(contentOf(await harness.run({ operation: "inspect", provider: "beta" })), /known but unavailable models: 1/);

      const empty = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect", provider: "zeta" }));
      assert.deepEqual(empty.inventory, []);
      assert.ok(empty.notes.some((note) => /No available model belongs to provider "zeta"/.test(note)));
    } finally {
      harness.cleanup();
    }
  });

  it("marks the route file as an override of config rules", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost-routes.json", []);
      const details = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(details.routing.routeFileOverridesRules, true);
      assert.match(details.routing.rules.routeFile ?? "", /bifrost-routes\.json$/);
    } finally {
      harness.cleanup();
    }
  });
});

describe("candidate validation reuses Bifrost semantics", () => {
  it("rejects an unknown default tier and writes nothing", async () => {
    const harness = freshHarness();
    try {
      const result = await harness.run({ operation: "check", patch: { default: "ghost" } });
      const details = detailsOf<ConfigAgentCheckResult>(result);
      assert.equal(result.isError, true);
      assert.equal(details.status, "rejected");
      assert.equal(details.writeEligible, false);
      assert.ok(details.issues.some((issue) => issue.severity === "error" && /ghost/.test(issue.message)));
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("enforces the existing schema-version rules for tierPolicies and fallback cycles", async () => {
    const harness = freshHarness();
    try {
      const missingVersion = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          models: { only: ["alpha/strong"] },
          default: "only",
          tierPolicies: { only: { fallbackTiers: [] } },
        },
      }));
      assert.equal(missingVersion.status, "rejected");
      assert.ok(missingVersion.issues.some((issue) => /schemaVersion 2/.test(issue.message)));

      const cycle = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "a",
          models: { a: ["alpha/strong"], b: ["beta/code"] },
          tierPolicies: { a: { fallbackTiers: ["b"] }, b: { fallbackTiers: ["a"] } },
        },
      }));
      // The per-source pre-check rejects a cyclic source-local policy before merge.
      assert.equal(cycle.status, "rejected");
      assert.ok(cycle.issues.some((issue) => /project config tierPolicies contains an invalid source-local policy/.test(issue.message)));

      const valid = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "a",
          models: { a: ["alpha/strong"] },
          tierPolicies: { a: { fallbackTiers: [] } },
        },
      }));
      assert.equal(valid.status, "ok");
      assert.equal(valid.writeEligible, true);
      assert.deepEqual(valid.changes.map((change) => change.field), ["default", "models", "schemaVersion", "tierPolicies"]);
    } finally {
      harness.cleanup();
    }
  });

  it("separates known-unavailable, unknown, and fuzzy pool entries", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "mixed",
          models: { mixed: ["beta/retired", "nope/missing", "beta"] },
        },
      }));
      const byEntry = new Map(details.references.map((reference) => [reference.entry, reference.status]));
      assert.equal(byEntry.get("beta/retired"), "known_unavailable");
      assert.equal(byEntry.get("nope/missing"), "unknown");
      assert.equal(byEntry.has("beta"), false, "a fuzzy entry that matches a model is not a reference problem");
      assert.match(contentOf(await harness.run({ operation: "check", candidate: { models: { mixed: ["beta/retired"] }, default: "mixed" } })), /known_unavailable/);
    } finally {
      harness.cleanup();
    }
  });

  it("compares the effective policy before and after without writing", async () => {
    const harness = freshHarness();
    try {
      const before = harness.readFile(".pi/bifrost.json");
      const { details, result } = await checkedCandidate(harness, {
        candidate: {
          schemaVersion: 2,
          default: "fast",
          models: { fast: ["beta/code"], deep: ["alpha/strong"] },
        },
      });
      const text = contentOf(result);
      assert.equal(details.effectiveBefore?.default, "general");
      assert.equal((details.effectiveAfter as { default?: string }).default, "fast");
      assert.deepEqual(details.newlyEligibleModels, ["alpha/strong", "beta/code"]);
      assert.deepEqual(details.removedModels, []);
      assert.equal(harness.readFile(".pi/bifrost.json"), before);

      // The agent can only pass back what the model-facing report contains.
      for (const digest of [
        details.proposalDigest,
        details.guards?.sourceDigest,
        details.guards?.effectiveDigest,
        details.guards?.catalogDigest,
      ]) {
        if (digest) assert.ok(text.includes(digest), `the report must print the full ${digest.slice(0, 8)}… digest`);
      }
      assert.match(text, /apply digests \(pass these back unchanged\):/);
    } finally {
      harness.cleanup();
    }
  });
});

describe("preview is offline, deterministic, and non-mutating", () => {
  const threeRoleGoal = {
    schemaVersion: 2,
    default: "implement",
    models: {
      orchestrator: ["alpha/strong"],
      implement: ["beta/code"],
      review: ["gamma/review"],
    },
    classifier: { enabled: false },
    categoryStrategies: { orchestrator: "first", implement: "cheapest", review: "first" },
    // The bundled default rules point at the baseline tier names, so a custom
    // three-role policy supplies its own rule set.
    rules: [{ pattern: "\\breview\\b", model: "review" }],
    tierPolicies: {
      orchestrator: { fallbackTiers: [] },
      review: { fallbackTiers: [] },
      implement: { fallbackTiers: ["review"] },
    },
  };

  it("resolves every tier and marks classifier-free cases deterministic", async () => {
    const harness = freshHarness();
    try {
      const before = harness.readFile(".pi/bifrost.json");
      const result = await harness.run({
        operation: "preview",
        candidate: threeRoleGoal,
        prompts: [
          "orchestrator plan the migration",
          "please review this diff for correctness",
          "make the change",
        ],
      });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      assert.equal(details.status, "ok");
      assert.equal(details.network, "disabled");
      assert.equal(details.promptExecution, "none");
      assert.equal(harness.classifyCalls(), 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), before);
      assert.match(contentOf(result), /apply digests \(pass these back unchanged\):/);
      assert.match(contentOf(result), /proposalDigest: [a-f0-9]{64}/);

      const tiers = new Map(details.tiers.map((tier) => [tier.tier, tier]));
      assert.equal(tiers.get("orchestrator")?.selected, "alpha/strong");
      assert.equal(tiers.get("implement")?.selected, "beta/code");
      assert.equal(tiers.get("review")?.selected, "gamma/review");

      const byPrompt = new Map(details.cases.map((entry) => [entry.prompt, entry]));
      const inline = byPrompt.get("orchestrator plan the migration");
      assert.equal(inline?.decidedBy, "inline_tier_prefix");
      assert.equal(inline?.confidence, "deterministic");
      assert.equal(inline?.selected, "alpha/strong");

      const rule = byPrompt.get("please review this diff for correctness");
      assert.equal(rule?.decidedBy, "regex_rule");
      assert.equal(rule?.tier, "review");
      assert.equal(rule?.selected, "gamma/review");
      assert.equal(rule?.confidence, "deterministic");

      const fallback = byPrompt.get("make the change");
      assert.equal(fallback?.decidedBy, "default_tier");
      assert.equal(fallback?.confidence, "deterministic", "a disabled classifier cannot change the default-tier route");
      assert.equal(fallback?.selected, "beta/code");
    } finally {
      harness.cleanup();
    }
  });

  it("marks classifier-dependent cases when the candidate enables the classifier", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "implement",
          models: { implement: ["beta/code"], review: ["gamma/review"] },
          classifier: { enabled: true },
        },
        prompts: ["make the change", "please review this diff"],
      }));
      const byPrompt = new Map(details.cases.map((entry) => [entry.prompt, entry]));
      assert.equal(byPrompt.get("make the change")?.confidence, "classifier_dependent");
      assert.equal(byPrompt.get("please review this diff")?.confidence, "deterministic");
      assert.ok(details.notes.some((note) => /classifier/.test(note)));
    } finally {
      harness.cleanup();
    }
  });

  it("shows an explicit fallback boundary instead of silently escalating", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "expensive",
          models: { expensive: ["alpha/strong"], bounded: ["beta/retired"], legacy: ["beta/retired"] },
          classifier: { enabled: false },
          tierPolicies: { bounded: { fallbackTiers: [] } },
        },
        prompts: [],
      }));
      const tiers = new Map(details.tiers.map((tier) => [tier.tier, tier]));
      assert.equal(tiers.get("bounded")?.selected, undefined, "a terminal boundary must not resolve to another model");
      assert.equal(tiers.get("legacy")?.selected, "alpha/strong", "a tier without a policy keeps legacy default-tier fallback");
      assert.deepEqual(tiers.get("bounded")?.unknownUnavailable, ["beta/retired"]);
    } finally {
      harness.cleanup();
    }
  });

  it("blocks preview on an invalid candidate and never dispatches", async () => {
    const harness = freshHarness();
    try {
      const result = await harness.run({ operation: "preview", candidate: { default: "ghost" }, prompts: ["anything"] });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      assert.equal(result.isError, true);
      assert.equal(details.status, "blocked");
      assert.deepEqual(details.cases, []);
      assert.equal(harness.classifyCalls(), 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });
});

describe("config layers stay respected", () => {
  it("merges the proposed source over other layers and leaves them untouched", async () => {
    const harness = freshHarness();
    try {
      const workspace = { default: "general", models: { general: ["alpha/strong"] }, $schema: "../schema.json" };
      harness.writeFile("bifrost.json", workspace);
      const before = harness.readFile("bifrost.json");

      const { details } = await checkedCandidate(harness, {
        source: "project",
        patch: { default: "cheap", models: { cheap: ["beta/code"] } },
      });
      assert.equal((details.effectiveAfter as { default?: string }).default, "cheap");
      const mergedModels = (details.effectiveAfter as { models?: Record<string, unknown> }).models ?? {};
      assert.ok(Object.hasOwn(mergedModels, "cheap"), "the proposed tier is effective");
      assert.deepEqual(mergedModels.general, ["alpha/strong"], "the workspace pool survived the project patch");
      assert.deepEqual(details.nextSource?.$schema, undefined, "the project source did not inherit the workspace $schema");

      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, {
        source: "project",
        patch: { default: "cheap", models: { cheap: ["beta/code"] } },
      })));
      assert.equal(applied.status, "ok");
      assert.equal(harness.readFile("bifrost.json"), before, "the workspace layer was not rewritten");
      const stored = JSON.parse(harness.readFile(".pi/bifrost.json") ?? "{}") as Record<string, unknown>;
      assert.deepEqual(Object.keys(stored).sort(), ["default", "models"]);

      const reloaded = loadConfigForReload(harness.cwd, harness.extensionDir).config;
      assert.equal(reloaded.default, "cheap");
      assert.deepEqual(reloaded.models?.general, ["alpha/strong"]);
      assert.deepEqual(reloaded.models?.cheap, ["beta/code"]);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a source it cannot safely write", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", "{ \"models\": {} ");
      const details = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: { default: "fast" } }));
      assert.equal(details.status, "usage");
      assert.match(details.notes.join(" "), /not valid JSON/);
      assert.equal(harness.readFile(".pi/bifrost.json"), "{ \"models\": {} ");
    } finally {
      harness.cleanup();
    }
  });
});

describe("apply requires approval, matching digests, and proves the result", () => {
  const candidate = {
    schemaVersion: 2 as const,
    default: "fast",
    models: { fast: ["beta/code"], deep: ["alpha/strong"] },
  };

  it("writes the approved candidate and verifies the reload", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", { models: { legacy: ["gamma/review"] }, default: "legacy" });
      const { details } = await checkedCandidate(harness, { candidate });

      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      assert.equal(applied.applied, true);
      assert.equal(applied.reloaded, true);
      assert.equal(applied.verified, true);
      assert.equal(harness.reloadCalls(), 1);
      const appliedTiers = new Map(applied.routing?.tiers.map((tier) => [tier.tier, tier]));
      assert.deepEqual(appliedTiers.get("fast")?.pool, ["beta/code"]);
      assert.deepEqual(appliedTiers.get("deep")?.pool, ["alpha/strong"]);

      const confirmations = harness.confirmations();
      assert.equal(confirmations.length, 1);
      assert.equal(confirmations[0]?.title, "Apply this Bifrost configuration?");
      assert.match(confirmations[0]?.message ?? "", /Source: project/);
      assert.match(confirmations[0]?.message ?? "", /replace models/);
      assert.match(confirmations[0]?.message ?? "", /deep \(first\): alpha\/strong/);
      assert.match(confirmations[0]?.message ?? "", /No other config source is modified/);

      const stored = JSON.parse(harness.readFile(".pi/bifrost.json") ?? "{}") as Record<string, unknown>;
      assert.deepEqual(stored, details.nextSource);
      assert.equal(loadConfigForReload(harness.cwd, harness.extensionDir).config.default, "fast");
    } finally {
      harness.cleanup();
    }
  });

  it("fails closed without an interactive confirmation", async () => {
    const harness = freshHarness({ hasUI: false });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "approval_required");
      assert.equal(applied.applied, false);
      assert.equal(harness.confirmations().length, 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("writes nothing when the user declines", async () => {
    const harness = freshHarness({ confirm: false });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "declined");
      assert.equal(applied.applied, false);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("requires the digests from check or preview", async () => {
    const harness = freshHarness();
    try {
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", candidate }));
      assert.equal(applied.status, "usage");
      assert.match(applied.reason ?? "", /proposalDigest/);
      assert.equal(harness.confirmations().length, 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a proposal whose candidate bytes changed", async () => {
    const harness = freshHarness();
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const edited = { ...candidate, models: { ...candidate.models, extra: ["gamma/review"] } };
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate: edited })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /checked proposal/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a proposal after the selected source changed", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", { default: "legacy", models: { legacy: ["gamma/review"] } });
      const { details } = await checkedCandidate(harness, { candidate });
      harness.writeFile(".pi/bifrost.json", { default: "edited", models: { edited: ["gamma/review"] } });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /selected source changed/);
      assert.match(harness.readFile(".pi/bifrost.json") ?? "", /edited/);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a proposal after another layer changed", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile("bifrost.json", { default: "general", models: { general: ["alpha/strong"] } });
      const { details } = await checkedCandidate(harness, { source: "project", candidate });
      harness.writeFile("bifrost.json", { default: "moved", models: { general: ["alpha/strong"] } });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { source: "project", candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /another configuration source changed/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a proposal after the model inventory changed", async () => {
    const harness = freshHarness();
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      harness.setAvailable([makeModel("beta", "code", 0.5, 1.5, 128_000), makeModel("alpha", "strong", 5, 15, 200_000)]);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /model inventory changed/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("preserves the previous config when the write fails", async () => {
    const writeError = new Error("disk full");
    const harness = freshHarness({ write: () => { throw writeError; } });
    try {
      harness.writeFile(".pi/bifrost.json", { default: "legacy", models: { legacy: ["gamma/review"] } });
      const before = harness.readFile(".pi/bifrost.json");
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "write_failed");
      assert.equal(applied.applied, false);
      assert.equal(harness.readFile(".pi/bifrost.json"), before);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a saved-but-not-activated configuration honestly", async () => {
    const harness = freshHarness({ reload: false });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "reload_failed");
      assert.equal(applied.applied, true, "the approved file is on disk");
      assert.equal(applied.reloaded, false);
      assert.ok(applied.notes.some((note) => /\/bifrost reload/.test(note)));
    } finally {
      harness.cleanup();
    }
  });
});

describe("goal-driven scenarios", () => {
  it("composes a three-role workflow without a classifier and with a terminal boundary", async () => {
    const harness = freshHarness();
    try {
      const goal = {
        schemaVersion: 2,
        default: "implement",
        models: {
          orchestrator: ["alpha/strong"],
          implement: ["beta/code"],
          review: ["gamma/review"],
        },
        classifier: { enabled: false },
        categoryStrategies: { orchestrator: "first", implement: "first", review: "first" },
        tierPolicies: {
          orchestrator: { fallbackTiers: [] },
          implement: { fallbackTiers: ["review"] },
          review: { fallbackTiers: [] },
        },
      };
      const { details } = await checkedCandidate(harness, { candidate: goal });
      assert.equal(details.routingAfter?.classifier.enabled, false);
      const tiers = new Map(details.routingAfter?.tiers.map((tier) => [tier.tier, tier]));
      assert.deepEqual(tiers.get("orchestrator")?.pool, ["alpha/strong"]);
      assert.deepEqual(tiers.get("implement")?.pool, ["beta/code"]);
      assert.deepEqual(tiers.get("review")?.pool, ["gamma/review"]);
      assert.deepEqual(tiers.get("implement")?.fallbackTiers, ["review"]);
      assert.equal(details.references.length, 0);
      assert.equal(details.writeEligible, true);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined, "no configuration changed before approval");
      const text = contentOf(await harness.run({ operation: "check", candidate: goal }));
      assert.doesNotMatch(text, /guarantee|guaranteed|optimal/i);
    } finally {
      harness.cleanup();
    }
  });

  it("prefers the cheapest eligible model for a budget-first goal", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "work",
          models: { work: ["alpha/strong", "beta/code", "gamma/review"] },
          classifier: { enabled: false },
          categoryStrategies: { work: "cheapest" },
        },
      }));
      assert.equal(details.tiers[0]?.selected, "beta/code");
      assert.match(details.notes.join(" "), /fixed random source/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a quality-first goal explicit about the models it references", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "reason",
          models: { reason: ["alpha/strong"], small: ["beta/code"] },
          categoryStrategies: { reason: "first", small: "cheapest_input" },
          tierPolicies: { reason: { fallbackTiers: [] }, small: { fallbackTiers: ["reason"] } },
        },
      }));
      assert.equal(details.status, "ok");
      assert.deepEqual(details.newlyEligibleModels, ["alpha/strong", "beta/code"]);
      assert.equal(details.routingAfter?.economics.spendCap, false);
    } finally {
      harness.cleanup();
    }
  });

  it("accepts a declared subscription preference without claiming enforcement", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "work",
          models: { work: ["alpha/strong", "beta/code"] },
          economics: {
            mode: "policy",
            scopes: {
              strong: { kind: "model", model: "alpha/strong" },
              cheap: { kind: "model", model: "beta/code" },
            },
            sources: [
              { id: "strong-declared", scopeRef: "strong", authority: "declared" },
              { id: "cheap-declared", scopeRef: "cheap", authority: "declared" },
            ],
            sourceOrder: { strong: ["strong-declared"], cheap: ["cheap-declared"] },
            admission: [],
            preference: { billingClass: "subscription" },
            observations: [
              { sourceId: "strong-declared", scopeRef: "strong", billing: "subscription", observedAt: 1, expiresAt: 4_102_444_800_000, revision: 1, windows: [] },
              { sourceId: "cheap-declared", scopeRef: "cheap", billing: "metered", observedAt: 1, expiresAt: 4_102_444_800_000, revision: 1, windows: [] },
            ],
          },
        },
      }));
      const errors = details.issues.filter((issue) => issue.severity === "error");
      assert.deepEqual(errors.map((issue) => issue.message), []);
      assert.equal(details.routingAfter?.economics.configured, true);
      assert.equal(details.routingAfter?.economics.spendCap, false);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a requested model that the catalog does not have", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "work",
          models: { work: ["zeta/best-in-class", "beta/code"] },
        },
      }));
      assert.deepEqual(details.references, [{
        tier: "work",
        entry: "zeta/best-in-class",
        status: "unknown",
        matches: [],
      }]);
      assert.ok(details.notes.some((note) => /matches no catalog model/.test(note)));
      assert.match(contentOf(await harness.run({ operation: "check", candidate: { schemaVersion: 2, default: "work", models: { work: ["zeta/best-in-class"] } } })), /unknown/);
    } finally {
      harness.cleanup();
    }
  });

  it("cannot satisfy a request for prompt-cache guarantees and says so", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.ok(details.restrictions.some((entry) => /does not manage provider prompt caches/.test(entry)));
      const text = contentOf(await harness.run({ operation: "inspect" }));
      assert.doesNotMatch(text, /guaranteed cache|cache-hit expectation/i);
    } finally {
      harness.cleanup();
    }
  });
});

describe("tool surface", () => {
  it("exposes one cohesive tool with a stable name", () => {
    const harness = freshHarness();
    try {
      assert.equal(harness.tool.name, BIFROST_CONFIG_TOOL_NAME);
      assert.equal(harness.tool.name, "bifrost_config");
      assert.match(harness.tool.description, /Inspect and safely change Bifrost's routing configuration/);
      assert.ok(harness.tool.promptSnippet);
      const properties = (harness.tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      assert.deepEqual(Object.keys(properties).sort(), [
        "candidate", "catalogDigest", "effectiveDigest", "operation", "patch",
        "prompts", "proposalDigest", "provider", "remove", "source", "sourceDigest",
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects an unknown operation instead of guessing", async () => {
    const harness = freshHarness();
    try {
      const result = await harness.run({ operation: "rewrite-everything" });
      assert.equal(result.isError, true);
      assert.match(contentOf(result), /unknown operation/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("builds the catalog from physical chat models only", () => {
    const classifierEntry = { ...makeModel("alpha", "judge", 0, 0), type: "classifier" } as unknown as Model<Api>;
    const virtualEntry = { ...makeModel("bifrost", "auto", 0, 0), api: "pi-virtual" } as unknown as Model<Api>;
    const incomplete = { ...makeModel("beta", "nocost", 0, 0) } as unknown as Model<Api>;
    (incomplete as { cost?: unknown }).cost = undefined;
    const catalog = buildConfigAgentCatalog(
      [makeModel("beta", "code", 1, 2), classifierEntry, virtualEntry, incomplete],
      [makeModel("beta", "code", 1, 2), makeModel("beta", "retired", 1, 1), classifierEntry, virtualEntry, incomplete],
    );
    assert.deepEqual(catalog.available.map((model) => model.key), ["beta/code"]);
    assert.deepEqual(catalog.known.map((model) => model.key), ["beta/code", "beta/retired"]);
    assert.deepEqual(catalog.knownKeys, ["beta/code", "beta/nocost", "beta/retired"]);
    assert.deepEqual(catalog.metadataIncomplete, ["beta/nocost"]);
  });
});
