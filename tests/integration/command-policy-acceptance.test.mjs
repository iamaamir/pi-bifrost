import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attemptsDelta,
  assertOffline,
  createHttpFixture,
  readStats,
  reportJson,
  runPi,
  startFakeProviderServer,
  startRpc,
  statsEntriesDelta,
} from "../fixtures/http-pi-harness.mjs";

let server;

// Command-policy fixture policy: narrow child env, project (.pi) config source,
// the synthetic provider discovered with reasoning/context defaults, and only
// the fake provider family enabled. The isolated env / server handshake /
// pinned-Pi / RPC / stats / guarded-shutdown mechanics live in the shared
// fixture (tests/fixtures/http-pi-harness.mjs).
function fixture({ models = [], config = {}, initialConfig, ownership, apiKey = "fixture-only" } = {}) {
  return createHttpFixture({
    prefix: "bifrost-command-policy",
    port: server.port,
    models,
    apiKey,
    modelDefaults: { reasoning: false, contextWindow: 8192, maxTokens: 512 },
    settings: { retry: { enabled: false }, enabledModels: ["fake/*"] },
    config,
    initialConfig,
    ownership,
  });
}

function writeFixtureReceipt(generatedByTier) {
  const ownershipSource = `pi-models-v1-${createHash("sha256").update(JSON.stringify(["fake", "general"])).digest("hex").slice(0, 40)}`;
  return JSON.stringify({ version: 1, sources: {
    [ownershipSource]: { generated: { general: generatedByTier }, tombstones: {} },
  } });
}

