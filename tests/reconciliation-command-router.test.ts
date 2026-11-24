import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { createPipeline } from "../classification-pipeline.ts";
import { BIFROST_COMMAND_OPTIONS, BIFROST_JSON_PREFIX, createCommandRouter, type BifrostState } from "../commands.ts";
import { loadConfigForReload, loadRules } from "../config-load.ts";
import { BUNDLED_PUBLIC_INIT_DEFAULTS, DEFAULT_RULES } from "../config.ts";
import { buildInitOwnershipReceipt } from "../reconciliation-command.ts";
import { makeModel } from "./helpers.ts";
import { REGISTRY_REFRESH_TTL_MS } from "../registry-refresh.ts";
import { PROBE_CACHE_TTL_MS } from "../probe.ts";

function withCwd<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const prior = process.cwd();
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const directory = fs.mkdtempSync(join(tmpdir(), "bifrost-reconcile-command-"));
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.chdir(directory);
  return run(directory).finally(() => {
    process.chdir(prior);
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

function inheritedExpiryPool(scenario: string): string[] {
  if (scenario === "inherited override") return ["openai/old-model"];
  if (scenario === "reorder only") return ["openai/second", "openai/first"];
  return ["openai/first"];
}

function noChangeConfig(): Buffer {
  return Buffer.from(JSON.stringify({
    ...BUNDLED_PUBLIC_INIT_DEFAULTS,
    categoryStrategies: { general: "first" },
    models: { general: ["openai/cached-model", "manual/legacy"] },
    rules: DEFAULT_RULES,
  }) + "\n");
}

function writeRecentProbeCache(path: string, results: unknown): void {
  fs.writeFileSync(path, JSON.stringify(results));
  const recent = new Date(Date.now() - 60_000);
  fs.utimesSync(path, recent, recent);
}

function makeHarness(options: {
  readonly models?: Array<{ provider: string; id: string; api: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
  readonly refresh?: () => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
  readonly authConfigured?: boolean;
  readonly registryError?: string;
  readonly evidence?: Record<string, { status: "complete" | "partial" | "stale"; refreshedAt: number }>;
}) {
  const models = options.models ?? [makeModel("openai", "new-model", 1, 1)];
  const config = { enabled: true, default: "general", strategy: "first" as const, models: { general: ["manual/model"] } } as BifrostState["config"];
  const registry = {
    getAll: () => models,
    getAvailable: () => models,
    getProvider: (provider: string) => provider === "openai" ? { id: provider } : undefined,
    getProviderAuthStatus: () => ({ configured: options.authConfigured ?? true }),
    getError: () => options.registryError,
    refresh: options.refresh ?? (async () => ({ aborted: false, errors: new Map() })),
  };
  const state = {
    config,
    enabled: true,
    classifierEnabled: true,
    pinned: false,
    tierPolicyValid: true,
    cacheEntries: [],
    reliabilityStore: {
      getState: () => ({ version: 1 as const, models: {} }),
      openCircuitCount: () => 0,
      reload: () => {},
      applyOutcomes: () => {},
    },
    classifierMetricsStore: {
      snapshot: () => ({ version: 1, model: "none", total: 0, outcomes: {}, tiers: {}, confidenceBands: {}, latencyBuckets: {}, totalLatencyMs: 0, totalAttempts: 0 }),
      reload: () => {},
    },
    extensionDir: join(process.cwd(), "extension"),
    effectiveClassifierBackend: () => ({ backend: "prompt", reason: "fixture", auto: true }),
    getClassifierEnablementForSession: (_sessionManager: unknown, effectiveConfig = config) => ({
      enabled: effectiveConfig.classifier?.enabled !== false,
      source: "configuration" as const,
    }),
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
  const originalError = console.error;
  const originalWarn = console.warn;
  const captured: string[] = [];
  const capture = (...values: unknown[]) => { captured.push(values.map(String).join(" ")); };
  console.error = capture;
  console.warn = capture;
  try { await run(); }
  finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  return captured;
}

function jsonReport(lines: readonly string[]): Record<string, unknown> {
  const line = lines.find((entry) => entry.startsWith(BIFROST_JSON_PREFIX));
  assert.ok(line, `expected a ${BIFROST_JSON_PREFIX} report`);
  return JSON.parse(line.slice(BIFROST_JSON_PREFIX.length)) as Record<string, unknown>;
}

async function discoveryFailureScenario(createRouter: typeof createCommandRouter) {
  return withCwd(async (cwd) => {
    const configDir = join(cwd, ".pi");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "bifrost.json");
    const original = Buffer.from(JSON.stringify({ models: { general: ["openai/retired"] }, custom: true }));
    fs.writeFileSync(configPath, original);
    fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify(buildInitOwnershipReceipt("project", { general: ["openai/retired"] })));
    const h = makeHarness({
      evidence: { openai: { status: "complete", refreshedAt: Date.now() } },
      refresh: async () => { throw new Error("PRIVATE_DISCOVERY_FAILURE"); },
    });
    const lines = await captureStderr(() => createRouter(h.state)(
      "config reconcile --tier general --provider openai --refresh --json",
      h.ctx,
    ));
    return {
      report: jsonReport(lines),
      configBytes: fs.readFileSync(configPath),
      original,
      journalExists: fs.existsSync(join(configDir, "bifrost-reconcile.journal")),
    };
  });
}

function assertFailedDiscoveryIsAdvisory(report: Record<string, unknown>): void {
  assert.equal(report.status, "advisory", "failed discovery must remain advisory");
  assert.equal(report.inventoryStatus, "stale");
  assert.equal(JSON.stringify(report).includes("PRIVATE_DISCOVERY_FAILURE"), false);
}

function createCommandSourceCopy(label: string): { directory: string; target: string } {
  const root = dirname(fileURLToPath(new URL("../commands.ts", import.meta.url)));
  const directory = fs.mkdtempSync(join(tmpdir(), `bifrost-command-router-${label}-`));
  for (const entry of fs.readdirSync(root)) {
    if (entry !== "commands.ts" && entry !== ".git") fs.symlinkSync(join(root, entry), join(directory, entry));
  }
  return { directory, target: join(directory, "commands.ts") };
}

async function loadCommandRouterCopy(target: string, label: string): Promise<typeof createCommandRouter> {
  const loaded = await import(`${pathToFileURL(target).href}?${label}`) as typeof import("../commands.ts");
  return loaded.createCommandRouter;
}

function registerInitialConfigCases1() {
  for (const initialConfig of [{}, { classifier: { enabled: false } }]) {
    it(`uses fresh-init confirmation for ${Object.keys(initialConfig).length ? "settings-only" : "empty"} project config with inherited tiers`, async () => {
      await withCwd(async (cwd) => {
        const agentDir = process.env.PI_CODING_AGENT_DIR!;
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
          classifier: { enabled: false },
          default: "general",
          models: { general: ["openai/cached-model"] },
        }));
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "bifrost.json");
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
        let confirmations = 0;
        let selections = 0;
        const ctx = h.ctx as unknown as {
          hasUI: boolean;
          ui: { confirm: () => Promise<boolean>; notify: () => void; select: (_title: string, choices: string[]) => Promise<string> };
        };
        ctx.hasUI = true;
        ctx.ui = {
          confirm: async () => { confirmations++; return true; },
          notify: () => {},
          select: async (_title, choices) => { selections++; return choices[0]!; },
        };

        const preview = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

        assert.equal(selections, 0, "fresh setup must not ask existing-model action choices");
        assert.equal(confirmations, 1, "fresh setup asks one Yes/No confirmation");
        const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { classifier?: { enabled?: boolean }; models?: Record<string, string[]> };
        assert.equal(saved.models?.general, undefined, "identical inherited pool must not be copied into project config");
        assert.equal(saved.classifier?.enabled, initialConfig.classifier?.enabled);
        const effective = loadConfigForReload(cwd, h.state.extensionDir).config;
        assert.deepEqual(effective.models?.general, ["openai/cached-model"], "effective inherited pool remains unchanged");
        assert.match(preview.join("\n"), /general: inherited pool remains effective[\s\S]*Inherited:[\s\S]*1\. openai\/cached-model/);
      });
    });
  }

}

