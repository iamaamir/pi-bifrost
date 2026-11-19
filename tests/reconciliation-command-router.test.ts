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

describe("config reconciliation command router", () => {
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

        await captureStderr(() => createCommandRouter(h.state)("init", h.ctx));

        assert.equal(selections, 0, "fresh setup must not ask existing-model action choices");
        assert.equal(confirmations, 1, "fresh setup asks one Yes/No confirmation");
        const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as { classifier?: { enabled?: boolean }; models?: Record<string, string[]> };
        assert.deepEqual(saved.models, { general: ["openai/cached-model"] });
        assert.equal(saved.classifier?.enabled, initialConfig.classifier?.enabled);
      });
    });
  }

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
      const h = makeHarness({ models: [makeModel("openai", "cached-model", 1, 1)] });
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