describe("pinned Pi command and routing acceptance", { concurrency: 1, timeout: 180_000 }, () => {
  before(async () => { server = await startFakeProviderServer(); });
  after(async () => { await server?.stop(); });

  it("dispatches to the fresh declared billing-class preference and makes no classifier call", async () => {
    const env = fixture({
      models: [
        { id: "metered", cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 } },
        { id: "subscription", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      ],
      config: {
        schemaVersion: 2,
        enabled: true,
        default: "general",
        strategy: "cheapest",
        classifier: { enabled: false },
        models: { general: ["fake/metered", "fake/subscription"] },
        economics: {
          mode: "policy",
          scopes: {
            metered: { kind: "model", model: "fake/metered" },
            subscription: { kind: "model", model: "fake/subscription" },
          },
          sources: [
            { id: "metered-fact", scopeRef: "metered", authority: "declared" },
            { id: "subscription-fact", scopeRef: "subscription", authority: "declared" },
          ],
          sourceOrder: { metered: ["metered-fact"], subscription: ["subscription-fact"] },
          admission: [],
          preference: { billingClass: "subscription" },
          observations: [
            { sourceId: "metered-fact", scopeRef: "metered", billing: "metered", observedAt: 1, expiresAt: 4102444800000, revision: 1, windows: [] },
            { sourceId: "subscription-fact", scopeRef: "subscription", billing: "subscription", observedAt: 1, expiresAt: 4102444800000, revision: 1, windows: [] },
          ],
        },
      },
    });
    try {
      const beforeStats = await readStats(server.port);
      const result = await runPi({ fixture: env, server, args: ["--no-session", "--model", "fake/metered", "-p", "ordinary implementation task"] });
      const afterStats = await readStats(server.port);
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      const delta = statsEntriesDelta(beforeStats, afterStats);
      assert.deepEqual(delta.map((item) => [item.kind, item.model]), [["generation", "subscription"]]);
      const changes = attemptsDelta(beforeStats, afterStats);
      assert.deepEqual(changes, { subscription: 1 });
    } finally { env.cleanup(); }
  });

  it("runs inspect, validate, and a direct-rule preview offline without provider requests", async () => {
    const env = fixture({
      models: [{ id: "chat" }],
      config: {
        enabled: true,
        default: "general",
        classifier: { enabled: true, backend: "prompt", model: "fake/chat" },
        models: { general: ["fake/chat", "missing-fragment"] },
        rules: [{ pattern: "POLICY_ACCEPTANCE_DIRECT", model: "fake/chat" }],
        debug: { enabled: true },
        privateMetadata: "private-config-canary",
      },
      apiKey: "synthetic-provider-secret-canary",
    });
    try {
      const beforeStats = await readStats(server.port);
      const commandOutputs = [];
      for (const command of ["/bifrost inspect --json", "/bifrost validate --json", "/bifrost preview --json POLICY_ACCEPTANCE_DIRECT"]) {
        const result = await runPi({ fixture: env, server, args: ["--no-session", "-p", command] });
        commandOutputs.push(`${command}: ${result.stderr}\n${result.stdout}`);
        assertOffline(result);
        if (command.includes("preview")) {
          const preview = reportJson(result);
          assert.equal(preview.source, "regex");
          assert.equal(preview.selected, "fake/chat");
        } else {
          const diagnostic = reportJson(result);
          assert.equal(diagnostic.kind, command.includes("inspect") ? "inspection" : "validation");
          if (diagnostic.kind === "inspection") {
            const inspected = diagnostic.tiers.flatMap((tier) => tier.candidates).find((candidate) => candidate.model === "fake/chat");
            assert.equal(inspected?.available, true);
            assert.equal(inspected?.auth, "configured");
            assert.equal(inspected?.circuit, "closed");
          } else {
            assert.ok(diagnostic.diagnostics.some((entry) => entry.code === "pool.pattern_unresolved" && entry.entryIndex === 1));
            assert.equal(diagnostic.diagnostics.filter((entry) => entry.severity === "error").length, 0);
            assert.doesNotMatch(JSON.stringify(diagnostic), /missing-fragment/u);
          }
        }
        assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /private-config-canary|synthetic-provider-secret-canary/u);
      }
      const afterStats = await readStats(server.port);
      assert.deepEqual(afterStats.attempts, beforeStats.attempts, `commands made provider attempts:\n${commandOutputs.join("\n")}`);
      assert.deepEqual(afterStats.stats, beforeStats.stats, `commands made provider requests:\n${commandOutputs.join("\n")}`);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests, "offline diagnostics must not refresh provider catalogs");
      const debugPath = join(env.project, "bifrost-debug.jsonl");
      if (existsSync(debugPath)) {
        const debugLog = readFileSync(debugPath, "utf8");
        assert.doesNotMatch(debugLog, /private-config-canary|synthetic-provider-secret-canary/u);
      }
    } finally { env.cleanup(); }
  });

  it("applies only a reviewed Pi-command reconciliation digest and preserves manual config", async () => {
    const original = Buffer.from('{\n  "enabled": true,\n  "default": "general",\n  "classifier": { "enabled": false },\n  "models": { "general": ["fake/old", "handwritten/model"] },\n  "retained": { "owner": "user" }\n}\n');
    const env = fixture({
      models: [{ id: "new" }],
      initialConfig: original,
      ownership: writeFixtureReceipt(["fake/old"]),
    });
    const rpc = startRpc({ fixture: env, server, model: "fake/new" });
    try {
      const beforeStats = await readStats(server.port);
      const previewOutput = await rpc.prompt("/bifrost config reconcile --tier general --provider fake --refresh --json");
      const refreshedPreview = reportJson(previewOutput);
      assert.equal(refreshedPreview.status, "ready", JSON.stringify(refreshedPreview));
      assert.equal(refreshedPreview.inventoryStatus, "complete");
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), original, "preview must not change config bytes");

      const offlinePreviewOutput = await rpc.prompt("/bifrost config reconcile --tier general --provider fake --json");
      const proposal = reportJson(offlinePreviewOutput);
      assert.equal(proposal.status, "ready", JSON.stringify(proposal));
      assert.equal(proposal.proposalDigest, refreshedPreview.proposalDigest);
      assert.ok(proposal.proposalDigest);
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), original, "preview must not change config bytes");

      const configBeforeRejectedApply = readFileSync(join(env.project, "bifrost.json"));
      const receiptBeforeRejectedApply = readFileSync(join(env.project, "bifrost-reconcile-ownership.json"));
      const rejectedOutput = await rpc.prompt(`/bifrost config reconcile --tier general --provider fake --apply --proposal ${"0".repeat(64)} --json`);
      const rejected = reportJson(rejectedOutput);
      assert.notEqual(rejected.status, "committed", "an unreviewed digest must not commit");
      assert.deepEqual(readFileSync(join(env.project, "bifrost.json")), configBeforeRejectedApply);
      assert.deepEqual(readFileSync(join(env.project, "bifrost-reconcile-ownership.json")), receiptBeforeRejectedApply);

      const appliedOutput = await rpc.prompt(`/bifrost config reconcile --tier general --provider fake --apply --proposal ${proposal.proposalDigest} --json`);
      const applied = reportJson(appliedOutput);
      assert.equal(applied.status, "committed");
      const config = JSON.parse(readFileSync(join(env.project, "bifrost.json"), "utf8"));
      assert.deepEqual(config.models.general, ["handwritten/model", "fake/new"]);
      assert.deepEqual(config.retained, { owner: "user" });
      const receiptPath = join(env.project, "bifrost-reconcile-ownership.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const ownership = Object.values(receipt.sources);
      assert.ok(ownership.some((source) => source.generated.general?.includes("fake/new")));
      assert.equal(ownership.some((source) => source.generated.general?.includes("fake/old")), false);
      assert.ok(existsSync(applied.applyResult.configBackupPath));
      assert.deepEqual(readFileSync(applied.applyResult.configBackupPath), original);
      const oldReceipt = writeFixtureReceipt(["fake/old"]);
      assert.ok(existsSync(applied.applyResult.ownershipBackupPath));
      assert.deepEqual(readFileSync(applied.applyResult.ownershipBackupPath), Buffer.from(oldReceipt));
      const afterStats = await readStats(server.port);
      assert.deepEqual(afterStats.attempts, beforeStats.attempts);
      assert.deepEqual(afterStats.stats, beforeStats.stats);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests,
        "the command boundary should not make hidden catalog requests beyond its explicit refresh operation");
    } finally {
      try {
        const stopped = await rpc.close();
        assert.equal(stopped.code, 0);
        assert.equal(stopped.violations, "");
      } finally {
        env.cleanup();
      }
    }
  });

  it("saves generated ownership after long probes without replacing handwritten config", async () => {
    const original = Buffer.from(JSON.stringify({
      enabled: true,
      default: "quick",
      classifier: { enabled: false },
      probe: { timeoutMs: 45_000, concurrency: 2 },
      models: { quick: ["handwritten/model"] },
      metadata: { createdAt: "2020-01-02T03:04:05.000Z" },
    }, null, 2) + "\n");
    const env = fixture({
      models: [{ id: "new" }, { id: "probe-slow" }],
      initialConfig: original,
    });
    try {
      const beforeStats = await readStats(server.port);
      const result = await runPi({
        fixture: env,
        server,
        args: ["--no-session", "-p", "/bifrost init -f --write"],
        timeoutMs: 70_000,
      });
      const afterStats = await readStats(server.port);
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(statsEntriesDelta(beforeStats, afterStats).map((item) => [item.kind, item.model]), [
        ["probe", "new"],
        ["probe", "probe-slow"],
      ]);
      assert.equal(afterStats.catalogRequests, beforeStats.catalogRequests,
        "init probes configured models directly and does not need a provider catalog refresh");
      const saved = JSON.parse(readFileSync(join(env.project, "bifrost.json"), "utf8"));
      assert.equal(saved.metadata.createdAt, "2020-01-02T03:04:05.000Z");
      assert.ok(saved.models.quick.includes("handwritten/model"));
      assert.ok(saved.models.quick.includes("fake/new"));
      assert.ok(saved.models.quick.includes("fake/probe-slow"));
      const receipt = JSON.parse(readFileSync(join(env.project, "bifrost-reconcile-ownership.json"), "utf8"));
      const generated = Object.values(receipt.sources).flatMap((source) => source.generated.quick ?? []);
      assert.ok(generated.includes("fake/new"));
      assert.ok(generated.includes("fake/probe-slow"));
      assert.equal(generated.includes("handwritten/model"), false);
    } finally { env.cleanup(); }
  });

  it("warns on prompt-classifier timeout, falls back locally, then generates on the physical model", async () => {
    const env = fixture({
      models: [{ id: "slow" }, { id: "healthy" }],
      config: {
        enabled: true,
        default: "general",
        strategy: "first",
        classifier: { enabled: true, backend: "prompt", model: "fake/slow", totalTimeoutMs: 1_000 },
        models: { general: ["fake/healthy"] },
        debug: { enabled: true },
      },
    });
    try {
      const beforeStats = await readStats(server.port);
      const result = await runPi({ fixture: env, server, args: ["--no-session", "--model", "fake/healthy", "-p", "a task that needs a model"], timeoutMs: 20_000 });
      const afterStats = await readStats(server.port);
      assertOffline(result);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /classifier time budget expired/i);
      assert.deepEqual(statsEntriesDelta(beforeStats, afterStats).map((item) => [item.kind, item.model]), [
        ["classifier", "slow"],
        ["generation", "healthy"],
      ]);
      const attempts = attemptsDelta(beforeStats, afterStats);
      assert.equal(attempts.slow ?? 0, 1);
      assert.equal(attempts.healthy ?? 0, 1);
    } finally { env.cleanup(); }
  });

  it("uses reloaded v2 model-scope allowance policy for the next Auto turn", async () => {
    const config = {
      schemaVersion: 2,
      enabled: true,
      default: "quick",
      strategy: "first",
      categoryStrategies: { quick: "first" },
      classifier: { enabled: false },
      models: { quick: ["fake/usage-exhausted", "fake/sibling"] },
      reliability: {
        enabled: true,
        stateVersion: 2,
        failureThreshold: 3,
        windowMinutes: 5,
        cooldownMinutes: 1,
        allowanceCooldownScope: "provider",
        cooldownOnAllowanceExhausted: true,
        retryOnAllowanceExhausted: false,
      },
    };
    const env = fixture({ models: [{ id: "usage-exhausted" }, { id: "sibling" }], config });
    const rpc = startRpc({ fixture: env, server, model: "bifrost/auto" });
    try {
      const migrated = await rpc.prompt("/bifrost reliability migrate --fresh");
      assert.equal(migrated.response.data.disposition, "handled");
      assert.ok(existsSync(join(env.project, "bifrost-reliability-v2.json")), "the registered migration command must initialize v2 state");

      const changed = { ...config, reliability: { ...config.reliability, allowanceCooldownScope: "model" } };
      writeFileSync(join(env.project, "bifrost.json"), JSON.stringify(changed));
      const reloaded = await rpc.prompt("/bifrost reload");
      assert.equal(reloaded.response.data.disposition, "handled");

      const before = await readStats(server.port);
      const firstTurn = await rpc.userTurn("first ordinary coding task");
      const afterFailure = await readStats(server.port);
      assert.equal(firstTurn.response.data.disposition, "started");
      const failureDelta = attemptsDelta(before, afterFailure);
      assert.equal(failureDelta["usage-exhausted"] ?? 0, 1,
        `expected one usage-exhausted provider call; stats delta: ${JSON.stringify(statsEntriesDelta(before, afterFailure))}`);
      assert.equal(failureDelta.sibling ?? 0, 0,
        "allowance retry is disabled, so the failed turn must stop on its original model");

      const providerStatePath = join(env.project, "bifrost-provider-reliability.json");
      if (existsSync(providerStatePath)) {
        const providerState = JSON.parse(readFileSync(providerStatePath, "utf8"));
        assert.equal(Object.keys(providerState.scopes ?? {}).some((key) => key.includes("bifrost-provider-usage/fake")), false,
          "the reloaded model scope must not write a provider usage pause");
      }
      const statePath = join(env.project, "bifrost-reliability-v2.json");
      const reliabilityState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(Object.keys(reliabilityState.scopes ?? {}).some((key) => key.includes("fake/usage-exhausted")),
        "the allowance failure should be recorded against the failed model");

      await rpc.userTurn("second ordinary coding task");
      const afterSecond = await readStats(server.port);
      const secondDelta = attemptsDelta(afterFailure, afterSecond);
      assert.equal(secondDelta["usage-exhausted"] ?? 0, 0,
        "the model-scoped pause must exclude the failed model on the following turn");
      assert.equal(secondDelta.sibling ?? 0, 1,
        "the next Auto turn should use the healthy sibling on the same provider");
    } finally {
      try {
        const stopped = await rpc.close();
        assert.equal(stopped.code, 0);
        assert.equal(stopped.violations, "");
      } finally {
        env.cleanup();
      }
    }
  });
});