function registerInitialConfigCases2() {
  for (const initialConfig of [undefined, { classifier: { enabled: false } }]) {
    it(`does not save a fresh inherited override after failed forced refresh (${initialConfig ? "settings-only" : "absent"} project config)`, async () => {
      await withCwd(async (cwd) => {
        const agentDir = process.env.PI_CODING_AGENT_DIR!;
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
          default: "general",
          models: { general: ["openai/old-model"] },
        }));
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "bifrost.json");
        if (initialConfig) fs.writeFileSync(configPath, JSON.stringify(initialConfig));
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({
          models: [makeModel("openai", "new-model", 1, 1)],
          evidence: { openai: { status: "complete", refreshedAt: Date.now() } },
          refresh: async () => { throw new Error("forced refresh failed"); },
        });
        const ctx = h.ctx as unknown as {
          hasUI: boolean;
          ui: { confirm: () => Promise<boolean>; notify: () => void };
        };
        ctx.hasUI = true;
        ctx.ui = { confirm: async () => true, notify: () => {} };

        const before = initialConfig === undefined ? undefined : fs.readFileSync(configPath);
        const output = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

        assert.ok(output.length > 0, "init reports refresh state");
        if (initialConfig === undefined) assert.equal(fs.existsSync(configPath), false);
        else assert.deepEqual(fs.readFileSync(configPath), before, "blocked replacement must not save other settings");
        assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false);
        assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["openai/old-model"]);
      });
    });
  }

}

function registerInitialConfigCases3() {
  for (const initialConfig of [undefined, { classifier: { enabled: false } }]) {
    it(`keeps differing inherited pool unchanged for --write (${initialConfig ? "existing" : "absent"} project config)`, async () => {
      await withCwd(async (cwd) => {
        const agentDir = process.env.PI_CODING_AGENT_DIR!;
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
          default: "general", models: { general: ["openai/old-model"] },
        }));
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "bifrost.json");
        if (initialConfig) fs.writeFileSync(configPath, JSON.stringify(initialConfig));
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });

        await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

        const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
        assert.equal(saved.models?.general, undefined, "--write must not create local tier over inherited pool");
        assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["openai/old-model"]);
      });
    });
  }

}

