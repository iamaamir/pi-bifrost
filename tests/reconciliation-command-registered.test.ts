import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BIFROST_COMMAND_OPTIONS, BIFROST_JSON_PREFIX, createCommandRouter, type BifrostState } from "../commands.ts";
import { buildInitOwnershipReceipt } from "../reconciliation-command.ts";
import { makeModel } from "./helpers.ts";

function withCwd<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const prior = process.cwd();
  const directory = fs.mkdtempSync(join(tmpdir(), "bifrost-reconcile-command-"));
  process.chdir(directory);
  return run(directory).finally(() => {
    process.chdir(prior);
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

function makeHarness(options: {
  readonly models?: Array<{ provider: string; id: string; api: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
  readonly refresh?: () => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
  readonly authConfigured?: boolean;
  readonly registryError?: string;
  readonly evidence?: Record<string, { status: "complete" | "partial" | "stale"; refreshedAt: number }>;
}) {
  const models = options.models ?? [makeModel("openai", "new-model", 1, 1)];
  const registry = {
    getAll: () => models,
    getAvailable: () => models,
    getProvider: (provider: string) => provider === "openai" ? { id: provider } : undefined,
    getProviderAuthStatus: () => ({ configured: options.authConfigured ?? true }),
    getError: () => options.registryError,
    refresh: options.refresh ?? (async () => ({ aborted: false, errors: new Map() })),
  };
  const state = {
    config: { enabled: true, default: "general", strategy: "first" as const, models: { general: ["manual/model"] } },
    enabled: true,
    classifierEnabled: true,
    pinned: false,
    tierPolicyValid: true,
    cacheEntries: [],
    reliabilityStore: {
      getState: () => ({ version: 1 as const, models: {} }),
      openCircuitCount: () => 0,
      reload: () => {},
    },
    classifierMetricsStore: {
      snapshot: () => ({ version: 1, model: "none", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0 }),
      reload: () => {},
    },
    extensionDir: join(process.cwd(), "extension"),
    effectiveClassifierBackend: () => ({ backend: "prompt", reason: "fixture", auto: true }),
    getPipeline: () => ({ classify: async () => ({ kind: "unclassified" as const }) }),
    invalidatePipeline: () => {},
    saveModeState: () => {},
    registryInventoryEvidence: options.evidence ?? {},
  };
  const ctx = {
    hasUI: false,
    mode: "rpc",
    signal: new AbortController().signal,
    model: models[0],
    modelRegistry: registry,
  };
  return { state: state as unknown as BifrostState, ctx: ctx as never, registry };
}

async function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const captured: string[] = [];
  console.error = (...values: unknown[]) => { captured.push(values.map(String).join(" ")); };
  try { await run(); }
  finally { console.error = original; }
  return captured;
}

function jsonReport(lines: readonly string[]): Record<string, unknown> {
  const line = lines.find((entry) => entry.startsWith(BIFROST_JSON_PREFIX));
  assert.ok(line, `expected a ${BIFROST_JSON_PREFIX} report`);
  return JSON.parse(line.slice(BIFROST_JSON_PREFIX.length)) as Record<string, unknown>;
}

describe("registered config reconciliation command", () => {
  it("is discoverable and previews offline, then applies only the exact reviewed source proposal", async () => {
    assert.ok(BIFROST_COMMAND_OPTIONS.some((item) => item.value === "config reconcile"));
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const original = Buffer.from(JSON.stringify({ enabled: true, models: { general: ["manual/model"] }, retained: { yes: true } }, null, 2) + "\n");
      fs.writeFileSync(join(configDir, "bifrost.json"), original);
      const evidence = { openai: { status: "complete" as const, refreshedAt: Date.now() } };
      let refreshCalls = 0;
      const h = makeHarness({ evidence, refresh: async () => { refreshCalls++; throw new Error("must not refresh preview/apply"); } });
      const dispatch = createCommandRouter(h.state);
      const previewLines = await captureStderr(() => dispatch("config reconcile --tier general --provider openai --json", h.ctx));
      const preview = jsonReport(previewLines);
      assert.equal(preview.status, "ready");
      assert.equal(preview.source, "project");
      assert.equal(preview.refresh, undefined);
      assert.equal(refreshCalls, 0);
      assert.deepEqual(fs.readFileSync(join(configDir, "bifrost.json")), original);
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false);

      const proposalDigest = preview.proposalDigest;
      assert.equal(typeof proposalDigest, "string");
      const applyLines = await captureStderr(() => dispatch(
        `config reconcile --tier general --provider openai --apply --proposal ${String(proposalDigest)} --json`,
        h.ctx,
      ));
      const applied = jsonReport(applyLines);
      assert.equal(applied.status, "committed");
      assert.equal(refreshCalls, 0);
      const updated = JSON.parse(fs.readFileSync(join(configDir, "bifrost.json"), "utf8")) as { models: Record<string, string[]>; retained: unknown };
      assert.deepEqual(updated.models.general, ["manual/model", "openai/new-model"]);
      assert.deepEqual(updated.retained, { yes: true });
      const receipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8")) as { sources: Record<string, { generated: Record<string, string[]> }> };
      assert.deepEqual(Object.values(receipt.sources).flatMap((source) => source.generated.general ?? []), ["openai/new-model"]);
      assert.ok(fs.existsSync(String((applied.applyResult as { configBackupPath?: string }).configBackupPath)));
      assert.deepEqual(fs.readFileSync(String((applied.applyResult as { configBackupPath?: string }).configBackupPath)), original);
    });
  });

  it("uses the explicit refresh only for preview and keeps provider errors advisory", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({ models: { general: ["openai/retired"] } }));
      const receipt = buildInitOwnershipReceipt({ general: ["openai/retired"] });
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify(receipt));
      let refreshCalls = 0;
      const h = makeHarness({
        evidence: { openai: { status: "complete", refreshedAt: Date.now() } },
        refresh: async () => { refreshCalls++; return { aborted: false, errors: new Map([["openai", new Error("PRIVATE_PROVIDER_ERROR")]]) }; },
      });
      const before = fs.readFileSync(configPath);
      const lines = await captureStderr(() => createCommandRouter(h.state)(
        "config reconcile --tier general --provider openai --refresh --json",
        h.ctx,
      ));
      const report = jsonReport(lines);
      assert.equal(refreshCalls, 1);
      assert.equal(report.status, "advisory");
      assert.equal(report.inventoryStatus, "partial");
      assert.equal(JSON.stringify(h.state.registryInventoryEvidence).includes("PRIVATE_PROVIDER_ERROR"), false);
      assert.deepEqual(fs.readFileSync(configPath), before);
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile.journal")), false);
    });
  });

  it("does not steal stale locks and shows the operator repair prerequisite on recovery", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({ models: { general: [] } }));
      const lockPath = `${configPath}.bifrost-reconcile.lock`;
      fs.writeFileSync(lockPath, "opaque stale lock");
      const h = makeHarness({});
      const lines = await captureStderr(() => createCommandRouter(h.state)("config reconcile --recover --json", h.ctx));
      const report = jsonReport(lines);
      assert.equal(report.reason, "operator_repair_required");
      assert.equal(report.operatorGuidance, "verify_no_active_writer_remove_exact_stale_locks_then_retry_recover");
      assert.equal(fs.existsSync(lockPath), true);
    });
  });

  it("writes an exact ownership receipt only after confirmed cached init and does not adopt old manual entries", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({ models: { general: ["openai/cached-model", "manual/legacy"] } }));
      fs.writeFileSync(join(configDir, "bifrost-probe.json"), JSON.stringify([
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]));
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const config = JSON.parse(fs.readFileSync(join(configDir, "bifrost.json"), "utf8")) as { models: Record<string, string[]> };
      const receipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8")) as { sources: Record<string, { generated: Record<string, string[]> }> };
      const owned = Object.values(receipt.sources).flatMap((source) => Object.values(source.generated).flat());
      assert.equal(config.models.general.includes("openai/cached-model"), true);
      assert.equal(owned.includes("manual/legacy"), false);
      assert.equal(owned.includes("openai/cached-model"), false);
    });
  });

  it("does not let repeated init overwrite config or managed-membership history", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const ownershipPath = join(configDir, "bifrost-reconcile-ownership.json");
      const originalConfig = Buffer.from('{ "models" : { "general" : ["openai/managed"] }, "manual" : true }\n');
      const originalOwnership = Buffer.from(JSON.stringify(buildInitOwnershipReceipt({ general: ["openai/managed"] })));
      fs.writeFileSync(configPath, originalConfig);
      fs.writeFileSync(ownershipPath, originalOwnership);
      fs.writeFileSync(join(configDir, "bifrost-probe.json"), JSON.stringify([
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]));
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });
      const output = await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      assert.deepEqual(fs.readFileSync(configPath), originalConfig);
      assert.deepEqual(fs.readFileSync(ownershipPath), originalOwnership);
      assert.match(output.join("\n"), /will not replace a config with a reconciliation ownership receipt/u);
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile.journal")), false);
    });
  });
});