describe("config reconciliation command router", () => {
  it("revalidates ownership changed during live probe", async () => {
    for (const replacement of ['{', JSON.stringify(buildInitOwnershipReceipt("user", {})), JSON.stringify({ version: 1, sources: {} }), JSON.stringify(buildInitOwnershipReceipt("project", {}))]) {
      await withCwd(async (cwd) => {
        const dir = join(cwd, ".pi");
        fs.mkdirSync(dir, { recursive: true });
        const configPath = join(dir, "bifrost.json");
        const receiptPath = join(dir, "bifrost-reconcile-ownership.json");
        const config = Buffer.from("{}\n");
        fs.writeFileSync(configPath, config);
        fs.writeFileSync(receiptPath, JSON.stringify(buildInitOwnershipReceipt("project", {})));
        const h = makeHarness({});
        Object.assign(h.registry, { streamSimple: () => ({ result: async () => {
          fs.writeFileSync(receiptPath, replacement);
          return { role: "assistant", content: [{ type: "text", text: "2" }], stopReason: "stop", usage: { totalTokens: 2 } };
        } }) });
        await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
        if (replacement === "{" || replacement.includes('"scope":"user"')) {
          assert.deepEqual(fs.readFileSync(configPath), config);
          assert.equal(fs.readFileSync(receiptPath, "utf8"), replacement);
        } else {
          assert.notDeepEqual(fs.readFileSync(configPath), config);
        }
      });
    }
  });

  it("is listed in command options and previews offline, then applies only the exact reviewed source proposal", async () => {
    assert.ok(BIFROST_COMMAND_OPTIONS.some((item) => item.value === "config reconcile"));
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const original = Buffer.from(JSON.stringify({ enabled: true, models: { general: ["manual/model"] }, retained: { yes: true } }, null, 2) + "\n");
      fs.writeFileSync(join(configDir, "bifrost.json"), original);
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify(buildInitOwnershipReceipt("project", { general: ["manual/model"] })));
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
      const receipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8")) as { tiers: Record<string, unknown> };
      assert.deepEqual(receipt.tiers, { general: { state: "generated", models: ["manual/model", "openai/new-model"] } });
      assert.ok(fs.existsSync(String((applied.applyResult as { configBackupPath?: string }).configBackupPath)));
      assert.deepEqual(fs.readFileSync(String((applied.applyResult as { configBackupPath?: string }).configBackupPath)), original);
    });
  });

  it("keeps owned memberships when explicit provider discovery fails", async () => {
    const result = await discoveryFailureScenario(createCommandRouter);
    assertFailedDiscoveryIsAdvisory(result.report);
    assert.equal((result.report.changes as Array<{ kind: string }>).some(({ kind }) => kind === "remove"), false);
    assert.ok((result.report.warnings as string[]).includes("removal_suppressed"));
    assert.deepEqual(result.configBytes, result.original);
    assert.equal(result.journalExists, false);
  });

  it("fault control: complete-on-refresh-failure turns the named advisory assertion RED in an isolated source copy", async () => {
    const sourcePath = new URL("../commands.ts", import.meta.url);
    const original = fs.readFileSync(sourcePath, "utf8");
    const staleCatch = '    } catch {\n      setRegistryProviderEvidence(state, request.provider, {\n        status: "stale",\n        refreshedAt: Date.now(),\n      });\n    } finally {';
    assert.equal(original.split(staleCatch).length - 1, 1, "refresh failure catch anchor must be unique");
    const mutant = original.replace(staleCatch, staleCatch.replace('status: "stale"', 'status: "complete"'));
    assert.notEqual(mutant, original, "controlled fault must change the production command source");

    const scratch = createCommandSourceCopy("fault-control");
    try {
      fs.writeFileSync(scratch.target, mutant);
      const mutantRouter = await loadCommandRouterCopy(scratch.target, "faulted");
      const mutantResult = await discoveryFailureScenario(mutantRouter);
      assert.equal(mutantResult.report.status, "ready", "complete inventory mutation should authorize a removal proposal");
      assert.ok((mutantResult.report.changes as Array<{ kind: string; modelKey: string; disposition: string }>).some(
        (change) => change.kind === "remove" && change.modelKey === "openai/retired" && change.disposition === "apply",
      ));
      assert.throws(() => assertFailedDiscoveryIsAdvisory(mutantResult.report), /failed discovery must remain advisory/u);

      fs.writeFileSync(scratch.target, original);
      assert.equal(fs.readFileSync(scratch.target, "utf8"), original, "scratch command source must be restored byte-for-byte");
      const restoredRouter = await loadCommandRouterCopy(scratch.target, "restored");
      const restoredResult = await discoveryFailureScenario(restoredRouter);
      assertFailedDiscoveryIsAdvisory(restoredResult.report);
      assert.equal((restoredResult.report.changes as Array<{ kind: string }>).some(({ kind }) => kind === "remove"), false);
      assert.deepEqual(restoredResult.configBytes, restoredResult.original);
      assert.equal(restoredResult.journalExists, false);
    } finally {
      fs.rmSync(scratch.directory, { recursive: true, force: true });
    }
    assert.equal(fs.readFileSync(sourcePath, "utf8"), original, "production commands.ts must remain untouched");
  });

  it("uses the explicit refresh only for preview and keeps provider errors advisory", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({ models: { general: ["openai/retired"] } }));
      const receipt = buildInitOwnershipReceipt("project", { general: ["openai/retired"] });
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

  it("reports the structural warnings a proposed change would carry", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({
        enabled: true,
        models: { general: ["manual/model"] },
        unsupportedField: 1,
      }));
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify(buildInitOwnershipReceipt("project", { general: ["manual/model"] })));
      const h = makeHarness({ evidence: { openai: { status: "complete", refreshedAt: Date.now() } } });
      const lines = await captureStderr(() => createCommandRouter(h.state)(
        "config reconcile --tier general --provider openai --json",
        h.ctx,
      ));
      assert.equal(jsonReport(lines).status, "ready");
      // A prospective change that loads with findings must say so before the
      // user commits it; the committed path reports them through the reload.
      const warning = lines.find((line) => line.includes("would load with warnings"));
      assert.ok(warning, `expected a structural warning line, got: ${lines.join(" | ")}`);
      assert.match(warning!, /Unsupported configuration field "unsupportedField"/);
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

  it("keeps existing entries manual when init refresh finds no new memberships", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const originalConfig = noChangeConfig();
      fs.writeFileSync(configPath, originalConfig);
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models: Record<string, string[]> };
      const receipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8"));
      assert.deepEqual(fs.readFileSync(configPath), originalConfig);
      assert.deepEqual(receipt.tiers, { general: { state: "user" } });
      assert.equal(config.models.general.includes("openai/cached-model"), true);
      assert.equal(config.models.general.includes("manual/legacy"), true);
    });
  });

  it("does not create a no-change receipt without explicit save permission", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(join(configDir, "bifrost.json"), noChangeConfig());
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false);
    });
  });

  it("does not create a no-change receipt when TUI confirmation is declined", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(join(configDir, "bifrost.json"), noChangeConfig());
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      const ctx = h.ctx as unknown as {
        hasUI: boolean;
        ui: { select: () => Promise<string | undefined>; notify: () => void };
      };
      ctx.hasUI = true;
      ctx.ui = { select: async () => undefined, notify: () => {} };
      await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false);
    });
  });

  it("blocks no-change receipt creation behind journals and reconciliation locks", async () => {
    for (const blocker of ["bifrost-reconcile.journal", "bifrost.json.bifrost-reconcile.lock"]) {
      await withCwd(async (cwd) => {
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(join(configDir, "bifrost.json"), noChangeConfig());
        fs.writeFileSync(join(configDir, blocker), "active writer");
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
        await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
        assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false, blocker);
      });
    }
  });

  it("writes default rules only for generated tiers", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cheap", cost_input: 0.1, cost_output: 0.1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cheap", 0.1, 0.1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const saved = JSON.parse(fs.readFileSync(join(configDir, "bifrost.json"), "utf8")) as {
        models: Record<string, string[]>;
        rules: Array<{ model: string }>;
      };
      assert.deepEqual(Object.keys(saved.models), ["quick"]);
      assert(saved.rules.length > 0);
      assert(saved.rules.every(({ model }) => model === "quick"));
    });
  });

  it("keeps managed memberships with --write when provider inventory is missing", async () => {
      await withCwd(async (cwd) => {
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "bifrost.json");
        const ownershipPath = join(configDir, "bifrost-reconcile-ownership.json");
        const originalConfig = Buffer.from(JSON.stringify({ models: { general: ["missing-provider/retired"] } }));
        const originalOwnership = Buffer.from(JSON.stringify(buildInitOwnershipReceipt("project", {
          general: ["missing-provider/retired"],
        })));
        fs.writeFileSync(configPath, originalConfig);
        fs.writeFileSync(ownershipPath, originalOwnership);
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({
          models: [makeModel("openai", "new-model", 1, 1)],
          evidence: { "missing-provider": { status: "complete", refreshedAt: Date.now() } },
        });

        const outcome = await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

        assert.ok(outcome.length > 0, JSON.stringify(outcome));
        assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).models.general, ["missing-provider/retired", "openai/new-model"]);
        assert.deepEqual(JSON.parse(fs.readFileSync(ownershipPath, "utf8")), buildInitOwnershipReceipt("project", { general: ["missing-provider/retired", "openai/new-model"] }));
      });
    });

  it("saves settings with handwritten Keep when unused generated inventory is stale", async () => {
    await withCwd(async (cwd) => {
      const dir = join(cwd, ".pi");
      fs.mkdirSync(dir, { recursive: true });
      const path = join(dir, "bifrost.json");
      fs.writeFileSync(path, JSON.stringify({ models: { general: ["manual/model"] } }));
      writeRecentProbeCache(join(dir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ refresh: async () => { throw new Error("unavailable"); } });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const saved = JSON.parse(fs.readFileSync(path, "utf8"));
      assert.deepEqual(saved.models.general, ["manual/model"]);
      assert.ok(saved.rules?.length > 0, "unrelated settings must be saved");
    });
  });

  it("pauses settings-only inherited replacement when refresh fails", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        default: "general", models: { general: ["openai/retired"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const original = Buffer.from(JSON.stringify({ classifier: { enabled: false } }));
      fs.writeFileSync(configPath, original);
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({
        models: [makeModel("openai", "new-model", 1, 1)],
        refresh: async () => { throw new Error("inventory unavailable"); },
      });

      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      assert.deepEqual(saved.models, {}, "safe Keep saves no inherited pool override");
      assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["openai/retired"]);
      assert.notDeepEqual(fs.readFileSync(configPath), original, "safe Keep may save settings without replacing inherited pools");
    });
  });

  it("pauses inherited replacement when referenced provider is absent", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        default: "general", models: { general: ["missing-provider/retired"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const original = Buffer.from("{}\n");
      fs.writeFileSync(configPath, original);
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({
        models: [makeModel("openai", "new-model", 1, 1)],
        evidence: { "missing-provider": { status: "complete", refreshedAt: Date.now() } },
      });

      const outcome = await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      assert.deepEqual(saved.models, {}, "safe Keep must not freeze absent-provider inheritance");
      assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["missing-provider/retired"]);
      assert.ok(outcome.length > 0);
    });
  });

  it("allows stale inventory for fresh setup without inherited pools", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, "{}\n");
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({
        models: [makeModel("openai", "new-model", 1, 1)],
        refresh: async () => { throw new Error("inventory unavailable"); },
      });

      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      assert.deepEqual(saved.models?.general, ["openai/new-model"]);
    });
  });

  registerInitialConfigCases1();
  it("renders actual Keep comparison row and reports preserved custom/deleted tiers", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: false },
        default: "general",
        models: { general: ["openai/cached-model"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({
        classifier: { enabled: false },
        models: { custom: ["manual/custom-model"] },
      }));
      const receipt = buildInitOwnershipReceipt("project", { custom: ["manual/custom-model"], deleted: [] })!;
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify({
        ...receipt,
        tiers: { custom: { state: "user" }, deleted: { state: "deleted" } },
      }));
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });
      const ctx = h.ctx as unknown as {
        hasUI: boolean;
        ui: { confirm: () => Promise<boolean>; notify: () => void; select: (_title: string, choices: string[]) => Promise<string> };
      };
      ctx.hasUI = true;
      ctx.ui = {
        confirm: async () => true,
        notify: () => {},
        select: async (_title, choices) => {
          assert(choices.includes("Bifrost defaults"));
          return "Bifrost defaults";
        },
      };

      const rendered = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
      const comparison = rendered.join("\n");
      assert.match(comparison, /Review model choices/);
      assert.match(comparison, /Keep my models:\n\[bifrost\]     custom: custom pool retained\n\[bifrost\]       Model:\n\[bifrost\]       1\. manual\/custom-model\n\[bifrost\]     deleted: remains deleted\n\[bifrost\]   general: inherited pool remains effective/);
    });
  });

  registerInitialConfigCases2();
  it("does not save fresh override for inherited provider absent from refreshed catalog", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        default: "general", models: { general: ["missing-provider/old-model"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const configBytes = Buffer.from("{}\n");
      fs.writeFileSync(configPath, configBytes);
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({
        models: [makeModel("openai", "new-model", 1, 1)],
        evidence: { "missing-provider": { status: "complete", refreshedAt: Date.now() } },
      });
      const ctx = h.ctx as unknown as { hasUI: boolean; ui: { confirm: () => Promise<boolean>; notify: () => void } };
      ctx.hasUI = true;
      ctx.ui = { confirm: async () => true, notify: () => {} };

      const output = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

      assert.ok(output.length > 0, "init reports refresh state");
      assert.deepEqual(fs.readFileSync(configPath), configBytes);
      assert.equal(fs.existsSync(join(configDir, "bifrost-reconcile-ownership.json")), false);
      assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["missing-provider/old-model"]);
    });
  });

  it("rechecks cached-probe inventory TTL after confirmation with a fault control", async () => {
    const source = fs.readFileSync(new URL("../commands.ts", import.meta.url), "utf8");
    const guard = "    !inventoryStillSafe() ||";
    assert.equal(source.split(guard).length - 1, 1);
    const scratch = createCommandSourceCopy("ttl-control");
    const originalNow = Date.now;
    const run = async (router: typeof createCommandRouter) => withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ default: "general", models: { general: ["openai/old-model"] } }));
      const dir = join(cwd, ".pi");
      fs.mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "bifrost.json");
      const before = Buffer.from("{}\n");
      fs.writeFileSync(configPath, before);
      writeRecentProbeCache(join(dir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      let now = originalNow();
      Date.now = () => now;
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });
      const ctx = h.ctx as unknown as { hasUI: boolean; ui: { confirm: () => Promise<boolean>; notify: () => void } };
      ctx.hasUI = true;
      let confirmations = 0;
      ctx.ui = { confirm: async () => { confirmations++; now += REGISTRY_REFRESH_TTL_MS; return true; }, notify: () => {} };
      await captureStderr(() => router(h.state)("init", h.ctx));
      assert.equal(confirmations, 1);
      return { unchanged: fs.readFileSync(configPath).equals(before), receipt: fs.existsSync(join(dir, "bifrost-reconcile-ownership.json")) };
    });
    try {
      fs.writeFileSync(scratch.target, source.replace(guard, ""));
      const mutant = await loadCommandRouterCopy(scratch.target, "ttl-mutant");
      assert.equal((await run(mutant)).unchanged, false, "fault must allow expired inventory to save");
      Date.now = originalNow;
      assert.deepEqual(await run(createCommandRouter), { unchanged: true, receipt: false }, "expired inventory must not save");
    } finally {
      Date.now = originalNow;
      fs.rmSync(scratch.directory, { recursive: true, force: true });
    }
  });

  for (const scenario of ["inherited override", "reorder only", "settings only"] as const) {
    it(`handles cached probe expiry during approval: ${scenario}`, async () => {
      const originalNow = Date.now;
      try {
        await withCwd(async (cwd) => {
          let now = originalNow();
          Date.now = () => now;
          const agentDir = process.env.PI_CODING_AGENT_DIR!;
          fs.mkdirSync(agentDir, { recursive: true });
          const inherited = inheritedExpiryPool(scenario);
          fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ default: "general", models: { general: inherited } }));
          const dir = join(cwd, ".pi");
          fs.mkdirSync(dir, { recursive: true });
          const configPath = join(dir, "bifrost.json");
          const receiptPath = join(dir, "bifrost-reconcile-ownership.json");
          const config = Buffer.from("{}\n");
          const receipt = Buffer.from(JSON.stringify(buildInitOwnershipReceipt("project", {})));
          fs.writeFileSync(configPath, config);
          fs.writeFileSync(receiptPath, receipt);
          const models = scenario === "reorder only" ? ["first", "second"] : ["first"];
          const probePath = join(dir, "bifrost-probe.json");
          writeRecentProbeCache(probePath, models.map((model) => ({ status: "ok", provider: "openai", model, cost_input: 1, cost_output: 1, duration_ms: 10 })));
          const nearExpiry = new Date(now - PROBE_CACHE_TTL_MS + 1000);
          fs.utimesSync(probePath, nearExpiry, nearExpiry);
          const h = makeHarness({ models: models.map((model) => makeModel("openai", model, 1, 1)) });
          const ctx = h.ctx as unknown as { hasUI: boolean; ui: { confirm: () => Promise<boolean>; notify: () => void } };
          ctx.hasUI = true;
          let confirmations = 0;
          ctx.ui = { confirm: async () => { confirmations++; now += 2000; return true; }, notify: () => {} };
          const output = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
          assert.equal(confirmations, 1, output.join("\n"));
          if (scenario === "settings only") {
            assert.notDeepEqual(fs.readFileSync(configPath), config, "settings-only save remains eligible");
          } else {
            assert.match(output.join("\n"), /general: project override/);
            assert.deepEqual(fs.readFileSync(configPath), config, "expired probe must not change config");
            assert.deepEqual(fs.readFileSync(receiptPath), receipt, "expired probe must not change receipt");
          }
        });
      } finally {
        Date.now = originalNow;
      }
    });
  }

  it("bounds live-probe receipt after completion while allowing a long probe", async () => {
    const source = fs.readFileSync(new URL("../commands.ts", import.meta.url), "utf8");
    const guard = "    !inventoryStillSafe() ||";
    const scratch = createCommandSourceCopy("live-ttl-control");
    const originalNow = Date.now;
    const run = async (router: typeof createCommandRouter, expireReview: boolean) => withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ default: "general", models: { general: ["openai/old-model"] } }));
      const dir = join(cwd, ".pi");
      fs.mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "bifrost.json");
      const before = Buffer.from("{}\n");
      fs.writeFileSync(configPath, before);
      let now = originalNow();
      Date.now = () => now;
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });
      Object.assign(h.registry, { streamSimple: () => ({ result: async () => {
        now += REGISTRY_REFRESH_TTL_MS;
        return { role: "assistant", content: [{ type: "text", text: "2" }], stopReason: "stop", usage: { totalTokens: 2 } };
      } }) });
      const ctx = h.ctx as unknown as { hasUI: boolean; ui: { confirm: () => Promise<boolean>; notify: () => void; setWidget: () => void; setStatus: () => void } };
      ctx.hasUI = true;
      let confirmations = 0;
      ctx.ui = { confirm: async () => { confirmations++; if (expireReview) now += REGISTRY_REFRESH_TTL_MS; return true; }, notify: () => {}, setWidget: () => {}, setStatus: () => {} };
      const output = await captureStderr(() => router(h.state)("init", h.ctx));
      assert.equal(confirmations, 1, output.join("\n"));
      const unchanged = fs.readFileSync(configPath).equals(before);
      if (unchanged) assert.equal(fs.existsSync(join(dir, "bifrost-reconcile-ownership.json")), false);
      return unchanged;
    });
    try {
      assert.equal(source.split(guard).length - 1, 1);
      fs.writeFileSync(scratch.target, source.replace(guard, ""));
      const mutant = await loadCommandRouterCopy(scratch.target, "live-ttl-mutant");
      assert.equal(await run(mutant, true), false, "fault must save after review expiry");
      Date.now = originalNow;
      assert.equal(await run(createCommandRouter, true), true, "expired review must not write");
      Date.now = originalNow;
      assert.equal(await run(createCommandRouter, false), false, "long probe remains eligible");
    } finally {
      Date.now = originalNow;
      fs.rmSync(scratch.directory, { recursive: true, force: true });
    }
  });

  it("rejects inherited pool override when inventory evidence changes during approval", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({ default: "general", models: { general: ["openai/old-model"] } }));
      const dir = join(cwd, ".pi");
      fs.mkdirSync(dir, { recursive: true });
      const configPath = join(dir, "bifrost.json");
      const receiptPath = join(dir, "bifrost-reconcile-ownership.json");
      const config = Buffer.from("{}\n");
      const receipt = Buffer.from(JSON.stringify(buildInitOwnershipReceipt("project", {})));
      fs.writeFileSync(configPath, config);
      fs.writeFileSync(receiptPath, receipt);
      writeRecentProbeCache(join(dir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)], evidence: { openai: { status: "complete", refreshedAt: Date.now() } } });
      const ctx = h.ctx as unknown as { hasUI: boolean; ui: { confirm: (title: string) => Promise<boolean>; notify: () => void } };
      ctx.hasUI = true;
      const confirmations: string[] = [];
      ctx.ui = { confirm: async (title) => {
        confirmations.push(title);
        h.state.registryInventoryEvidence = { openai: { status: "partial", refreshedAt: Date.now() } };
        return true;
      }, notify: () => {} };
      const output = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
      assert.deepEqual(confirmations, ["Save Bifrost setup?"], output.join("\n"));
      assert.match(output.join("\n"), /general: project override[\s\S]*Inherited:[\s\S]*1\. openai\/old-model[\s\S]*Project:[\s\S]*1\. openai\/new-model/);
      assert.deepEqual(fs.readFileSync(configPath), config);
      assert.deepEqual(fs.readFileSync(receiptPath), receipt);
    });
  });

  it("lets interactive fresh init confirm a differing inherited pool override", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        default: "general",
        models: { general: ["openai/old-model"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, "{}\n");
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({
        models: [makeModel("openai", "new-model", 1, 1)],
        evidence: { openai: { status: "complete", refreshedAt: Date.now() } },
      });
      const ctx = h.ctx as unknown as {
        hasUI: boolean;
        ui: { confirm: () => Promise<boolean>; notify: () => void };
      };
      ctx.hasUI = true;
      ctx.ui = { confirm: async () => true, notify: () => {} };

      const preview = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      assert.deepEqual(saved.models?.general, ["openai/new-model"]);
      assert.match(preview.join("\n"), /general: project override[\s\S]*Inherited:[\s\S]*1\. openai\/old-model[\s\S]*Project:[\s\S]*1\. openai\/new-model/);
    });
  });

  registerInitialConfigCases3();
  it("Defaults keeps identical inherited tier inherited alongside local and deleted tiers", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: false },
        default: "general",
        models: { general: ["openai/cached-model"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({ models: { custom: ["manual/local-model"] } }));
      const receipt = buildInitOwnershipReceipt("project", { custom: ["manual/local-model"], deleted: [] })!;
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify({
        ...receipt,
        tiers: { custom: { state: "user" }, deleted: { state: "deleted" } },
      }));
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      const ctx = h.ctx as unknown as {
        hasUI: boolean;
        ui: { confirm: () => Promise<boolean>; notify: () => void; select: (_title: string, choices: string[]) => Promise<string> };
      };
      ctx.hasUI = true;
      ctx.ui = { confirm: async () => true, notify: () => {}, select: async () => "Bifrost defaults" };

      await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      assert.deepEqual(saved.models?.custom, ["manual/local-model"], "unlisted local tier remains saved");
      assert.equal(saved.models?.general, undefined, "identical inherited tier is not written locally");
      assert.equal(saved.models?.deleted, undefined, "deleted tier stays omitted");
      assert.deepEqual(loadConfigForReload(cwd, h.state.extensionDir).config.models?.general, ["openai/cached-model"], "inheritance stays effective");
      const savedReceipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8")) as {
        tiers: Record<string, { state: string }>;
      };
      assert.deepEqual(savedReceipt.tiers.deleted, { state: "deleted" }, "deleted-tier restoration remains available to explicit Defaults");
    });
  });

  it("lets interactive Defaults restore identical inherited pool for deleted tier while Keep protects it", async () => {
    for (const selected of ["Bifrost defaults", "Keep my models (default)"]) {
      await withCwd(async (cwd) => {
        const agentDir = process.env.PI_CODING_AGENT_DIR!;
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
          classifier: { enabled: false },
          default: "general",
          models: { general: ["openai/cached-model"] },
        }));
        const configDir = join(cwd, ".pi");
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = join(configDir, "bifrost.json");
        fs.writeFileSync(configPath, "{}\n");
        const receipt = buildInitOwnershipReceipt("project", { general: [] })!;
        fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify({
          ...receipt,
          tiers: { general: { state: "deleted" } },
        }));
        writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
          { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
        ]);
        const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
        const ctx = h.ctx as unknown as {
          hasUI: boolean;
          ui: { confirm: () => Promise<boolean>; notify: () => void; select: (_title: string, choices: string[]) => Promise<string> };
        };
        ctx.hasUI = true;
        ctx.ui = {
          confirm: async () => true,
          notify: () => {},
          select: async (_title, choices) => {
            assert(choices.includes(selected), `missing ${selected}: ${choices.join(", ")}`);
            return selected;
          },
        };

        const preview = await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));
        const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
        if (selected === "Bifrost defaults") {
          assert.deepEqual(saved.models?.general, ["openai/cached-model"], "Defaults restores deleted only-tier pool");
          assert.match(preview.join("\n"), /general: project override[\s\S]*Inherited:[\s\S]*1\. openai\/cached-model[\s\S]*Project:[\s\S]*1\. openai\/cached-model/);
        } else {
          assert.equal(saved.models?.general, undefined, "Keep preserves deleted intent");
          assert.match(preview.join("\n"), /general: remains deleted/);
        }
      });
    }
  });

  it("keeps trusted deleted-tier intent protected during fresh setup detection", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        default: "general",
        models: { general: ["openai/cached-model"] },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, "{}\n");
      const receipt = buildInitOwnershipReceipt("project", { general: [] })!;
      fs.writeFileSync(join(configDir, "bifrost-reconcile-ownership.json"), JSON.stringify({
        ...receipt,
        tiers: { general: { state: "deleted" } },
      }));
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models?: Record<string, string[]> };
      const savedReceipt = JSON.parse(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"), "utf8")) as {
        tiers: Record<string, { state: string }>;
      };
      assert.equal(saved.models?.general, undefined, "deleted inherited tier must not be recreated");
      assert.deepEqual(savedReceipt.tiers.general, { state: "deleted" });
    });
  });

  it("confirms interactive settings-only top-up when init has no model changes", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      fs.writeFileSync(configPath, JSON.stringify({
        default: "general",
        models: { general: ["openai/cached-model"] },
      }));
      fs.writeFileSync(
        join(configDir, "bifrost-reconcile-ownership.json"),
        JSON.stringify(buildInitOwnershipReceipt("project", { general: ["openai/cached-model"] })),
      );
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cached-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const receiptBytes = fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json"));
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)], evidence: { unrelated: { status: "partial", refreshedAt: Date.now() } } });
      let confirmations = 0;
      let selections = 0;
      const ctx = h.ctx as unknown as {
        hasUI: boolean;
        ui: {
          confirm: () => Promise<boolean>;
          notify: () => void;
          select: (_title: string, choices: string[]) => Promise<string>;
        };
      };
      ctx.hasUI = true;
      ctx.ui = {
        confirm: async () => { confirmations++; return true; },
        notify: () => {},
        select: async (_title, choices) => { selections++; return choices[0]; },
      };

      await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

      assert.equal(selections, 0, "no distinct model action should require selection");
      const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      assert.deepEqual(saved.strategy, BUNDLED_PUBLIC_INIT_DEFAULTS.strategy);
      assert.deepEqual(saved.cache, BUNDLED_PUBLIC_INIT_DEFAULTS.cache);
      assert.deepEqual(saved.reliability, BUNDLED_PUBLIC_INIT_DEFAULTS.reliability);
      assert.deepEqual(saved.classifier, BUNDLED_PUBLIC_INIT_DEFAULTS.classifier);
      assert.equal(confirmations, 1, "settings-only changes require explicit user confirmation");
      assert.deepEqual(saved.models, { general: ["openai/cached-model"] });
      assert.deepEqual(fs.readFileSync(join(configDir, "bifrost-reconcile-ownership.json")), receiptBytes);
    });
  });

  it("keeps starter rules for manual tiers during no-change settings top-up", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(join(configDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: false },
        default: "quick",
        models: {
          quick: ["openai/cheap"],
          frontier: ["manual/expensive"],
        },
      }));
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cheap", cost_input: 0.1, cost_output: 0.1, duration_ms: 10 },
      ]);
      const extensionDir = join(cwd, "extension");
      const routeReview = async () => {
        const config = loadConfigForReload(cwd, extensionDir).config;
        const rules = loadRules(cwd, config);
        const result = await createPipeline({
          cacheLookup: () => undefined,
          classifierModels: [],
          classifyWithLLM: async () => undefined,
          regexRules: rules,
          defaultTier: config.default,
          tiers: Object.keys(config.models ?? {}),
        }).classify("review this code");
        return { rules, result };
      };
      const before = await routeReview();
      assert(before.rules.some(({ model }) => model === "frontier"));
      assert.deepEqual(before.result, { kind: "classified", tier: "frontier", source: "regex" });

      const h = makeHarness({ models: [makeModel("openai", "cheap", 0.1, 0.1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));

      const after = await routeReview();
      assert(after.rules.some(({ model }) => model === "frontier"));
      assert.deepEqual(after.result, { kind: "classified", tier: "frontier", source: "regex" });
    });
  });

  it("keeps starter rules for inherited tiers when init adds a new pool", async () => {
    await withCwd(async (cwd) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR!;
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(join(agentDir, "bifrost.json"), JSON.stringify({
        classifier: { enabled: false },
        default: "general",
        models: {
          general: ["global/general"],
          frontier: ["global/frontier"],
        },
      }));
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "cheap", cost_input: 0.1, cost_output: 0.1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "cheap", 0.1, 0.1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const saved = JSON.parse(fs.readFileSync(join(configDir, "bifrost.json"), "utf8")) as {
        models: Record<string, string[]>;
        rules: Array<{ model: string }>;
      };
      assert.deepEqual(Object.keys(saved.models), ["quick"]);
      assert(saved.rules.some(({ model }) => model === "general"));
      assert(saved.rules.some(({ model }) => model === "frontier"));
    });
  });

  it("refreshes owned memberships and preserves the rest of config and ownership history", async () => {
    await withCwd(async (cwd) => {
      const configDir = join(cwd, ".pi");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "bifrost.json");
      const ownershipPath = join(configDir, "bifrost-reconcile-ownership.json");
      const originalConfig = Buffer.from('{ "models" : { "general" : ["openai/managed"] }, "manual" : true }\n');
      const originalOwnership = Buffer.from(JSON.stringify(buildInitOwnershipReceipt("project", { general: ["openai/managed"] })));
      fs.writeFileSync(configPath, originalConfig);
      fs.writeFileSync(ownershipPath, originalOwnership);
      writeRecentProbeCache(join(configDir, "bifrost-probe.json"), [
        { status: "ok", provider: "openai", model: "new-model", cost_input: 1, cost_output: 1, duration_ms: 10 },
      ]);
      const h = makeHarness({ models: [makeModel("openai", "new-model", 1, 1)] });
      await captureStderr(() => createCommandRouter(h.state)("init --write", h.ctx));
      const updated = JSON.parse(fs.readFileSync(configPath, "utf8")) as { models: Record<string, string[]>; manual: boolean };
      const updatedOwnership = JSON.parse(fs.readFileSync(ownershipPath, "utf8")) as { tiers: Record<string, { models: string[] }> };
      assert.deepEqual(updated.models.general, ["openai/new-model"]);
      assert.equal(updated.manual, true);
      assert.deepEqual(updatedOwnership.tiers.general, { state: "generated", models: ["openai/new-model"] });
    });
  });
});
