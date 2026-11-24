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
import { ExtensionSelectorComponent, initTheme, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  BIFROST_CONFIG_TOOL_NAME,
  buildConfigAgentCatalog,
  createBifrostConfigTool,
  configAgentConfigDigest,
  resolveProviderAuth,
  type ConfigAgentApplyResult,
  type ConfigAgentCheckResult,
  type ConfigAgentProbeResult,
  type ConfigAgentInspectResult,
  type ConfigAgentPreviewResult,
} from "../config-agent.ts";
import { reportText } from "../config-agent-report.ts";
import { PROBE_MAX_TOKENS, PROBE_RESOURCE_DISCLOSURE } from "../probe-workload.ts";
import type { ConfigApproval } from "../config-approval.ts";
import { SUPPORTED_SCHEMA_VERSIONS, type BifrostConfig } from "../config.ts";
import { loadConfigForReload } from "../config-load.ts";
import { classifyCompiled, compileRules } from "../routing.ts";
import { makeModel } from "./helpers.ts";
import { resolveClassifierEnablement } from "../runtime-state.ts";

interface HarnessOptions {
  readonly available?: readonly Model<Api>[];
  readonly knownOnly?: readonly Model<Api>[];
  readonly hasUI?: boolean;
  readonly mode?: "tui" | "rpc";
  readonly uiError?: boolean;
  readonly signal?: AbortSignal;
  readonly confirm?: boolean;
  readonly reload?: boolean;
  readonly write?: (path: string, text: string) => void;
  /** Runs inside the confirm callback while the approval dialog is open. */
  readonly confirmHook?: () => void;
  readonly runtimeAware?: boolean;
  readonly loadedClassifierEnabled?: boolean;
  /** Pi's synchronous status: is a credential stored for this provider? */
  readonly providerAuthStatus?: (provider: string) => { configured: boolean; source?: string };
  /** Resolve sign-in; return an Error to simulate a dead OAuth refresh token. */
  readonly providerAuthResult?: (provider: string) => unknown;
  /** Live probe outcomes for the opt-in check; omit to leave the host without one. */
  readonly probeModels?: (models: readonly string[], signal?: AbortSignal) => readonly ConfigAgentProbeResult[];
  /** Answer the live-probe dialog; omit to leave the host without a dialog. */
  readonly probeConfirm?: boolean;
  readonly probeConfirmError?: boolean;
  readonly legacyClassifierEnabled?: boolean;
  readonly classifierSessionOverride?: boolean;
  readonly runtimeStateIssue?: "invalid-json";
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
  let legacyClassifierEnabled = options.legacyClassifierEnabled;
  const classifierSessionOverride = options.classifierSessionOverride;
  let classifyCalls = 0;
  let reloadCalls = 0;
  let sessionId = "test-session";
  const confirmations: { title: string; summary: string; details: string }[] = [];
  const probeConfirmations: { title: string; message: string }[] = [];

  const registry = {
    getAvailable: () => available,
    getAll: () => [...available, ...knownOnly],
    find: (provider: string, id: string) => available.find((model) => model.provider === provider && model.id === id),
    getProviderAuthStatus: (provider: string) => options.providerAuthStatus?.(provider) ?? { configured: true, source: "stored" },
    getProviderAuth: async (provider: string) => {
      // Default to a resolved credential: Pi's registry returns nothing only
      // when no usable credential exists, which is its own case below.
      const result = options.providerAuthResult ? options.providerAuthResult(provider) : { auth: { apiKey: "resolved" } };
      if (result instanceof Error) throw result;
      return result;
    },
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
    sessionManager: { getSessionId: () => sessionId },
    mode: options.mode ?? "tui",
    get hasUI() { return hasUI; },
    ui: {
      custom: async (factory: Parameters<ExtensionToolContext["ui"]["custom"]>[0]) => {
        if (options.uiError) throw new Error("UI unavailable");
        let result: unknown;
        const viewer = await factory(
          { terminal: { columns: 80, rows: 24 }, requestRender() {} } as never,
          {} as never, {} as never, (value) => { result = value; },
        ) as ConfigApproval;
        confirmations.push({ title: viewer.title, summary: viewer.summary, details: viewer.details });
        options.confirmHook?.();
        for (let i = 0; i < 1000 && result === undefined; i++) {
          viewer.render(80);
          viewer.handleInput(confirmResult ? "a" : "\x1b");
          if (result === undefined) viewer.handleInput("n");
        }
        assert.notEqual(result, undefined, "approval driver must finish");
        return result;
      },
      notify: () => {},
      ...(options.probeConfirm !== undefined || options.probeConfirmError
        ? {
          confirm: async (title: string, message: string) => {
            probeConfirmations.push({ title, message });
            if (options.probeConfirmError) throw new Error("dialog unavailable");
            return options.probeConfirm === true;
          },
        }
        : {}),
    },
    modelRegistry: registry,
  } as unknown as ExtensionToolContext;

  const probeCalls: string[][] = [];
  const probeSignals: (AbortSignal | undefined)[] = [];
  const tool = createBifrostConfigTool({
    extensionDir,
    render: reportText,
    reload: () => {
      reloadCalls += 1;
      return reloadResult;
    },
    ...(options.probeModels ? {
      probeModels: async (models: readonly string[], _ctx: unknown, signal?: AbortSignal) => {
        probeCalls.push([...models]);
        probeSignals.push(signal);
        return options.probeModels!(models, signal);
      },
    } : {}),
    ...(options.write ? { write: options.write } : {}),
    ...(options.runtimeAware ? {
      classifierRuntime: (config: BifrostConfig) => {
        const configuredEnabled = config.classifier?.enabled !== false;
        const projected = resolveClassifierEnablement(configuredEnabled, legacyClassifierEnabled, classifierSessionOverride, options.runtimeStateIssue);
        const actualConfig = options.loadedClassifierEnabled === undefined
          ? config
          : { ...config, classifier: { ...config.classifier, enabled: options.loadedClassifierEnabled } };
        const actualConfiguredEnabled = actualConfig.classifier?.enabled !== false;
        const actual = resolveClassifierEnablement(actualConfiguredEnabled, legacyClassifierEnabled, classifierSessionOverride, options.runtimeStateIssue);
        return {
          ...projected,
          configuredEnabled,
          backend: config.classifier?.backend ?? "prompt",
          criteriaTiers: Object.keys(config.classifier?.criteria ?? {}),
          actual: {
            ...actual,
            configuredEnabled: actualConfiguredEnabled,
            backend: actualConfig.classifier?.backend ?? "prompt",
            criteriaTiers: Object.keys(actualConfig.classifier?.criteria ?? {}),
          },
          loadedConfigDigest: configAgentConfigDigest(actualConfig),
          configGeneration: 7,
        };
      },
    } : {}),
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
    setSessionId(value: string) { sessionId = value; },
    setConfirm(value: boolean) { confirmResult = value; },
    setHasUI(value: boolean) { hasUI = value; },
    setReload(value: boolean) { reloadResult = value; },
    setLegacyClassifierEnabled(value: boolean | undefined) { legacyClassifierEnabled = value; },
    confirmations: () => confirmations,
    probeCalls: () => probeCalls,
    probeSignals: () => probeSignals,
    probeConfirmations: () => [...probeConfirmations],
    classifyCalls: () => classifyCalls,
    reloadCalls: () => reloadCalls,
    projectConfigPath: () => join(cwd, ".pi", "bifrost.json"),
    run: (params: Record<string, unknown>) =>
      tool.execute("call-1", params as unknown as ToolParams, options.signal, undefined, ctx),
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

/**
 * Rows the shipped consent dialog actually renders for a given title and body,
 * measured with Pi's own dialog component rather than an estimate. Pi keeps the
 * bottom of an overflowing dialog, so an over-budget body scrolls the title and
 * the leading model ids off the top while the choice stays visible.
 */
function probeConsentDialogRows(title: string, message: string, width: number): number {
  // Pi's components read the theme proxy, which throws until a theme is loaded.
  initTheme("dark");
  const dialog = new ExtensionSelectorComponent(`${title}\n${message}`, ["Yes", "No"], () => {}, () => {}, {});
  return dialog.render(width).length;
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
    ...(details.guards!.classifierRuntimeDigest !== null
      ? { classifierRuntimeDigest: details.guards!.classifierRuntimeDigest }
      : {}),
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
      const tiers = new Map(details.routing.tiers.map((tier) => [tier.tier, tier]));
      assert.deepEqual(tiers.get("fast")?.pool, ["beta/code"]);
      assert.deepEqual(tiers.get("strict")?.pool, ["alpha/strong"]);
      assert.deepEqual(tiers.get("strict")?.fallbackTiers, []);
      assert.equal(tiers.has("general"), false);
      assert.equal(details.issues.filter((issue) => issue.severity === "error").length, 0);

      // The inventory mirrors the registry, including cost and context metadata.
      assert.match(text, /alpha\/strong \(\$5\.00 in \+ \$15\.00 out per 1M, ctx 200000/);
      assert.match(text, /beta\/code \(\$0\.50 in \+ \$1\.50 out per 1M, ctx 128000/);
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

describe("provider sign-in state", () => {
  it("does not disclose authentication error text in configuration reports", async () => {
    const secret = "synthetic-auth-error-canary";
    const harness = freshHarness({
      providerAuthResult: (provider) => provider === "alpha" ? new Error(secret) : { auth: {} },
    });
    try {
      const inspected = await harness.run({ operation: "inspect" });
      assert.doesNotMatch(JSON.stringify(inspected), new RegExp(secret));
      const checked = await harness.run({ operation: "check", candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } } });
      assert.doesNotMatch(JSON.stringify(checked), new RegExp(secret));
    } finally {
      harness.cleanup();
    }
  });

  it("reports a stored sign-in that cannot be resolved and warns without blocking the write", async () => {
    const harness = freshHarness({
      providerAuthStatus: () => ({ configured: true, source: "stored" }),
      providerAuthResult: (provider) => provider === "alpha"
        ? Object.assign(new Error("OAuth refresh failed for alpha: invalid_grant\n\u001b[31mprovider stack trace"), { name: "AuthError" })
        : { auth: { apiKey: "resolved-value-not-reported" } },
    });
    try {
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      const alpha = inspected.providerAuth.find((entry) => entry.provider === "alpha");
      assert.equal(alpha?.state, "invalid");
      // Provider error messages may contain credentials and must stay private.
      assert.equal(alpha?.reason, "the stored sign-in cannot be used for this provider");
      assert.doesNotMatch(alpha?.reason ?? "", /[\u0000-\u001f\u007f]/);
      assert.equal(inspected.providerAuth.find((entry) => entry.provider === "beta")?.state, "ready");

      const inspectText = contentOf(await harness.run({ operation: "inspect" }));
      assert.match(inspectText, /provider sign-in:/);
      assert.match(inspectText, /alpha: invalid -- the stored sign-in cannot be used for this provider/);
      assert.doesNotMatch(inspectText, /resolved-value-not-reported/);
      assert.doesNotMatch(JSON.stringify(inspected), /resolved-value-not-reported/);

      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      }));
      const warning = checked.issues.find((issue) => issue.code === "config.provider_auth_invalid");
      assert.equal(warning?.severity, "warning");
      assert.equal(warning?.path, "models.review");
      assert.match(warning?.message ?? "", /alpha/);
      // Advisory: the candidate is still valid and writable, with the warning reported.
      assert.equal(checked.status, "ok");
      assert.equal(checked.writeEligible, true);
      assert.match(contentOf(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      })), /warnings:/);
    } finally {
      harness.cleanup();
    }
  });

  it("warns only for providers a tier can actually select", async () => {
    const harness = freshHarness({ providerAuthStatus: (provider) => ({ configured: provider !== "gamma" }) });
    try {
      const deadTier = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["gamma/review"] } },
      }));
      const warning = deadTier.issues.find((issue) => issue.code === "config.provider_auth_not_configured");
      assert.equal(warning?.severity, "warning");
      assert.equal(warning?.path, "models.review");
      assert.equal(deadTier.status, "ok");

      const healthyTier = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "implement", models: { implement: ["beta/code"] } },
      }));
      assert.equal(healthyTier.issues.some((issue) => issue.code?.startsWith("config.provider_auth_")), false);
    } finally {
      harness.cleanup();
    }
  });

  it("warns for a dead stored sign-in whose models Pi removed from the catalog", async () => {
    // Pi drops a provider from its catalog once the stored credential stops
    // resolving, so the warning has to come from the provider the pool names.
    const harness = freshHarness({ providerAuthResult: () => new Error("token refresh failed") });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"], dead: ["retired/only"] } },
      }));
      const warning = checked.issues.find((issue) => issue.code === "config.provider_auth_invalid" && issue.path === "models.dead");
      assert.match(warning?.message ?? "", /retired\/only would fail when selected/);
      assert.match(warning?.message ?? "", /stored sign-in cannot be used/);
    } finally {
      harness.cleanup();
    }
  });

  it("stops starting sign-in resolutions after the tool call is cancelled", async () => {
    // A cancelled tool call must not keep waiting on the remaining providers.
    // The first resolution proves the credential path ran; the second must not
    // start, and an unasked provider is unknown rather than dead.
    const controller = new AbortController();
    const resolved: string[] = [];
    const harness = freshHarness({
      signal: controller.signal,
      providerAuthResult: (provider) => {
        resolved.push(provider);
        controller.abort();
        return { auth: { apiKey: "resolved" } };
      },
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
      }));
      assert.deepEqual(resolved, ["alpha"], "no resolution may start after cancellation");
      const beta = checked.providerAuth.find((entry) => entry.provider === "beta");
      assert.equal(beta?.state, "unknown", "an unasked provider is not proof of a dead sign-in");
      assert.match(beta?.reason ?? "", /cancelled before sign-in could be resolved/);
      assert.equal(checked.writeEligible, true);
    } finally {
      harness.cleanup();
    }
  });

  it("warns when a stored sign-in resolves to nothing", async () => {
    // Pi's getAuth resolves an unusable credential to undefined instead of
    // throwing, so an empty resolution on a stored credential is a dead sign-in.
    const harness = freshHarness({ providerAuthResult: () => undefined });
    try {
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      const alpha = inspected.providerAuth.find((entry) => entry.provider === "alpha");
      assert.equal(alpha?.state, "invalid");
      assert.equal(alpha?.reason, "the stored sign-in cannot be used for this provider");

      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      }));
      const warning = checked.issues.find((issue) => issue.code === "config.provider_auth_invalid");
      assert.equal(warning?.path, "models.review");
      assert.equal(checked.writeEligible, true);
    } finally {
      harness.cleanup();
    }
  });

  it("warns for a bare pool entry whose provider Pi hid from the catalog", async () => {
    // "only" names no provider, and Pi kept the model out of the available
    // inventory because the stored sign-in is dead. The provider comes from the
    // known catalog, so the warning is not lost with the hidden model.
    const harness = freshHarness({
      knownOnly: [makeModel("hidden", "only", 1, 1, 64_000)],
      providerAuthResult: (provider) => provider === "hidden"
        ? new Error("token refresh failed")
        : { auth: { apiKey: "resolved" } },
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["only"] } },
      }));
      const warning = checked.issues.find((issue) => issue.code === "config.provider_auth_invalid");
      assert.equal(warning?.path, "models.review");
      assert.match(warning?.message ?? "", /hidden\/only would fail when selected/);
    } finally {
      harness.cleanup();
    }
  });

  it("warns for a dead sign-in a workspace tier inherits under a candidate", async () => {
    // A candidate replaces the selected source only. The workspace tier stays
    // in the composed config, so its dead provider must still be checked.
    const harness = freshHarness({
      knownOnly: [makeModel("hidden", "only", 1, 1, 64_000)],
      providerAuthResult: (provider) => provider === "hidden"
        ? new Error("token refresh failed")
        : { auth: { apiKey: "resolved" } },
    });
    try {
      harness.writeFile("bifrost.json", { default: "general", models: { general: ["hidden/only"] } });
      const { result, details } = await checkedCandidate(harness, {
        source: "project",
        candidate: { schemaVersion: 2, default: "cheap", models: { cheap: ["beta/code"] } },
      });
      assert.equal(details.status, "ok", "the inherited dead sign-in stays advisory");
      const general = (details.effectiveAfter as { models?: Record<string, unknown> }).models?.general;
      assert.deepEqual(general, ["hidden/only"], "the workspace tier survived the candidate");
      assert.ok(details.issues.some((issue) => issue.code === "config.provider_auth_invalid" && issue.path === "models.general"),
        "the inherited tier's dead sign-in is reported");
      assert.match(contentOf(result), /Provider "hidden" sign-in cannot be resolved/);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a dead sign-in the stored config depends on", async () => {
    // inspect is the first tool an agent reads. A config that already routes to
    // a provider Pi hid must not inspect clean.
    const harness = freshHarness({
      knownOnly: [makeModel("hidden", "only", 1, 1, 64_000)],
      providerAuthResult: (provider) => provider === "hidden"
        ? new Error("token refresh failed")
        : { auth: { apiKey: "resolved" } },
    });
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "review",
        models: { review: ["hidden/only"] },
      });
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      const hidden = inspected.providerAuth.find((entry) => entry.provider === "hidden");
      assert.equal(hidden?.state, "invalid");
      const text = contentOf(await harness.run({ operation: "inspect" }));
      assert.match(text, /provider sign-in:/);
      assert.match(text, /hidden: invalid/);
    } finally {
      harness.cleanup();
    }
  });

  it("warns about a dead sign-in a patch leaves in place", async () => {
    // The patch only moves the default tier. The dead pool is inherited from the
    // stored config, so the probe has to cover what the stored config routes to
    // and not just what the request spells out.
    const harness = freshHarness({
      knownOnly: [makeModel("hidden", "only", 1, 1, 64_000)],
      providerAuthResult: (provider) => provider === "hidden"
        ? new Error("token refresh failed")
        : { auth: { apiKey: "resolved" } },
    });
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "healthy",
        models: { healthy: ["alpha/strong"], dead: ["hidden/only"] },
      });
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        patch: { default: "dead" },
      }));
      const warning = checked.issues.find((issue) => issue.code === "config.provider_auth_invalid");
      assert.equal(warning?.path, "models.dead");
      assert.match(warning?.message ?? "", /hidden\/only would fail when selected/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps an unconfigured prefix out of the warnings when no model matched it", async () => {
    // A tier may name a provider that does not exist; that is a reference
    // finding, not a sign-in finding, so the sign-in pass stays silent.
    const harness = freshHarness({ providerAuthStatus: () => ({ configured: false }) });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["ghost/only"] } },
      }));
      assert.equal(checked.issues.some((issue) => issue.code?.startsWith("config.provider_auth_")), false,
        JSON.stringify(checked.issues));
      assert.equal(checked.references.some((reference) => reference.status === "unknown"), true);
    } finally {
      harness.cleanup();
    }
  });

  it("stays silent about a provider the tier's routing scope excludes", async () => {
    // `routingScope` is a hard eligibility filter. A pool can name two
    // providers while the tier allowlist permits only the healthy one; warning
    // about the excluded provider would push the user toward a change that
    // cannot affect the route.
    const harness = freshHarness({ providerAuthStatus: (provider) => ({ configured: provider !== "alpha" }) });
    try {
      const pool = ["alpha/strong", "beta/code"];
      const scoped = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: pool }, routingScope: { tiers: { review: { providers: ["beta"] } } } },
      }));
      assert.equal(scoped.issues.some((issue) => issue.code?.startsWith("config.provider_auth_")), false,
        JSON.stringify(scoped.issues));
      assert.equal(scoped.status, "ok");

      // The same pool without the allowlist does name a dead provider, so the
      // silence above comes from the scope and not from a broken harness.
      const unscoped = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: pool } },
      }));
      const warning = unscoped.issues.find((issue) => issue.code === "config.provider_auth_not_configured");
      assert.equal(warning?.path, "models.review");
      assert.match(warning?.message ?? "", /alpha/);
    } finally {
      harness.cleanup();
    }
  });

  it("fault control: a provider that resolves cleanly emits no sign-in warning", async () => {
    const harness = freshHarness({ providerAuthResult: () => ({ auth: { apiKey: "resolved" } }) });
    try {
      const healthy = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      }));
      assert.equal(healthy.providerAuth.find((entry) => entry.provider === "alpha")?.state, "ready");
      assert.equal(healthy.issues.some((issue) => issue.code === "config.provider_auth_invalid"), false);
    } finally {
      harness.cleanup();
    }
  });

  it("repeats the sign-in warning in the approval dialog", async () => {
    const harness = freshHarness({ providerAuthResult: () => new Error("token refresh failed") });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } };
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      const [confirmation] = harness.confirmations();
      assert.match(confirmation?.summary ?? "", /WARNING: Provider "alpha" sign-in cannot be resolved/);
      assert.match(confirmation?.details ?? "", /Warning: Provider "alpha" sign-in cannot be resolved/);
    } finally {
      harness.cleanup();
    }
  });

  it("probes live only when asked and warns without blocking the write", async () => {
    // The issue asked for a live check before proposing a tier. Probing by
    // default would spend credits on every check, so it stays opt-in: the
    // caller passes `probe: true` after the user agrees, and a failure is
    // evidence about the provider rather than a reason to reject the write.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => model === "beta/code"
        // Provider bodies arrive with newlines and padding; the warning must
        // stay one line so it cannot push the bounded report apart.
        ? { model, status: "error" as const, reason: "401\n  unauthorized  " }
        : { model, status: "ok" as const }),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
      const checked = await harness.run({ operation: "check", candidate, probe: true });
      const probed = detailsOf<ConfigAgentCheckResult>(checked);
      assert.deepEqual(harness.probeCalls(), [["alpha/strong", "beta/code"]]);
      assert.deepEqual(
        probed.liveProbe?.map((entry) => `${entry.model}:${entry.status}`),
        ["alpha/strong:ok", "beta/code:error"],
      );
      const warning = probed.issues.find((issue) => issue.code === "config.probe_failed");
      assert.match(warning?.message ?? "", /beta\/code failed/);
      assert.equal(probed.status, "ok");
      assert.equal(probed.writeEligible, true);
      assert.match(contentOf(checked), /live probe \(one primary probe per model\):/);

      // Without the flag nothing is sent, so a plain check keeps costing nothing.
      const plain = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate }));
      assert.equal(harness.probeCalls().length, 1);
      assert.equal(plain.liveProbe, undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("states a probe's scope and cost before it runs, and spends only on an answer", async () => {
    // Section A of the review: a plain check must never send, and money must not
    // leave on an assumption. The plan is computed for every writable check; the
    // dialog decides; a host with no dialog records delegated consent in words.
    const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: false,
    });
    try {
      const plain = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate }));
      assert.deepEqual(plain.probePlan, ["alpha/strong", "beta/code"]);
      assert.equal(plain.liveProbe, undefined);
      assert.equal(harness.probeCalls().length, 0);
      assert.equal(harness.probeConfirmations().length, 0, "a plain check must not even ask");
      assert.match(contentOf(await harness.run({ operation: "check", candidate })), /live probe not run: 2 model\(s\), one primary probe each, no session fallback -- alpha\/strong, beta\/code/);

      // A declined dialog sends nothing and says so.
      const declined = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate, probe: true }));
      assert.equal(harness.probeCalls().length, 0);
      assert.match(declined.notes.join("\n"), /Live probe was declined; nothing was sent\./);
      const [question] = harness.probeConfirmations();
      assert.match(question?.message ?? "", /2 probes, one each, no fallback: alpha\/strong, beta\/code/);
      assert.ok(question?.message.includes(PROBE_RESOURCE_DISCLOSURE), "the dialog carries the cost disclosure");
    } finally {
      harness.cleanup();
    }

    // A dialog that fails is not an approval either.
    const failing = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirmError: true,
    });
    try {
      const refused = detailsOf<ConfigAgentCheckResult>(await failing.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      }));
      assert.equal(failing.probeCalls().length, 0);
      assert.match(refused.notes.join("\n"), /declined/);
    } finally {
      failing.cleanup();
    }

    // With no dialog the caller's opt-in is the authorization, and the result
    // must never imply the user approved it.
    const delegated = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      mode: "rpc",
    });
    try {
      const ran = detailsOf<ConfigAgentCheckResult>(await delegated.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      }));
      assert.deepEqual(delegated.probeCalls(), [["alpha/strong"]]);
      assert.match(ran.notes.join("\n"), /delegated consent: this host has no approval dialog/);
      assert.equal(ran.notes.join("\n").includes(PROBE_RESOURCE_DISCLOSURE), false,
        "the report carries the disclosure once, not once per note");
    } finally {
      delegated.cleanup();
    }

    // Approved at the dialog: the probe runs, and apply still never probes even
    // when the caller repeats the flag on the write.
    const approved = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: true,
    });
    try {
      const checked = await approved.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      });
      const details = detailsOf<ConfigAgentCheckResult>(checked);
      assert.deepEqual(approved.probeCalls(), [["alpha/strong"]]);
      assert.match(details.notes.join("\n"), /ran with dialog approval/);
      assert.equal(details.notes.join("\n").includes(PROBE_RESOURCE_DISCLOSURE), false,
        "the report carries the disclosure once, not once per note");
      const applied = detailsOf<ConfigAgentApplyResult>(await approved.run({
        ...applyParams(details, { candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } } }),
        probe: true,
      }));
      assert.equal(applied.applied, true);
      assert.equal(approved.probeCalls().length, 1, "apply must never send a probe request");
    } finally {
      approved.cleanup();
    }
  });

  it("resolves inherited providers exposed by removing project models before probing", async () => {
    const resolved: string[] = [];
    const harness = freshHarness({
      knownOnly: [makeModel("delta", "legacy")],
      providerAuthStatus: (provider) => {
        resolved.push(provider);
        return { configured: provider !== "delta" };
      },
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      harness.writeFile("agent/bifrost.json", { schemaVersion: 2, default: "review", models: { review: ["delta/legacy"] } });
      harness.writeFile(".pi/bifrost.json", { models: { review: ["alpha/strong"] } });
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: {}, remove: ["models"], probe: true }));
      assert.equal(checked.status, "ok");
      assert.ok(resolved.includes("delta"));
      assert.ok(checked.probeSkipped?.some((entry) => entry.model === "delta/legacy"));
      assert.equal(harness.probeCalls().flat().includes("delta/legacy"), false);
    } finally {
      harness.cleanup();
    }
  });

  it("does not disclose provider error text in the tool result or approval", async () => {
    const secret = "private-provider-error-canary";
    const harness = freshHarness({ probeModels: (models) => models.map((model) => ({ model, status: "error" as const, reason: secret })) });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } };
      const checked = await harness.run({ operation: "check", candidate, probe: true });
      assert.doesNotMatch(JSON.stringify(checked), new RegExp(secret));
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle);
      await harness.run({ operation: "apply", proposalHandle: handle });
      assert.doesNotMatch(JSON.stringify(harness.confirmations()), new RegExp(secret));
    } finally {
      harness.cleanup();
    }
  });

  it("discloses the requested budget and its limits in the schema and offline plan", async () => {
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
    });
    try {
      assert.match(PROBE_RESOURCE_DISCLOSURE, new RegExp(`${PROBE_MAX_TOKENS} output tokens each`));
      assert.match(PROBE_RESOURCE_DISCLOSURE, /may raise\/omit/);
      assert.match(PROBE_RESOURCE_DISCLOSURE, /retries may add/);
      assert.match(PROBE_RESOURCE_DISCLOSURE, /charges may apply/);
      assert.ok(JSON.stringify(harness.tool.parameters).includes(PROBE_RESOURCE_DISCLOSURE));
      const checked = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      });
      assert.ok(contentOf(checked).includes(PROBE_RESOURCE_DISCLOSURE));
      assert.equal(harness.probeCalls().length, 0);
    } finally {
      harness.cleanup();
    }
  });

  it("states the resource disclosure once in a probed report", async () => {
    // The consent dialog already shows the cost. Repeating it in the approval
    // note and again in the report tail would say the same thing twice, so the
    // notes stay terse and the report carries the single disclosure line.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: true,
    });
    try {
      const checked = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      });
      const occurrences = contentOf(checked).split(PROBE_RESOURCE_DISCLOSURE).length - 1;
      assert.equal(occurrences, 1, "the report states the disclosure exactly once");
    } finally {
      harness.cleanup();
    }
  });

  it("counts a probe against what it requested, not what came back", async () => {
    // A transport that answers for fewer models than were asked must not render
    // as a full pass: the denominator is the plan, and the gap is called out.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: () => [{ model: "alpha/strong", status: "ok" }],
    });
    try {
      const checked = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
        probe: true,
      });
      const content = contentOf(checked);
      assert.match(content, /live probe \(one primary probe per model\): 1\/2 answered, 1 without a reported outcome/);
      assert.match(content, /treat them as unverified, not as passing/);
    } finally {
      harness.cleanup();
    }
  });

  it("repeats the checked proposal's probe warning in the approval dialog", async () => {
    // The probe warning is evidence the check gathered. Apply rebuilds its
    // offline check for the stamps, so without carrying the warning with the
    // handle it would silently drop and the user would approve blind.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => model === "beta/code"
        ? { model, status: "error" as const, reason: "401 unauthorized" }
        : { model, status: "ok" as const }),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
      const checked = await harness.run({ operation: "check", candidate, probe: true });
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle, "a writable probe check must mint a handle");

      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", proposalHandle: handle }));
      assert.equal(applied.applied, true);
      const [confirmation] = harness.confirmations();
      assert.match(confirmation?.details ?? "", /Warning: Live probe of beta\/code failed/);
      assert.match(confirmation?.summary ?? "", /WARNING: Live probe of beta\/code failed/);
      assert.equal(harness.probeCalls().length, 1, "apply must repeat the warning without sending another request");
    } finally {
      harness.cleanup();
    }
  });

  it("repeats the warning when the caller applies the checked candidate by digest", async () => {
    // The supported alternative to the handle is copying the printed digests.
    // That request names the same candidate, so dropping the warning there would
    // make the dialog depend on which of the two forms the caller used.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => model === "beta/code"
        ? { model, status: "error" as const, reason: "401 unauthorized" }
        : { model, status: "ok" as const }),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
      const { details } = await checkedCandidate(harness, { candidate, probe: true });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.applied, true);
      const [confirmation] = harness.confirmations();
      assert.match(confirmation?.details ?? "", /Warning: Live probe of beta\/code failed/);
      assert.equal(harness.probeCalls().length, 1, "a digest apply must not send another probe");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the digest warning when the source default and an explicit project differ", async () => {
    // An omitted source means the project layer. A check that omitted it and an
    // apply that spells out "project" describe the same candidate, so the probe
    // warning must survive instead of depending on the spelling.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => model === "beta/code"
        ? { model, status: "error" as const, reason: "401 unauthorized" }
        : { model, status: "ok" as const }),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
      const { details } = await checkedCandidate(harness, { candidate, probe: true });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(
        applyParams(details, { candidate, source: "project" }),
      ));
      assert.equal(applied.applied, true);
      const [confirmation] = harness.confirmations();
      assert.match(confirmation?.details ?? "", /Warning: Live probe of beta\/code failed/);
      assert.equal(harness.probeCalls().length, 1, "a digest apply must not send another probe");
    } finally {
      harness.cleanup();
    }
  });

  it("bounds a huge provider error so it cannot block approval", async () => {
    // Provider text reaches an approval message whose size is capped. An error
    // body over that cap would turn an advisory probe failure into a refusal to
    // apply a candidate that is otherwise fine.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => model === "beta/code"
        ? { model, status: "error" as const, reason: `<html>${"x".repeat(5_000)}</html>` }
        : { model, status: "ok" as const }),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };
      const checked = await harness.run({ operation: "check", candidate, probe: true });
      const probed = detailsOf<ConfigAgentCheckResult>(checked);
      const warning = probed.issues.find((issue) => issue.code === "config.probe_failed");
      assert.ok(warning, "a failed probe must warn");
      assert.ok(warning!.message.length < 400, `warning must stay bounded, got ${warning!.message.length} chars`);
      assert.match(warning!.message, /^Live probe of beta\/code failed/);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({
        operation: "apply",
        proposalHandle: contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1],
      }));
      assert.equal(applied.applied, true, "a long provider error must not make the candidate unwritable");
    } finally {
      harness.cleanup();
    }
  });

  it("never probes a provider the tier's routing scope excludes", async () => {
    // The scope is a hard eligibility filter, so a probe of an excluded
    // provider would spend a request on a model that can never be selected.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "review",
          models: { review: ["alpha/strong", "beta/code"] },
          routingScope: { tiers: { review: { providers: ["beta"] } } },
        },
        probe: true,
      });
      assert.deepEqual(harness.probeCalls(), [["beta/code"]]);
    } finally {
      harness.cleanup();
    }
  });

  it("skips models whose provider sign-in does not resolve and never counts them as failures", async () => {
    // The adapter already resolved sign-in for the check; a provider whose
    // credential cannot be resolved cannot prove model reachability. Probing it
    // would spend a request on a guaranteed 401 and report an account problem
    // as a model failure.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      providerAuthResult: (provider) => provider === "beta" ? new Error("token refresh failed") : { auth: { apiKey: "resolved" } },
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } };

      // A plain check reports the split and still sends nothing.
      const plain = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate }));
      assert.deepEqual(plain.probePlan, ["alpha/strong"]);
      assert.deepEqual(plain.probeSkipped?.map((entry) => `${entry.model}:${entry.status}`), ["beta/code:skipped"]);
      assert.deepEqual(harness.probeCalls(), []);
      assert.equal(harness.probeConfirmations().length, 0);
      assert.equal(plain.issues.some((issue) => issue.code === "config.probe_failed"), false,
        "a skipped model must not be reported as a probe failure");

      // The plan and the requests agree: the transport only receives the target
      // that can actually answer.
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate, probe: true }));
      assert.deepEqual(harness.probeCalls(), [["alpha/strong"]]);
      assert.deepEqual(checked.liveProbe?.map((entry) => `${entry.model}:${entry.status}`), ["alpha/strong:ok"]);
      assert.deepEqual(checked.probeSkipped?.map((entry) => entry.model), ["beta/code"]);
      assert.equal(checked.issues.some((issue) => issue.code === "config.probe_failed"), false);
      assert.match(checked.notes.join("\n"), /not probed because their provider's sign-in does not resolve/);
      const text = contentOf(await harness.run({ operation: "check", candidate, probe: true }));
      assert.match(text, /live probe skipped: 1 model\(s\) whose provider's sign-in does not resolve/);
      assert.match(text, /skipped is not a probe failure/);
    } finally {
      harness.cleanup();
    }
  });

  it("runs no request when every target's provider is excluded for the session", async () => {
    const harness = freshHarness({
      available: [makeModel("beta", "code", 0.5, 1.5, 128_000)],
      providerAuthStatus: () => ({ configured: false }),
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: true,
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["beta/code"] } },
        probe: true,
      }));
      assert.deepEqual(harness.probeCalls(), []);
      assert.equal(harness.probeConfirmations().length, 0, "nothing may be spent, so nothing is asked");
      assert.equal(checked.liveProbe, undefined);
      assert.deepEqual(checked.probeSkipped?.map((entry) => entry.model), ["beta/code"]);
      assert.match(checked.notes.join("\n"), /every model this candidate routes to belongs to a provider whose sign-in does not resolve/);
    } finally {
      harness.cleanup();
    }
  });

  it("probes a model reached only through the effective route-file rules", async () => {
    // The classifier resolves rules through loadRules: a route file replaces the
    // inline `rules` field entirely. A probe that read `config.rules` would miss
    // the direct model the runtime actually dispatches, and would spend on one it
    // never selects.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000), makeModel("gamma", "review", 2, 6, 128_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      harness.writeFile(".pi/bifrost-routes.json", [
        { pattern: "review", model: "gamma/review" },
      ]);
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "review",
          models: { review: ["alpha/strong"] },
          rules: [{ pattern: "review", model: "beta/code" }],
        },
        probe: true,
      }));
      assert.deepEqual(checked.probePlan, ["alpha/strong", "gamma/review"],
        "the route file overrides inline rules, so its direct model must be the probe target");
      assert.deepEqual(harness.probeCalls(), [["alpha/strong", "gamma/review"]]);
      assert.equal(checked.probePlan?.includes("beta/code"), false, "an overridden inline rule is not a probe target");
    } finally {
      harness.cleanup();
    }
  });

  it("resolves the provider of a rule-file-only model before the probe plan", async () => {
    // A known model Pi does not offer can still be reached by a direct rule. Its
    // provider must be resolved like any pool provider, or the probe cannot see
    // that the sign-in is dead and spends a request on it.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000)],
      knownOnly: [makeModel("delta", "legacy", 1, 1, 64_000)],
      providerAuthResult: (provider) => provider === "delta" ? new Error("no usable token") : { auth: { apiKey: "resolved" } },
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      harness.writeFile(".pi/bifrost-routes.json", [{ pattern: "review", model: "delta/legacy" }]);
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
      }));
      assert.deepEqual(checked.probePlan, ["alpha/strong"]);
      assert.deepEqual(checked.probeSkipped?.map((entry) => `${entry.model}:${entry.status}`), ["delta/legacy:skipped"],
        "the rule-file model's dead sign-in must be reported as skipped, not probed");
    } finally {
      harness.cleanup();
    }
  });

  it("does not probe a direct rule routing would refuse to compile", async () => {
    // The classifier compiles rules and drops an invalid pattern before it can
    // match. A probe reading the raw rules would spend a request on a model no
    // prompt can select.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("gamma", "review", 2, 6, 128_000)],
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      // A route file is not validated like a candidate, so its invalid pattern
      // reaches `compileRules` and is dropped there — exactly the rule this test
      // must not turn into a probe target.
      harness.writeFile(".pi/bifrost-routes.json", [{ pattern: "(", model: "gamma/review" }]);
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: {
          schemaVersion: 2,
          default: "review",
          models: { review: ["alpha/strong"] },
        },
        probe: true,
      }));
      assert.deepEqual(checked.probePlan, ["alpha/strong"],
        "a rule routing drops must not become a probe target");
      assert.deepEqual(harness.probeCalls(), [["alpha/strong"]]);
    } finally {
      harness.cleanup();
    }
  });

  it("forwards the caller's cancellation to the probe transport", async () => {
    const controller = new AbortController();
    const harness = freshHarness({
      signal: controller.signal,
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      await harness.run({ operation: "check", candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } }, probe: true });
      assert.equal(harness.probeSignals()[0], controller.signal);
    } finally {
      harness.cleanup();
    }
  });

  it("does not start a probe after the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = freshHarness({
      signal: controller.signal,
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      }));
      assert.deepEqual(harness.probeCalls(), []);
      assert.match(checked.notes.join(" "), /Live probe cancelled before it started/);
    } finally {
      harness.cleanup();
    }
  });

  it("renders probe totals and only the failed models so long reports keep warnings", async () => {
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: () => [
        { model: "alpha/strong", status: "ok" },
        { model: "beta/code", status: "error", reason: "401 unauthorized" },
      ],
    });
    try {
      const result = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
        probe: true,
      });
      const text = contentOf(result);
      assert.match(text, /live probe \(one primary probe per model\): 1\/2 answered/);
      assert.match(text, /beta\/code: error/);
      assert.doesNotMatch(text, /alpha\/strong: ok/);
    } finally {
      harness.cleanup();
    }
  });

  it("counts a cancelled probe as skipped instead of folding it into the total", async () => {
    // A cancelled probe may already have sent the request, so calling it
    // "answered" would overstate the result while "not asked" would understate
    // what it may have cost.
    const harness = freshHarness({
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: () => [
        { model: "alpha/strong", status: "ok" },
        { model: "beta/code", status: "skipped" },
      ],
    });
    try {
      const result = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
        probe: true,
      });
      const text = contentOf(result);
      assert.match(text, /live probe \(one primary probe per model\): 1\/2 answered, 1 skipped/);
      assert.match(text, /1 model skipped: the check was cancelled, or the model was not asked; a cancelled request may already have been sent and charged/);
      assert.doesNotMatch(text, /2\/2 answered/);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps partial outcomes and adds no warning when the probe is cancelled mid-run", async () => {
    // Cancellation is detected after the transport returns. The outcomes it did
    // report are shown, but they are not turned into config.probe_failed
    // warnings: stopping the run is not evidence about the models.
    const controller = new AbortController();
    const harness = freshHarness({
      signal: controller.signal,
      available: [makeModel("alpha", "strong", 5, 15, 200_000), makeModel("beta", "code", 0.5, 1.5, 128_000)],
      probeModels: () => {
        controller.abort();
        return [
          { model: "alpha/strong", status: "error", reason: "connection reset" },
          { model: "beta/code", status: "timeout" },
        ];
      },
    });
    try {
      const result = await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
        probe: true,
      });
      const checked = detailsOf<ConfigAgentCheckResult>(result);
      assert.deepEqual(checked.liveProbe?.map((entry) => entry.status), ["error", "timeout"]);
      assert.equal(checked.issues.filter((issue) => issue.code === "config.probe_failed").length, 0,
        "a cancelled run must not turn a partial outcome into a probe warning");
      assert.match(checked.notes.join("\n"), /Live probe was cancelled; the reported outcomes are partial and were not turned into warnings\./);
      assert.match(contentOf(result), /alpha\/strong: error/);
    } finally {
      harness.cleanup();
    }
  });

  it("fault control: a live probe that throws reports it and never blocks the write", async () => {
    // A probe failure is evidence about the provider, not a validation error.
    // Throwing transport must not escape the tool or make the candidate
    // unwritable, because the user may still apply and sign in afterwards.
    const harness = freshHarness({
      probeModels: () => { throw new Error("provider transport refused"); },
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } },
        probe: true,
      }));
      assert.equal(checked.status, "ok");
      assert.equal(checked.liveProbe, undefined);
      assert.equal(checked.writeEligible, true);
      assert.match(checked.notes.join(" "), /Live probe could not run/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("reports an empty probe result as unverified, never as a pass", async () => {
    // A transport that answers with no outcomes proves nothing. Recording an
    // empty list would render as a completed probe with every model missing.
    const harness = freshHarness({ probeModels: () => [] });
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } };
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate, probe: true }));
      assert.equal(checked.liveProbe, undefined);
      assert.match(checked.notes.join(" "), /Live probe returned no result; nothing was written/);
      assert.equal(checked.issues.some((issue) => issue.code === "config.probe_failed"), false);
      assert.equal(checked.writeEligible, true);
      assert.doesNotMatch(contentOf(await harness.run({ operation: "check", candidate, probe: true })), /answered/);
      // The tool probe is not the init report: it must never write that file.
      assert.equal(harness.readFile(".pi/bifrost-probe.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("reports the plan even when the host cannot live-probe", async () => {
    // Plan creation is offline and must not depend on the probe seam. A host
    // without a transport still owes the caller the documented target list, and
    // asking to probe it must say the seam is missing rather than pretend.
    const harness = freshHarness();
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } };
      const planned = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate }));
      assert.deepEqual(planned.probePlan, ["alpha/strong"], "a transport-free check still plans");
      assert.equal(planned.liveProbe, undefined);
      assert.match(contentOf(await harness.run({ operation: "check", candidate })),
        /live probe not run: 1 model\(s\), one primary probe each, no session fallback -- alpha\/strong/);

      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate,
        probe: true,
      }));
      assert.equal(checked.liveProbe, undefined);
      assert.match(checked.notes.join(" "), /Live probe is unavailable in this host/);
    } finally {
      harness.cleanup();
    }
  });

  it("names every approved target in the probe consent dialog", async () => {
    // A prefix plus a count asks the user to approve requests to models they
    // cannot see. Every target the plan carries is named in the confirmation.
    const available = Array.from({ length: 10 }, (_, index) => makeModel("p", `m${index}`, 1));
    const harness = freshHarness({
      available,
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: false,
    });
    try {
      const pool = available.map((model) => `${model.provider}/${model.id}`);
      await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: pool } },
        probe: true,
      });
      const [question] = harness.probeConfirmations();
      for (const key of pool) assert.match(question?.message ?? "", new RegExp(key.replace("/", "\\/")), `dialog must name ${key}`);
      assert.doesNotMatch(question?.message ?? "", /more\. A result/, "the dialog must not hide targets behind a count");
    } finally {
      harness.cleanup();
    }
  });

  it("fits a realistic 20-model consent dialog in a small terminal", async () => {
    // The dialog body renders above every model id, and Pi keeps only the bottom
    // of an overflowing dialog, so extra prose scrolls the title and the leading
    // ids off the top. This pins the height budget at the narrowest supported
    // width rather than trusting the wording to stay short.
    const ids = [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.1-codex-mini",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-v3.2",
      "moonshot/kimi-k2-0905",
    ];
    const available = Array.from({ length: 20 }, (_, index) => makeModel("p", `${ids[index % ids.length]!.split("/")[1]}-${index}`, 1));
    const harness = freshHarness({
      available,
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
      probeConfirm: false,
    });
    try {
      const pool = available.map((model) => `${model.provider}/${model.id}`);
      await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: pool } },
        probe: true,
      });
      const [question] = harness.probeConfirmations();
      const rows = probeConsentDialogRows(question?.title ?? "", question?.message ?? "", 60);
      // 24 rows is the smallest terminal the smoke suite drives. The dialog needs
      // a title, the model list, the choice and the key hints to stay readable.
      assert.ok(rows <= 24, `consent dialog must fit a 24-row terminal, measured ${rows} rows at 60 columns`);
      for (const key of pool) assert.ok(question?.message.includes(key), `dialog must still name ${key}`);
    } finally {
      harness.cleanup();
    }
  });

  it("stops resolving sign-in and never starts a probe after cancellation", async () => {
    // The tool's signal now reaches credential preparation too: a cancelled call
    // must not resolve the remaining providers or send a probe request.
    const controller = new AbortController();
    const resolved: string[] = [];
    const harness = freshHarness({
      signal: controller.signal,
      providerAuthResult: (provider) => {
        resolved.push(provider);
        controller.abort();
        return { auth: { apiKey: "resolved" } };
      },
      probeModels: (models) => models.map((model) => ({ model, status: "ok" as const })),
    });
    try {
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        candidate: { schemaVersion: 2, default: "review", models: { review: ["alpha/strong", "beta/code"] } },
        probe: true,
      }));
      assert.deepEqual(resolved, ["alpha"], "no resolution may start after cancellation");
      const beta = checked.providerAuth.find((entry) => entry.provider === "beta");
      assert.equal(beta?.state, "unknown", "an unasked provider is not proof of a dead sign-in");
      assert.deepEqual(harness.probeCalls(), [], "a cancelled call must not send a probe request");
      assert.match(checked.notes.join(" "), /Live probe cancelled before it started/);
    } finally {
      harness.cleanup();
    }
  });
});

describe("candidate validation reuses Bifrost semantics", () => {
  it("rejects an over-depth apply after a proposal instead of canonicalizing it", async () => {
    // Apply first compares the incoming request with the saved proposal. That
    // comparison canonicalizes, which recurses: doing it before the depth guard
    // turns a validation rejection into a stack overflow.
    const harness = freshHarness();
    try {
      const candidate = { schemaVersion: 2, default: "review", models: { review: ["alpha/strong"] } };
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", candidate }));
      assert.equal(checked.status, "ok");

      let nested: unknown = 0;
      for (let i = 0; i < 5000; i++) nested = { child: nested };
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", candidate: { nested } }));
      assert.equal(applied.status, "usage");
      assert.equal(applied.reason, "configuration exceeds the nesting depth limit");
      assert.equal(applied.applied, false);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects deeply nested candidates and source files without throwing", async () => {
    const harness = freshHarness();
    try {
      let nested: unknown = 0;
      for (let i = 0; i < 5000; i++) nested = { child: nested };
      for (const operation of ["check", "preview", "apply"]) {
        const result = detailsOf<{ status: string; reason?: string }>(await harness.run({ operation, candidate: { nested } }));
        assert.notEqual(result.status, "ok");
      }
      harness.writeFile(".pi/bifrost.json", '{"nested":' + '{"child":'.repeat(5000) + '0' + '}'.repeat(5000) + '}');
      const result = detailsOf<{ status: string }>(await harness.run({ operation: "check", candidate: { enabled: false } }));
      assert.notEqual(result.status, "ok");
      assert.equal(harness.confirmations().length, 0);
    } finally { harness.cleanup(); }
  });
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

  it("marks preview selection as uncertain when Auto sign-in exclusions apply", async () => {
    const harness = freshHarness({
      providerAuthStatus: (provider) => ({ configured: provider !== "alpha" }),
    });
    try {
      const candidate = {
        schemaVersion: 2, default: "review", classifier: { enabled: false },
        models: { review: ["alpha/strong", "beta/code"] }, signInEligibility: "exclude",
      };
      const preview = detailsOf<ConfigAgentPreviewResult>(await harness.run({ operation: "preview", candidate, prompts: ["review work"] }));
      assert.equal(preview.cases[0]?.confidence, "sign_in_dependent");
      assert.ok(preview.notes.some((note) => /sign-in exclusions are not applied/i.test(note)));
      const off = detailsOf<ConfigAgentPreviewResult>(await harness.run({ operation: "preview", candidate: { ...candidate, signInEligibility: "off" }, prompts: ["review work"] }));
      assert.equal(off.cases[0]?.confidence, "deterministic");
    } finally {
      harness.cleanup();
    }
  });

  it("honors provider scope in version 2 and 3 previews", async () => {
    const harness = freshHarness();
    try {
      for (const schemaVersion of [2, 3]) {
        for (const providers of [["beta"], []]) {
          const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
            operation: "preview",
            candidate: { schemaVersion, default: "work", models: { work: ["alpha/strong", "beta/code"] }, routingScope: { providers }, classifier: { enabled: false } },
            prompts: ["work make a change"],
          }));
          assert.equal(details.status, "ok");
          assert.equal(details.tiers.find((tier) => tier.tier === "work")?.selected, providers.length ? "beta/code" : undefined);
          assert.equal(details.cases[0]?.selected, providers.length ? "beta/code" : undefined);
        }
      }
    } finally { harness.cleanup(); }
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
          rules: [{ pattern: "\\breview\\b", model: "review" }],
        },
        prompts: ["make the change", "please review this diff"],
      }));
      const byPrompt = new Map(details.cases.map((entry) => [entry.prompt, entry]));
      assert.equal(byPrompt.get("make the change")?.confidence, "classifier_dependent");
      // A tier regex rule runs only after the live classifier, so an enabled
      // classifier can replace this tier; the case must not claim certainty.
      assert.equal(byPrompt.get("please review this diff")?.decidedBy, "regex_rule");
      assert.equal(byPrompt.get("please review this diff")?.confidence, "classifier_dependent");
      assert.ok(details.notes.some((note) => /classifier/.test(note)));
    } finally {
      harness.cleanup();
    }
  });

  it("marks a rule that binds a physical model deterministic even with the classifier enabled", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "implement",
          models: { implement: ["beta/code"], review: ["gamma/review"] },
          classifier: { enabled: true },
          rules: [{ pattern: "\\bpin\\b", model: "alpha/strong" }],
        },
        prompts: ["pin this file"],
      }));
      const pinned = details.cases.find((entry) => entry.prompt === "pin this file");
      // Routing applies a direct model binding before any classifier call.
      assert.equal(pinned?.decidedBy, "regex_rule");
      assert.equal(pinned?.confidence, "deterministic");
      assert.equal(pinned?.selected, "alpha/strong");
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

  it("stays silent about prompt coverage when every supplied prompt was evaluated", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 8 }, (_, index) => `task ${index + 1}`);
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 8);
      assert.equal(details.notes.some((note) => /supplied prompts|exceeded|blank/.test(note)), false);

      const none = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: [] }),
      );
      assert.deepEqual(none.cases, []);
      assert.equal(none.notes.some((note) => /supplied prompts|exceeded|blank/.test(note)), false);
    } finally {
      harness.cleanup();
    }
  });

  it("reports prompts beyond the evaluation limit", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 11 }, (_, index) => `task ${index + 1}`);
      const result = await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      assert.equal(details.cases.length, 8);
      assert.ok(details.notes.includes("preview considered the first 8 of 11 supplied prompts."));
      assert.match(contentOf(result), /note: preview considered the first 8 of 11 supplied prompts\./);
    } finally {
      harness.cleanup();
    }
  });

  it("reports skipped blank or non-text entries instead of counting them as evaluated", async () => {
    const harness = freshHarness();
    try {
      const prompts: unknown[] = ["task 1", "", "task 3", "   ", 42, "task 6", "task 7", "task 8", "task 9"];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 5);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts; 3 were blank or not text, so 5 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("reports skipped entries when the prompt limit was not reached", async () => {
    const harness = freshHarness();
    try {
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: ["task 1", "", "task 3"] }),
      );
      assert.equal(details.cases.length, 2);
      assert.ok(details.notes.includes("preview skipped 1 of 3 supplied prompts as blank or not text, so 2 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("reports when every considered prompt in an over-limit request was skipped", async () => {
    const harness = freshHarness();
    try {
      const prompts: unknown[] = ["", " ", 1, null, undefined, "\t", {}, [], "task 9"];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 0);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts; 8 were blank or not text, so 0 were evaluated."));
    } finally {
      harness.cleanup();
    }
  });

  it("distinguishes a blank input from a prompt whose inspected prefix was blank", async () => {
    const harness = freshHarness();
    try {
      const overlongBlankPrefix = " ".repeat(2_000) + "SENSITIVE-TAIL";
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({
          operation: "preview",
          candidate: threeRoleGoal,
          prompts: ["", overlongBlankPrefix, "task 3"],
        }),
      );
      assert.equal(details.cases.length, 1);
      assert.deepEqual(details.cases.map((c) => c.prompt), ["task 3"]);
      assert.ok(details.notes.includes("preview skipped 2 of 3 supplied prompts as blank or not text (1 was blank in the first 2,000 characters inspected), so 1 was evaluated."));
      assert.equal(details.notes.some((note) => /exceeded 2,000 characters/.test(note)), false);
      assert.ok(details.notes.every((note) => !note.includes("SENSITIVE-TAIL")));
    } finally {
      harness.cleanup();
    }
  });

  it("reports truncated prompts by position without echoing the tail", async () => {
    const harness = freshHarness();
    try {
      const long = `review ${"x".repeat(1_000_000)} SENSITIVE-TAIL`;
      const exact = "y".repeat(2_000);
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts: ["task 1", long, exact] }),
      );
      assert.equal(details.cases[1]?.prompt.length, 2_000);
      assert.ok(!details.cases[1]?.prompt.includes("SENSITIVE-TAIL"));
      assert.equal(details.cases[2]?.prompt.length, 2_000);
      assert.ok(details.notes.includes("prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters."));
      assert.ok(details.notes.every((note) => !note.includes("SENSITIVE-TAIL")));
    } finally {
      harness.cleanup();
    }
  });

  it("reports both limit overflow and truncation", async () => {
    const harness = freshHarness();
    try {
      const long = "x".repeat(2_001);
      const prompts = ["ok", long, ...Array.from({ length: 7 }, (_, i) => `task ${i + 3}`)];
      const details = detailsOf<ConfigAgentPreviewResult>(
        await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts }),
      );
      assert.equal(details.cases.length, 8);
      assert.ok(details.notes.includes("preview considered the first 8 of 9 supplied prompts."));
      assert.ok(details.notes.includes("prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters."));
    } finally {
      harness.cleanup();
    }
  });

  it("keeps coverage notes and digests visible when preview report exceeds the 120-line bound", async () => {
    const harness = freshHarness();
    try {
      const prompts = Array.from({ length: 11 }, (_, i) => `task ${i + 1} ${"detail ".repeat(30)}`);
      prompts[1] = "x".repeat(2_001);
      const result = await harness.run({ operation: "preview", candidate: threeRoleGoal, prompts });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      const bigCase = {
        prompt: "x".repeat(200),
        decidedBy: "default_tier" as const,
        confidence: "deterministic" as const,
        tier: "implement",
        selectedTier: "implement",
        selected: "beta/code",
        excluded: Array.from({ length: 200 }, (_, i) => ({ model: `missing/model-${i}`, exclusion: "not_in_catalog" })),
        unavailable: Array.from({ length: 200 }, (_, i) => `missing/model-${i}`),
      };
      const synthetic: ConfigAgentPreviewResult = {
        ...details,
        notes: [...details.notes, "tier\nname"],
        cases: Array.from({ length: 8 }, () => bigCase),
      };
      const text = reportText(synthetic);
      const lines = text.split("\n");
      assert.match(text, /note: preview considered the first 8 of 11 supplied prompts\./);
      assert.match(text, /note: prompt 2 exceeded 2,000 characters; each route was computed from the first 2,000 characters\./);
      assert.match(text, /note: tier\\nname/);
      assert.match(text, /proposalDigest: [a-f0-9]{64}/);
      assert.match(text, /catalogDigest: [a-f0-9]{64}/);
      assert.equal(lines.length, 120, `report should respect 120-line bound, got ${lines.length}`);
      assert.ok(lines.some((line) => line.includes("more line(s)")), "expected report to be bounded in this fixture");
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

describe("nested patches merge instead of replacing a whole field (#237)", () => {
  it("changes only the named classifier field and keeps its siblings", async () => {
    const harness = freshHarness();
    try {
      const classifier = {
        enabled: true,
        backend: "pi-native",
        piNative: { model: "alpha/strong" },
        criteria: { general: "general work" },
        fallback: "regex",
        minConfidence: 0.7,
      };
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier,
      });

      const { details } = await checkedCandidate(harness, { patch: { classifier: { minConfidence: 0.5 } } });

      assert.deepEqual(details.nextSource?.classifier, { ...classifier, minConfidence: 0.5 });
    } finally {
      harness.cleanup();
    }
  });

  it("keeps other model tiers and replaces only the named pool", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"], quick: ["beta/code"], frontier: ["gamma/review"] },
      });

      const { details } = await checkedCandidate(harness, { patch: { models: { general: ["gamma/review"] } } });

      assert.deepEqual(details.nextSource?.models, {
        general: ["gamma/review"],
        quick: ["beta/code"],
        frontier: ["gamma/review"],
      });
    } finally {
      harness.cleanup();
    }
  });

  it("merges objects three levels deep and keeps every sibling object", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"], quick: ["beta/code"] },
        classifier: {
          enabled: true,
          backend: "pi-native",
          criteria: { general: "general work" },
          piNative: { model: "alpha/strong", timeoutMs: 4000, maxAttempts: 2, metrics: { enabled: true } },
        },
        tierPolicies: { general: { fallbackTiers: [] }, quick: { fallbackTiers: ["general"] } },
      });

      const { details } = await checkedCandidate(harness, {
        patch: {
          classifier: { piNative: { metrics: { enabled: false } } },
          tierPolicies: { quick: { fallbackTiers: [] } },
        },
      });

      assert.deepEqual(details.nextSource?.classifier, {
        enabled: true,
        backend: "pi-native",
        criteria: { general: "general work" },
        piNative: { model: "alpha/strong", timeoutMs: 4000, maxAttempts: 2, metrics: { enabled: false } },
      });
      assert.deepEqual(details.nextSource?.tierPolicies, {
        general: { fallbackTiers: [] },
        quick: { fallbackTiers: [] },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("replaces arrays outright, keeping their order and duplicate entries", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong", "beta/code"] },
      });

      const { details } = await checkedCandidate(harness, {
        patch: { models: { general: ["beta/code", "alpha/strong", "beta/code"] } },
      });

      assert.deepEqual(details.nextSource?.models, { general: ["beta/code", "alpha/strong", "beta/code"] });
    } finally {
      harness.cleanup();
    }
  });

  it("treats null as a value and an empty object as no change", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "general work" } },
        cache: { enabled: true, maxEntries: 500 },
      });

      const { details } = await checkedCandidate(harness, {
        patch: { classifier: { criteria: { frontier: null }, minConfidence: 0.4 }, cache: {} },
      });

      assert.deepEqual(details.nextSource?.classifier, {
        enabled: true,
        backend: "pi-native",
        criteria: { general: "general work", frontier: null },
        minConfidence: 0.4,
      });
      assert.deepEqual(details.nextSource?.cache, { enabled: true, maxEntries: 500 });
    } finally {
      harness.cleanup();
    }
  });

  it("keeps top-level remove and full candidate replacement behaviour", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        strategy: "random",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "general work" } },
      });

      const { details } = await checkedCandidate(harness, {
        patch: { classifier: { minConfidence: 0.5 } },
        remove: ["strategy"],
      });
      assert.equal(Object.hasOwn(details.nextSource ?? {}, "strategy"), false);
      assert.deepEqual(details.nextSource?.classifier, {
        enabled: true,
        backend: "pi-native",
        criteria: { general: "general work" },
        minConfidence: 0.5,
      });

      const replaced = await checkedCandidate(harness, {
        candidate: { schemaVersion: 2, default: "general", models: { general: ["alpha/strong"] } },
      });
      assert.deepEqual(replaced.details.nextSource, {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("lets a remove and a patch on the same key start from nothing", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        tierPolicies: { general: { fallbackTiers: ["general"] } },
      });

      const { details } = await checkedCandidate(harness, {
        patch: { tierPolicies: { general: { fallbackTiers: [] } } },
        remove: ["tierPolicies"],
      });

      // The old delete-then-assign order replaced the removed value outright;
      // merging into the deleted value would silently resurrect its siblings.
      assert.deepEqual(details.nextSource?.tierPolicies, { general: { fallbackTiers: [] } });
    } finally {
      harness.cleanup();
    }
  });

  it("does not copy inherited layer values into the edited source", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile("bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { fallbackToRegex: true, model: "alpha/strong" },
      });
      harness.writeFile(".pi/bifrost.json", {
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "project work" } },
      });

      const { details } = await checkedCandidate(harness, {
        source: "project",
        patch: { classifier: { minConfidence: 0.5 } },
      });

      assert.deepEqual(details.nextSource?.classifier, {
        enabled: true,
        backend: "pi-native",
        criteria: { general: "project work" },
        minConfidence: 0.5,
      });
    } finally {
      harness.cleanup();
    }
  });

  it("writes the merged source through approval and reloads it", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "general work" }, minConfidence: 0.7 },
      });
      const params = { patch: { classifier: { minConfidence: 0.5 } } };

      const { details } = await checkedCandidate(harness, params);
      const applyResult = await harness.run(applyParams(details, params));
      const applied = detailsOf<ConfigAgentApplyResult>(applyResult);

      assert.equal(applied.status, "ok");
      assert.equal(applied.applied, true);
      assert.equal(applied.reloaded, true);
      assert.match(contentOf(applyResult), /replace \/classifier\/minConfidence: 0\.7 -> 0\.5/);
      const stored = JSON.parse(harness.readFile(".pi/bifrost.json") ?? "{}") as Record<string, unknown>;
      assert.deepEqual(stored.classifier, {
        enabled: true,
        backend: "pi-native",
        criteria: { general: "general work" },
        minConfidence: 0.5,
      });
      const reloaded = loadConfigForReload(harness.cwd, harness.extensionDir).config;
      assert.equal(reloaded.classifier?.minConfidence, 0.5);
      assert.deepEqual(reloaded.classifier?.criteria, { general: "general work" });
    } finally {
      harness.cleanup();
    }
  });

  it("shows the nested path it changed in the check report and approval details", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", minConfidence: 0.7 },
      });
      const params = { patch: { classifier: { minConfidence: 0.5 } } };

      const { details, result } = await checkedCandidate(harness, params);
      const report = contentOf(result);
      assert.match(report, /replace \/classifier\/minConfidence: 0\.7 -> 0\.5/);
      assert.doesNotMatch(report, /replace \/classifier:/, "the report names the leaf, not the parent object");

      await harness.run(applyParams(details, params));
      const dialog = harness.confirmations()[0]?.details ?? "";
      assert.match(dialog, /replace "\/classifier\/minConfidence"/);
      assert.match(dialog, /"\/classifier\/minConfidence": 0\.7 -> 0\.5/, "the exact before and after values stay visible");
    } finally {
      harness.cleanup();
    }
  });

  it("allows constructor and prototype as tier names but rejects __proto__ inside arrays", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
      });

      // `constructor` and `prototype` are ordinary own-property writes; a tier may
      // legitimately carry either name, so only `__proto__` is unsafe.
      const allowed = await checkedCandidate(harness, {
        patch: { models: { constructor: ["beta/code"], prototype: ["gamma/review"] } },
      });
      assert.deepEqual(allowed.details.nextSource?.models, {
        general: ["alpha/strong"],
        constructor: ["beta/code"],
        prototype: ["gamma/review"],
      });
      assert.equal(Object.getPrototypeOf(allowed.details.nextSource?.models), Object.prototype);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);

      // An array element is never index-assigned by the merge, but the guard has
      // to see it: future or looser item schemas must not become a bypass.
      const inArray = JSON.parse('{"__proto__":{"polluted":true},"pattern":"x","model":"general"}');
      for (const patch of [
        { rules: [inArray] },
        { rules: [[inArray]] },
        { economics: { sources: [inArray] } },
      ]) {
        const result = await harness.run({ operation: "check", patch });
        const details = detailsOf<ConfigAgentCheckResult>(result);
        assert.equal(details.status, "usage", JSON.stringify(details.notes));
        assert.match(details.notes.join(" "), /unsafe key/);
      }
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects unsafe keys in a patch without touching Object.prototype", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native" },
      });

      // JSON.parse builds an own "__proto__" property instead of setting the prototype.
      const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
      const result = await harness.run({ operation: "check", patch: { classifier: unsafe } });
      const details = detailsOf<ConfigAgentCheckResult>(result);

      assert.equal(details.status, "usage");
      assert.match(details.notes.join(" "), /unsafe key/);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(Object.hasOwn(details.nextSource ?? {}, "polluted"), false);
    } finally {
      harness.cleanup();
    }
  });

  it("reports a nested removal instead of hiding it behind the parent object", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "general work" } },
      });

      const { details, result } = await checkedCandidate(harness, {
        candidate: {
          schemaVersion: 2,
          default: "general",
          models: { general: ["alpha/strong"] },
          classifier: { enabled: true, backend: "pi-native" },
        },
      });

      assert.ok(details.nestedChanges.some((change) => change.kind === "remove" && change.field === "/classifier/criteria"));
      assert.match(contentOf(result), /remove \/classifier\/criteria \(was \{"general":"general work"\}\)/);
    } finally {
      harness.cleanup();
    }
  });

  it("does not mutate the caller's patch or the stored source", async () => {
    const harness = freshHarness();
    try {
      const source = {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native", criteria: { general: "general work" } },
      };
      harness.writeFile(".pi/bifrost.json", source);
      const patch = { classifier: { piNative: { metrics: { enabled: false } }, criteria: { general: "changed" } } };
      const patchSnapshot = structuredClone(patch);
      const sourceSnapshot = structuredClone(source);

      await checkedCandidate(harness, { patch });

      assert.deepEqual(patch, patchSnapshot);
      assert.deepEqual(JSON.parse(harness.readFile(".pi/bifrost.json") ?? "null"), sourceSnapshot);
    } finally {
      harness.cleanup();
    }
  });

  it("still applies the shipped schema to a merged field", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
        classifier: { enabled: true, backend: "pi-native" },
      });

      const result = await harness.run({ operation: "check", patch: { classifier: { notAField: true } } });
      const details = detailsOf<ConfigAgentCheckResult>(result);

      assert.equal(details.status, "rejected");
      assert.ok(details.issues.some((issue) => issue.code === "config.schema_unsupported_field"), JSON.stringify(details.issues));
    } finally {
      harness.cleanup();
    }
  });

  it("replaces a rules array wholesale, keeping order and duplicates", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"], quick: ["beta/code"] },
        rules: [{ pattern: "old-work", model: "general" }],
      });
      const rules = [
        { pattern: "second", model: "quick" },
        { pattern: "first", model: "general" },
        { pattern: "second", model: "quick" },
      ];

      const { details } = await checkedCandidate(harness, { patch: { rules } });

      assert.deepEqual(details.nextSource?.rules, rules);
      assert.equal((details.nextSource?.rules as unknown[] | undefined)?.length, 3, "the old rule is not carried into the replacement");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps warnings, probe scope, write eligibility, and digests with many nested changes", async () => {
    const harness = freshHarness({
      providerAuthStatus: () => ({ configured: true, source: "stored" }),
      providerAuthResult: (provider) => provider === "alpha"
        ? new Error("stored credential could not be refreshed")
        : { auth: { apiKey: "resolved-value-not-reported" } },
    });
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
      });
      const bulk = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`bulk${index}`, ["beta/code"]]));

      const result = await harness.run({ operation: "check", patch: { models: bulk } });
      const details = detailsOf<ConfigAgentCheckResult>(result);
      const text = contentOf(result);

      assert.equal(details.status, "ok", JSON.stringify(details.issues));
      assert.ok(details.nestedChanges.length > 40, `fixture must exceed the change budget: ${details.nestedChanges.length}`);
      assert.match(text, /more change\(s\) omitted/, "the report counts what it omitted");
      assert.match(text, /warnings:/, "a warning survives a long change list");
      assert.match(text, /live probe not run: \d+ model\(s\)/, "the probe scope survives");
      assert.match(text, /write eligible: true/, "write eligibility survives");
      assert.match(text, /proposalDigest: [0-9a-f]{64}/, "the apply digests survive");
      assert.match(text, /Session-local proposalHandle: [0-9a-f]{12}/, "the proposal handle survives");
      const report = text.split("\nSession-local proposalHandle:")[0]!;
      assert.ok(report.split("\n").length <= 120, `the report stays bounded: ${report.split("\n").length} lines`);
    } finally {
      harness.cleanup();
    }
  });

  it("bounds the report when warnings and probe failures are numerous", async () => {
    const dead = Array.from({ length: 24 }, (_, index) => makeModel("dead", `m${index}`, 1, 1, 8_000));
    const live = Array.from({ length: 12 }, (_, index) => makeModel("live", `m${index}`, 1, 1, 8_000));
    const harness = freshHarness({
      available: [...dead, ...live],
      // Every dead provider refuses its sign-in, so each tier warns once.
      providerAuthResult: (provider) => provider === "dead" ? new Error("refresh failed") : { auth: { apiKey: "resolved" } },
      probeModels: (models) => models.map((model) => ({ model, status: "error" as const, reason: "down" })),
    });
    try {
      const models: Record<string, string[]> = {};
      for (let index = 0; index < dead.length; index++) models[`tier${index}`] = [`dead/m${index}`];
      models.live = live.map((model) => `${model.provider}/${model.id}`);
      const candidate = { schemaVersion: 2, default: "tier0", models };

      const result = await harness.run({ operation: "check", candidate, probe: true });
      const details = detailsOf<ConfigAgentCheckResult>(result);
      const warnings = details.issues.filter((issue) => issue.severity === "warning");
      const failed = (details.liveProbe ?? []).filter((entry) => entry.status === "error");
      assert.ok(warnings.length > 12, `fixture must exceed the warning budget: ${warnings.length}`);
      assert.ok(failed.length > 8, `fixture must exceed the probe-failure budget: ${failed.length}`);

      const report = contentOf(result).split("\nSession-local proposalHandle:")[0]!;
      const lines = report.split("\n");
      assert.ok(lines.length <= 120, `the report stays bounded: ${lines.length} lines`);
      assert.match(report, /warnings:/);
      assert.match(report, /more warning\(s\) omitted/);
      assert.match(report, /more failed probe\(s\) omitted/);
      assert.match(report, /write eligible: true/);
      assert.match(report, /proposalDigest: [0-9a-f]{64}/);
    } finally {
      harness.cleanup();
    }
  });

  it("renders unambiguous paths for keys with dots, slashes, and control characters", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
      });
      const patch = {
        models: {
          "gpt.4": ["beta/code"],
          "a/b~c": ["gamma/review"],
          "line\nbreak": ["beta/code"],
          // Same characters, different key: a literal backslash-u-0-0-0-a.
          "line\\u000abreak": ["beta/code"],
        },
      };

      const { details, result } = await checkedCandidate(harness, { patch });
      const fields = details.nestedChanges.map((change) => change.field).sort();

      // Paths stay unique: the newline is stored as itself, not encoded to the
      // same text as the literal escape.
      assert.deepEqual(fields, ["/models/a~1b~0c", "/models/gpt.4", "/models/line\nbreak", "/models/line\\u000abreak"]);
      const report = contentOf(result);
      assert.match(report, /add \/models\/gpt\.4: /);
      assert.match(report, /add \/models\/a~1b~0c: /);
      // Display escapes both, so the two keys remain distinguishable on one line.
      assert.match(report, /add \/models\/line\\u000abreak: /);
      assert.match(report, /add \/models\/line\\\\u000abreak: /);

      await harness.run(applyParams(details, { patch }));
      const dialog = harness.confirmations()[0]?.details ?? "";
      assert.match(dialog, /add "\/models\/gpt\.4"/);
      assert.match(dialog, /add "\/models\/a~1b~0c"/);
      // JSON renders the newline as \n and the literal escape as \\u000a.
      assert.match(dialog, /add "\/models\/line\\nbreak"/);
      assert.match(dialog, /add "\/models\/line\\\\u000abreak"/);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a patch that exceeds the nesting limit", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "general",
        models: { general: ["alpha/strong"] },
      });

      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 140; i++) deep = { nested: deep };
      const result = await harness.run({ operation: "check", patch: { deep } });
      const details = detailsOf<ConfigAgentCheckResult>(result);

      assert.equal(details.status, "usage");
      assert.match(details.notes.join(" "), /nesting depth/);
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

  it("shows complete large changes for approval and rejects proposals beyond the review bound", async () => {
    const harness = freshHarness();
    try {
      const visible = { ...candidate, description: "x".repeat(130) + "visible-end" };
      const checked = await checkedCandidate(harness, { candidate: visible });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(checked.details, { candidate: visible })));
      assert.equal(applied.status, "ok");
      assert.match(harness.confirmations()[0]?.details ?? "", /visible-end/);
      const large = { ...candidate, description: "y".repeat(5_000) + "visible-end" };
      const largeCheck = await checkedCandidate(harness, { candidate: large });
      const largeApplied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(largeCheck.details, { candidate: large })));
      assert.equal(largeApplied.status, "ok");
      assert.match(harness.confirmations()[1]?.details ?? "", /visible-end/);

      const tooLarge = { ...candidate, description: "z".repeat(2_000_000) + "hidden-end" };
      const boundedCheck = await checkedCandidate(harness, { candidate: tooLarge });
      const rejected = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(boundedCheck.details, { candidate: tooLarge })));
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.applied, false);
      assert.equal(harness.confirmations().length, 2);
      assert.doesNotMatch(harness.readFile(".pi/bifrost.json") ?? "", /hidden-end/);
    } finally { harness.cleanup(); }
  });

  it("summarizes classifier, rule, model-pool, and fallback changes from the checked candidate", async () => {
    const harness = freshHarness();
    try {
      const originalRules = [
        { pattern: "\\\\breview\\\\b", model: "review" },
        { pattern: "\\\\bplanning\\\\b", model: "work" },
      ];
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code", "alpha/strong"], review: ["gamma/review"] },
        classifier: { enabled: true },
        rules: originalRules,
        tierPolicies: { work: { fallbackTiers: ["review"] } },
      });
      const candidate = {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        classifier: { enabled: false },
        rules: [originalRules[0]],
        tierPolicies: { work: { fallbackTiers: [] } },
      };
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      const summary = harness.confirmations()[0]!.summary;
      assert.match(summary, /TOOL-GENERATED SUMMARY/);
      assert.match(summary, /Classifier policy: ON → OFF in source and effective config/);
      assert.doesNotMatch(summary, /classification disabled/);
      assert.doesNotMatch(summary, /Current classifier runtime:/);
      assert.match(summary, /Rules: source 2 → 1; effective 2 → 1; 1 removed, 0 added/);
      assert.match(summary, /Model pools: 1 tier/);
      assert.match(summary, /Fallbacks: 1 tier/);
      assert.doesNotMatch(summary, /\\\\b|"pattern"|"model"|beta\/code|alpha\/strong|gamma\/review/);
      assert.ok(summary.length < 1_400, `impact summary should stay concise, got ${summary.length} chars`);
    } finally { harness.cleanup(); }
  });

  it("reports classifier enablement without a contradictory disabled claim", async () => {
    const harness = freshHarness();
    try {
      const original = {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"] },
        classifier: { enabled: false },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const candidate = { ...original, classifier: { enabled: true } };
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      const summary = harness.confirmations()[0]!.summary;
      assert.match(summary, /Classifier policy: OFF → ON in source and effective config/);
      assert.doesNotMatch(summary, /classification disabled/);
    } finally { harness.cleanup(); }
  });

  it("reports first-match rule reorder and duplicate multiplicity changes", async () => {
    const harness = freshHarness();
    try {
      const originalRules = [
        { pattern: "review", model: "work" },
        { pattern: "review", model: "review" },
      ];
      const original = {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        classifier: { enabled: false },
        rules: originalRules,
      };
      harness.writeFile(".pi/bifrost.json", original);
      const candidate = { ...original, rules: [...originalRules].reverse() };
      assert.equal(classifyCompiled("review this", compileRules(originalRules)), "work");
      assert.equal(classifyCompiled("review this", compileRules(candidate.rules)), "review");
      const checked = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(checked.details, { candidate })));
      assert.equal(applied.status, "ok");
      const reordered = harness.confirmations()[0]!.summary;
      assert.match(reordered, /0 removed, 0 added; first-match priority order changed — inspect Details/);

      const duplicate = { ...original, rules: [originalRules[0], originalRules[0], originalRules[1]] };
      const withoutDuplicate = { ...duplicate, rules: [originalRules[0], originalRules[1]] };
      harness.writeFile(".pi/bifrost.json", duplicate);
      const duplicateCheck = await checkedCandidate(harness, { candidate: withoutDuplicate });
      const duplicateApply = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(duplicateCheck.details, { candidate: withoutDuplicate })));
      assert.equal(duplicateApply.status, "ok");
      assert.match(harness.confirmations()[1]!.summary, /Rules: source 3 → 2; effective 3 → 2; 1 removed, 0 added/);
    } finally { harness.cleanup(); }
  });

  it("counts string model pools and treats description as a tier only before schema v3", async () => {
    const harness = freshHarness();
    try {
      const legacy = {
        schemaVersion: 2,
        default: "work",
        classifier: { enabled: false },
        models: { description: "beta/code", work: "alpha/strong" },
      };
      harness.writeFile(".pi/bifrost.json", legacy);
      const legacyCandidate = {
        ...legacy,
        models: { description: "gamma/review", work: "beta/code" },
      };
      const legacyCheck = await checkedCandidate(harness, { candidate: legacyCandidate });
      const legacyApply = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(legacyCheck.details, { candidate: legacyCandidate })));
      assert.equal(legacyApply.status, "ok");
      assert.match(harness.confirmations()[0]!.summary, /Model pools: 2 tiers \("description" 1 → 1; "work" 1 → 1\)/);

      const schemaV3 = {
        schemaVersion: 3,
        default: "work",
        classifier: { enabled: false },
        models: { description: "original metadata", work: "beta/code" },
      };
      harness.writeFile(".pi/bifrost.json", schemaV3);
      const schemaV3Candidate = { ...schemaV3, models: { description: "updated metadata", work: "beta/code" } };
      const v3Check = await checkedCandidate(harness, { candidate: schemaV3Candidate });
      const v3Apply = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(v3Check.details, { candidate: schemaV3Candidate })));
      assert.equal(v3Apply.status, "ok");
      assert.doesNotMatch(harness.confirmations()[1]!.summary, /Model pools|description/);
    } finally { harness.cleanup(); }
  });

  it("names every changed field before summary approval", async () => {
    const harness = freshHarness();
    try {
      const original = {
        schemaVersion: 2,
        enabled: true,
        default: "work",
        strategy: "first",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        rules: [{ pattern: "work", model: "work" }],
        routingScope: { providers: ["beta"] },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const candidate = {
        ...original,
        enabled: false,
        default: "review",
        strategy: "cheapest",
        models: { ...original.models, docs: ["alpha/strong"] },
        rules: [{ pattern: "review", model: "review" }],
        routingScope: { providers: ["gamma", "alpha"] },
      };
      const checked = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(checked.details, { candidate })));
      assert.equal(applied.status, "ok");
      const summary = harness.confirmations()[0]!.summary;
      for (const field of ["default", "enabled", "models", "rules", "routingScope", "strategy"]) {
        assert.ok(summary.includes(`"${field}"`), `summary omits changed field ${field}: ${summary}`);
      }
      assert.doesNotMatch(summary, /\+\d+ more/);
    } finally { harness.cleanup(); }
  });

  it("retains existing tiers, rules, classifier, and fallbacks when adding a tier", async () => {
    const harness = freshHarness();
    try {
      const original = {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        classifier: { enabled: true, criteria: { work: "existing criteria" } },
        rules: [{ pattern: "existing-work-rule", model: "work" }],
        tierPolicies: { work: { fallbackTiers: ["review"] } },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const candidate = {
        ...original,
        models: { ...original.models, docs: ["alpha/strong"] },
      };
      const { details } = await checkedCandidate(harness, { candidate });
      assert.deepEqual(details.nextSource, candidate);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      assert.deepEqual(JSON.parse(harness.readFile(".pi/bifrost.json") ?? "{}"), candidate);
      const summary = harness.confirmations()[0]!.summary;
      assert.match(summary, /Model pools: 1 tier/);
      assert.doesNotMatch(summary, /Classifier|Rules:|Fallbacks:/);
    } finally { harness.cleanup(); }
  });

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
      assert.ok(applied.notes.some((note) => /Pi does not expose an extension API to open saved files/.test(note)));
      assert.equal(harness.reloadCalls(), 1);
      const appliedTiers = new Map(applied.routing?.tiers.map((tier) => [tier.tier, tier]));
      assert.deepEqual(appliedTiers.get("fast")?.pool, ["beta/code"]);
      assert.deepEqual(appliedTiers.get("deep")?.pool, ["alpha/strong"]);

      const confirmations = harness.confirmations();
      assert.equal(confirmations.length, 1);
      assert.equal(confirmations[0]?.title, "Apply this Bifrost configuration?");
      assert.match(confirmations[0]?.details ?? "", /Source: project/);
      assert.match(confirmations[0]?.details ?? "", /add "\/models\/deep"/);
      assert.match(confirmations[0]?.details ?? "", /"deep" \("first"\): \["alpha\/strong"\]/);
      assert.match(confirmations[0]?.details ?? "", /No other config source is modified/);

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

  it("refuses RPC apply but keeps check and preview available", async () => {
    const harness = freshHarness({ mode: "rpc" });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      assert.equal(details.status, "ok");
      const preview = detailsOf<ConfigAgentPreviewResult>(await harness.run({ operation: "preview", candidate }));
      assert.equal(preview.status, "ok");
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "approval_required");
      assert.equal(applied.applied, false);
      assert.equal(harness.confirmations().length, 0);
      assert.equal(harness.reloadCalls(), 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally { harness.cleanup(); }
  });

  it("reports cancellation and writes nothing when approval is aborted before or during review", async () => {
    for (const timing of ["before", "during"]) {
      const abort = new AbortController();
      const harness = freshHarness({ signal: abort.signal, confirmHook: () => abort.abort() });
      try {
        const { details } = await checkedCandidate(harness, { candidate });
        if (timing === "before") abort.abort();
        const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
        assert.equal(applied.status, "cancelled");
        assert.equal(harness.reloadCalls(), 0);
        assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
      } finally { harness.cleanup(); }
    }
  });

  it("reports approval failure and writes nothing when custom approval fails", async () => {
    const harness = freshHarness({ uiError: true });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "approval_failed");
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally { harness.cleanup(); }
  });

  it("shows exact whitespace and control values as reversible ASCII JSON", async () => {
    const harness = freshHarness();
    try {
      const description = " leading  space\t\n\r\x1b[2J\u202e\u200b界😀 trailing ";
      const value = { ...candidate, description };
      const { details } = await checkedCandidate(harness, { candidate: value });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate: value })));
      assert.equal(applied.status, "ok");
      const message = harness.confirmations()[0]!.details;
      assert.doesNotMatch(message, /[^\x20-\x7e\n]/);
      const prefix = '  "/description": ';
      const line = message.split("\n").find((row) => row.startsWith(prefix))!;
      assert.equal(JSON.parse(line.slice(prefix.length)), description);
      assert.match(line, /\\u0020/);
      assert.equal(JSON.parse(harness.readFile(".pi/bifrost.json")!).description, description);
    } finally { harness.cleanup(); }
  });

  it("reports user cancellation and writes nothing when the user declines", async () => {
    const harness = freshHarness({ confirm: false });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "cancelled");
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

  it("applies the first configuration to an absent source using the rendered digest", async () => {
    const harness = freshHarness();
    try {
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined, "a fresh project has no source yet");
      const { details } = await checkedCandidate(harness, { candidate });
      assert.equal(details.guards!.sourceDigest, null, "an absent source has no digest");
      // A real agent can only copy the digest string the rendered report prints
      // ("absent"): the tool schema accepts strings, never null.
      const renderedSourceDigest = details.guards!.sourceDigest ?? "absent";
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({
        ...applyParams(details, { candidate }),
        sourceDigest: renderedSourceDigest,
      }));
      assert.equal(applied.status, "ok", applied.reason ?? "");
      assert.equal(applied.applied, true);
      const stored = JSON.parse(harness.readFile(".pi/bifrost.json") ?? "{}") as Record<string, unknown>;
      assert.deepEqual(stored, details.nextSource);

      // Once the source exists, the same literal "absent" must still be stale.
      const second = await checkedCandidate(harness, { candidate: { ...candidate, default: "deep" } });
      assert.ok(second.details.guards!.sourceDigest, "an existing source has a real digest");
      const replayed = detailsOf<ConfigAgentApplyResult>(await harness.run({
        ...applyParams(second.details, { candidate: { ...candidate, default: "deep" } }),
        sourceDigest: "absent",
      }));
      assert.equal(replayed.status, "stale");
      assert.match(replayed.reason ?? "", /selected source changed/);
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

describe("order, pause labeling, and inventory pagination", () => {
  it("keeps registry order for preview routing and sorts only the displayed inventory", async () => {
    const harness = freshHarness({
      available: [
        makeModel("test", "z9", 1, 2, 100_000),
        makeModel("test", "a1", 1, 2, 100_000),
      ],
    });
    try {
      const previewDetails = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: { schemaVersion: 2, default: "work", models: { work: ["test"] } },
      }));
      const work = previewDetails.tiers.find((tier) => tier.tier === "work");
      assert.equal(work?.selected, "test/z9", "first must resolve in Pi's registry order like live routing");

      const inspectDetails = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.deepEqual(
        inspectDetails.inventory.map((model) => model.key),
        ["test/a1", "test/z9"],
        "the displayed inventory sorts for reading",
      );
    } finally {
      harness.cleanup();
    }
  });

  it("labels preview results as assuming no paused models", async () => {
    const harness = freshHarness();
    try {
      const previewResult = await harness.run({
        operation: "preview",
        candidate: { schemaVersion: 2, default: "work", models: { work: ["beta/code"], deep: ["alpha/strong"] } },
      });
      const previewDetails = detailsOf<ConfigAgentPreviewResult>(previewResult);
      assert.equal(previewDetails.status, "ok");
      assert.ok(
        previewDetails.notes.some((note) => /circuit|paused/i.test(note)),
        "the result notes must state the pause assumption",
      );
      assert.match(contentOf(previewResult), /assumes healthy/, "the report must state the pause assumption");
    } finally {
      harness.cleanup();
    }
  });

  it("pages the inspect inventory past the report cap", async () => {
    const harness = freshHarness({
      available: Array.from({ length: 45 }, (_, index) => makeModel("bulk", `m${String(index).padStart(2, "0")}`, 1, 2, 100_000)),
    });
    try {
      const page1 = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(page1.inventory.length, 45, "the result keeps the full list; only the report caps it");

      const page1Text = contentOf(await harness.run({ operation: "inspect" }));
      assert.match(page1Text, /"offset": 40/, "the report tells the agent how to see the rest");

      const page2 = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect", offset: 40 }));
      assert.equal(page2.inventoryOffset, 40);
      assert.equal(page2.inventory.length, 5);
      assert.equal(page2.inventory[0]?.key, "bulk/m40");

      const filtered = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect", provider: "bulk", offset: 40 }));
      assert.equal(filtered.inventory.length, 5);
    } finally {
      harness.cleanup();
    }
  });
});

describe("tool surface", () => {
  it("previews current configuration and applies a checked handle without copying digests", async () => {
    const harness = freshHarness();
    try {
      const preview = detailsOf<ConfigAgentPreviewResult>(await harness.run({ operation: "preview", prompts: ["hello"] }));
      assert.equal(preview.status, "blocked");
      assert.equal(preview.proposalDigest, null);
      const checked = await harness.run({ operation: "check", patch: { default: "quick", models: { quick: ["beta/code"] } } });
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", proposalHandle: handle }));
      assert.equal(applied.status, "ok");
      assert.equal(applied.applied, true);
    } finally { harness.cleanup(); }
  });

  it("retains the last successful handle after a failed check", async () => {
    const harness = freshHarness({ confirm: false });
    try {
      const checked = await harness.run({ operation: "check", patch: { default: "quick", models: { quick: ["beta/code"] } } });
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle);
      const invalid = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: { classifier: { criteria: 42 } } }));
      assert.equal(invalid.status, "rejected");
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", proposalHandle: handle }));
      assert.equal(applied.status, "cancelled");
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally { harness.cleanup(); }
  });

  it("rejects handles across session replacement and with extra candidate fields", async () => {
    const harness = freshHarness();
    try {
      const checked = await harness.run({ operation: "check", source: "workspace", patch: { default: "quick", models: { quick: ["beta/code"] } } });
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle);
      const extra = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", proposalHandle: handle, patch: { default: "general" } }));
      assert.equal(extra.status, "usage");
      harness.setSessionId("other-session");
      const rejected = await harness.run({ operation: "apply", proposalHandle: handle });
      const other = detailsOf<ConfigAgentApplyResult>(rejected);
      assert.equal(other.status, "usage");
      assert.equal(other.source, null);
      assert.doesNotMatch(contentOf(rejected), /source:/);
      assert.equal(harness.confirmations().length, 0);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
    } finally { harness.cleanup(); }
  });

  it("rejects a stale handle without writing", async () => {
    const harness = freshHarness();
    try {
      const checked = await harness.run({ operation: "check", patch: { default: "quick", models: { quick: ["beta/code"] } } });
      const handle = contentOf(checked).match(/proposalHandle: ([a-f0-9]{12})/)?.[1];
      assert.ok(handle);
      harness.writeFile(".pi/bifrost.json", { default: "general" });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run({ operation: "apply", proposalHandle: handle }));
      assert.equal(applied.status, "stale");
      assert.match(harness.readFile(".pi/bifrost.json")!, /general/);
      assert.equal(harness.confirmations().length, 0);
    } finally { harness.cleanup(); }
  });

  it("exposes one cohesive tool with a stable name", () => {
    const harness = freshHarness();
    try {
      assert.equal(harness.tool.name, BIFROST_CONFIG_TOOL_NAME);
      assert.equal(harness.tool.name, "bifrost_config");
      assert.match(harness.tool.description, /Inspect and safely change Bifrost's routing configuration/);
      assert.ok(harness.tool.promptSnippet);
      const properties = (harness.tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      assert.deepEqual(Object.keys(properties).sort(), [
        "candidate", "catalogDigest", "classifierRuntimeDigest", "effectiveDigest", "offset", "operation", "patch",
        "probe", "prompts", "proposalDigest", "proposalHandle", "provider", "remove", "source", "sourceDigest",
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

describe("confirmation-window races and preview fidelity", () => {
  const candidate = {
    schemaVersion: 2 as const,
    default: "fast",
    models: { fast: ["beta/code"], deep: ["alpha/strong"] },
  };

  it("rejects the write when the selected source changes while approval is open", async () => {
    let hook: (() => void) | undefined = undefined;
    const harness = freshHarness({ confirmHook: () => hook?.() });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      // A concurrent edit (another agent, another session) lands while the
      // approval dialog is open; approval must not overwrite it.
      hook = () => harness.writeFile(".pi/bifrost.json", { default: "edited", models: { edited: ["gamma/review"] } });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /selected source changed/);
      assert.match(harness.readFile(".pi/bifrost.json") ?? "", /edited/, "the newer edit must survive");
      assert.equal(harness.reloadCalls(), 0);
      assert.equal(harness.confirmations().length, 1);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects the write when another layer changes while approval is open", async () => {
    let hook: (() => void) | undefined = undefined;
    const harness = freshHarness({ confirmHook: () => hook?.() });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      // The merged configuration is part of the reviewed proposal: an edit in
      // an unrelated layer while the dialog is open must stop the write.
      hook = () => harness.writeFile("bifrost.json", { default: "moved", models: { moved: ["alpha/strong"] } });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /another configuration source changed/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects the write when a masked layer changes while approval is open", async () => {
    let hook: (() => void) | undefined = undefined;
    const harness = freshHarness({ confirmHook: () => hook?.() });
    try {
      // The workspace default is masked by the project default, so no merged
      // digest can show a workspace edit. Removing the project default is
      // exactly what exposes the workspace value.
      harness.writeFile("bifrost.json", {
        schemaVersion: 2,
        default: "frontier",
        models: { frontier: ["alpha/strong"], quick: ["alpha/strong"] },
      });
      harness.writeFile(".pi/bifrost.json", { schemaVersion: 2, default: "general", models: { general: ["beta/code"] } });
      const candidate = { schemaVersion: 2, models: { general: ["beta/code"] } };
      const { details } = await checkedCandidate(harness, { candidate });
      const approved = details.effectiveAfter?.default;
      assert.equal(approved, "frontier", "the approved result comes from the masked workspace layer");
      hook = () => harness.writeFile("bifrost.json", {
        schemaVersion: 2,
        default: "quick",
        models: { frontier: ["alpha/strong"], quick: ["alpha/strong"] },
      });
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /compose/);
      assert.match(harness.readFile(".pi/bifrost.json") ?? "", /general/, "the approved source is untouched");
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects the write when the model inventory changes while approval is open", async () => {
    let hook: (() => void) | undefined = undefined;
    const harness = freshHarness({ confirmHook: () => hook?.() });
    try {
      const { details } = await checkedCandidate(harness, { candidate });
      hook = () => harness.setAvailable([makeModel("beta", "code", 0.5, 1.5, 128_000)]);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "stale");
      assert.match(applied.reason ?? "", /model inventory changed/);
      assert.equal(harness.readFile(".pi/bifrost.json"), undefined);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("applies the candidate's billing preference in preview like active routing", async () => {
    const harness = freshHarness();
    try {
      // Pool ordered metered-first with a subscription preference: active
      // routing prefers the subscription scope, so preview must show the same.
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "work",
          models: { work: ["beta/code", "alpha/strong"] },
          classifier: { enabled: false },
          categoryStrategies: { work: "first" },
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
      const work = details.tiers.find((tier) => tier.tier === "work");
      assert.equal(work?.selected, "alpha/strong", "preview must honor the subscription preference like active routing");
    } finally {
      harness.cleanup();
    }
  });

  it("applies the bifrost-routes.json rule override in preview like active routing", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile("bifrost-routes.json", [{ pattern: "special", model: "quick" }]);
      const details = detailsOf<ConfigAgentPreviewResult>(await harness.run({
        operation: "preview",
        prompts: ["special"],
        candidate: {
          schemaVersion: 2,
          default: "deep",
          models: { deep: ["alpha/strong"], quick: ["beta/code"] },
          classifier: { enabled: false },
        },
      }));
      const decided = details.cases.find((entry) => entry.prompt === "special");
      assert.equal(decided?.selectedTier, "quick", "the route file must decide the tier in preview like active routing");
    } finally {
      harness.cleanup();
    }
  });

  it("shows the changed values in the approval dialog and the check report", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        tierPolicies: { work: { fallbackTiers: ["review"] } },
      });
      const candidate = {
        schemaVersion: 2,
        default: "work",
        models: { work: ["beta/code"], review: ["gamma/review"] },
        tierPolicies: { work: { fallbackTiers: [] } },
      };
      const { details, result } = await checkedCandidate(harness, { candidate });
      // The report is the way to inspect anything beyond the dialog limit.
      const reportBeforeApply = contentOf(result);
      const applied = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { candidate })));
      assert.equal(applied.status, "ok");
      const dialog = harness.confirmations()[0]?.details ?? "";
      assert.match(dialog, /replace "\/tierPolicies\/work\/fallbackTiers"/, "the change kind and field stay");
      assert.match(dialog, /fallbackTiers/, "the changed value path is visible");
      assert.match(dialog, /"review"/, "the value the user approved away is visible");
      assert.match(dialog, /->/, "before and after are separated");
      assert.match(reportBeforeApply, /fallbackTiers/, "the report shows the changed values");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps the apply digests when a long report is truncated", async () => {
    const harness = freshHarness();
    try {
      const manyUnknown = Array.from({ length: 140 }, (_, index) => `zeta/no-model-${index}`);
      const candidate = { schemaVersion: 2, default: "work", models: { work: manyUnknown } };
      const checkText = contentOf(await harness.run({ operation: "check", candidate }));
      assert.match(checkText, /more line\(s\)/, "the body is truncated");
      assert.match(checkText, /proposalDigest: [0-9a-f]{12}/, "the proposal digest survives truncation");
      assert.match(checkText, /catalogDigest: [0-9a-f]{12}/, "the catalog digest survives truncation");
      const previewText = contentOf(await harness.run({ operation: "preview", candidate }));
      assert.match(previewText, /proposalDigest: [0-9a-f]{12}/);
      assert.match(previewText, /catalogDigest: [0-9a-f]{12}/);
    } finally {
      harness.cleanup();
    }
  });
});

describe("structural findings reach the agent", () => {
  // Boot and reload print the findings the domain validators own. The tool is
  // the surface an agent reads, so it must report them too instead of showing a
  // clean configuration that the CLI would warn about.
  it("reports load warnings from inspect and check without vetoing the write", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "a",
        models: { a: ["alpha/strong"] },
        tierPolicies: { a: { fallbackTiers: [] } },
        unsupportedField: 1,
      });
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.ok(inspected.issues.some((issue) => issue.severity === "warning"
        && /Unsupported configuration field "unsupportedField"/.test(issue.message)), JSON.stringify(inspected.issues));
      assert.match(contentOf(await harness.run({ operation: "inspect" })), /Unsupported configuration field/);

      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: { strategy: "cheapest" } }));
      assert.equal(checked.status, "ok", checked.issues.map((issue) => issue.message).join("; "));
      assert.equal(checked.writeEligible, true, "a structural warning must not veto the write");
      assert.ok(checked.issues.some((issue) => issue.severity === "warning"
        && /Unsupported configuration field "unsupportedField"/.test(issue.message)), JSON.stringify(checked.issues));
      assert.ok(checked.diagnostics.every((diagnostic) => !/Unsupported configuration field/.test(diagnostic.message)),
        "a warnable finding is not a layer-rejecting diagnostic");
      const checkText = contentOf(await harness.run({ operation: "check", patch: { strategy: "cheapest" } }));
      assert.match(checkText, /warnings:/, "check renders the warnings it reports");
    } finally {
      harness.cleanup();
    }
  });

  it("renders warnings and errors in candidate previews", async () => {
    const harness = freshHarness();
    try {
      harness.writeFile(".pi/bifrost.json", { schemaVersion: 2, default: "a", models: { a: ["alpha/strong"] }, unsupportedField: 1 });
      const warning = contentOf(await harness.run({ operation: "preview", patch: { strategy: "cheapest" } }));
      assert.match(warning, /warning:.*Unsupported configuration field "unsupportedField"/u);
      const rejected = contentOf(await harness.run({ operation: "preview", candidate: { schemaVersion: 99 } }));
      assert.match(rejected, /error:.*schemaVersion/u);
    } finally {
      harness.cleanup();
    }
  });

  it("names every supported schema version and accepts a version-3 source", async () => {
    const harness = freshHarness();
    try {
      const restriction = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }))
        .restrictions.find((entry) => /schema versions/.test(entry));
      assert.ok(restriction, "inspect must state which schema versions it validates");
      // Pins the text to the constant: adding a version without naming it fails here.
      assert.match(restriction!, new RegExp(`schema versions ${SUPPORTED_SCHEMA_VERSIONS.join(", ")};`));
      assert.doesNotMatch(restriction!, /\b1 and 2\b/);

      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 3,
        description: "project policy",
        default: "a",
        models: { description: "tier metadata", a: ["alpha/strong"] },
        tierPolicies: { a: { fallbackTiers: [] } },
      });
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(inspected.routing.schemaVersion, 3);
      assert.ok(inspected.issues.every((issue) => !/unsupported schemaVersion/i.test(issue.message)), JSON.stringify(inspected.issues));
      const tiers = inspected.routing.tiers.map((tier) => tier.tier);
      assert.equal(tiers.includes("a"), true, "the authored tier survives");
      assert.equal(tiers.includes("description"), false,
        "the reserved description key never becomes a tier");
    } finally {
      harness.cleanup();
    }
  });
});

describe("effective classifier runtime in the agent tool", () => {
  it("reports config-off over legacy-on and validates only criteria shape while disabled", async () => {
    const harness = freshHarness({ runtimeAware: true, legacyClassifierEnabled: true });
    try {
      harness.writeFile(".pi/bifrost.json", {
        schemaVersion: 2,
        default: "custom",
        models: { custom: ["beta/code"] },
        classifier: { enabled: false, backend: "typesafe" },
      });
      const inspect = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(inspect.routing.classifier.enabled, false);
      assert.equal(inspect.routing.classifier.configuredEnabled, false);
      assert.equal(inspect.routing.classifier.source, "legacy-conflict");
      assert.equal(inspect.routing.classifier.backend, "typesafe");
      assert.deepEqual(inspect.routing.classifier.legacyConflict, { saved: true, configured: false });
      assert.equal(inspect.routing.classifier.projected?.enabled, false);
      assert.equal(inspect.routing.classifier.loadedConfigMatches, true);

      const checkedResult = await harness.run({ operation: "check", patch: { strategy: "cheapest" } });
      const checked = detailsOf<ConfigAgentCheckResult>(checkedResult);
      assert.equal(checked.status, "ok", checked.issues.map((issue) => issue.message).join("; "));
      assert.equal(checked.issues.some((issue) => /criteria missing/u.test(issue.message)), false);
      assert.match(contentOf(checkedResult), /classifier runtime now: disabled \(legacy-conflict\).*configured=off; backend=typesafe/);
      assert.match(contentOf(checkedResult), /configured false overrides legacy classifierEnabled=true/);
      assert.doesNotMatch(contentOf(checkedResult), /Classifier is paused/u);

      const malformed = detailsOf<ConfigAgentCheckResult>(await harness.run({
        operation: "check",
        patch: { classifier: { enabled: false, backend: "typesafe", criteria: { custom: 42 } } },
      }));
      assert.equal(malformed.status, "rejected");
      assert.ok(malformed.issues.some((issue) => /criterion for tier "custom"/u.test(issue.message)));
      assert.equal(harness.classifyCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects malformed TypeSafe criteria aliases in classifier patches", async () => {
    const harness = freshHarness();
    try {
      const original = {
        schemaVersion: 2,
        default: "custom",
        models: { custom: ["beta/code"] },
        classifier: { enabled: false, backend: "typesafe" },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const invalid = [
        { enabled: false, backend: "typesafe", criteria: "TypeSafe" },
        { enabled: false, backend: "typesafe", criteria: { custom: { type: "TypeSafe" } } },
        { enabled: false, backend: "typesafe", criteria: { custom: { kind: "TypeSafe" } } },
        { enabled: false, backend: "typesafe", criteria: { custom: "valid natural-language criterion" }, type: "TypeSafe" },
      ];
      for (const classifier of invalid) {
        const result = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: { classifier } }));
        assert.equal(result.status, "rejected", JSON.stringify(result.issues));
        assert.ok(result.issues.some((issue) => issue.severity === "error"));
      }
      assert.deepEqual(JSON.parse(harness.readFile(".pi/bifrost.json") ?? "null"), original);
      assert.equal(harness.classifyCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("invalidates approval when legacy classifier state changes while dialog is open", async () => {
    let harness: Harness;
    harness = freshHarness({
      runtimeAware: true,
      legacyClassifierEnabled: false,
      confirmHook: () => harness.setLegacyClassifierEnabled(true),
    });
    try {
      const original = {
        schemaVersion: 2,
        default: "custom",
        models: { custom: ["beta/code"] },
        classifier: { enabled: true, backend: "prompt", criteria: { custom: "bounded implementation" } },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const patch = { strategy: "cheapest" };
      const { details } = await checkedCandidate(harness, { patch });
      assert.equal(details.routingAfter?.classifier.enabled, false);
      assert.equal(details.routingAfter?.classifier.source, "legacy-conflict");
      assert.ok(details.guards?.classifierRuntimeDigest);

      const result = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { patch })));
      assert.equal(result.status, "stale");
      assert.match(result.reason ?? "", /classifier runtime state changed while/u);
      assert.match(harness.confirmations()[0]?.summary ?? "", /Current classifier runtime: disabled \(legacy-conflict; backend=prompt\)/);
      assert.deepEqual(JSON.parse(harness.readFile(".pi/bifrost.json") ?? "null"), original);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a stale classifier runtime digest before opening approval", async () => {
    const harness = freshHarness({ runtimeAware: true, legacyClassifierEnabled: false });
    try {
      const original = {
        schemaVersion: 2,
        default: "custom",
        models: { custom: ["beta/code"] },
        classifier: { enabled: true, backend: "prompt", criteria: { custom: "bounded implementation" } },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const patch = { strategy: "cheapest" };
      const { details } = await checkedCandidate(harness, { patch });
      harness.setLegacyClassifierEnabled(true);
      const result = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { patch })));
      assert.equal(result.status, "stale");
      assert.match(result.reason ?? "", /classifier runtime digest does not match/u);
      assert.equal(harness.confirmations().length, 0);
      assert.deepEqual(JSON.parse(harness.readFile(".pi/bifrost.json") ?? "null"), original);
      assert.equal(harness.reloadCalls(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("separates loaded classifier runtime from disk projection and keeps actual state after rejected reload", async () => {
    const harness = freshHarness({ runtimeAware: true, loadedClassifierEnabled: true, reload: false });
    try {
      const original = {
        schemaVersion: 2,
        default: "custom",
        models: { custom: ["beta/code"] },
        classifier: { enabled: false, backend: "prompt", criteria: { custom: "bounded implementation" } },
      };
      harness.writeFile(".pi/bifrost.json", original);
      const inspected = detailsOf<ConfigAgentInspectResult>(await harness.run({ operation: "inspect" }));
      assert.equal(inspected.routing.classifier.enabled, true, "inspection reports active loaded runtime");
      assert.equal(inspected.routing.classifier.configuredEnabled, true);
      assert.equal(inspected.routing.classifier.projected?.enabled, false, "disk projection remains separate");
      assert.equal(inspected.routing.classifier.projected?.configuredEnabled, false);
      assert.equal(inspected.routing.classifier.loadedConfigMatches, false);
      assert.match(reportText(inspected), /loaded config differs from effective disk layers/);

      const patch = { strategy: "cheapest" };
      const { details } = await checkedCandidate(harness, { patch });
      assert.equal(details.routingBefore?.classifier.enabled, true);
      assert.equal(details.routingAfter?.classifier.enabled, true, "candidate check does not relabel current runtime");
      assert.equal(details.routingAfter?.classifier.projected?.enabled, false);
      assert.ok(details.notes.some((note) => /active loaded config differs/u.test(note)));
      const result = detailsOf<ConfigAgentApplyResult>(await harness.run(applyParams(details, { patch })));
      const summary = harness.confirmations()[0]?.summary;
      assert.equal(result.status, "reload_failed");
      assert.equal(result.routing?.classifier.enabled, true, "rejected reload leaves actual loaded runtime unchanged");
      assert.equal(result.routing?.classifier.projected?.enabled, false);
      assert.match(summary ?? "", /Current classifier runtime: enabled/);
      assert.match(summary ?? "", /Classifier runtime after apply and reload: disabled/);
      assert.doesNotMatch(summary ?? "", /classification disabled/);
    } finally { harness.cleanup(); }
  });

  it("explains invalid runtime state cannot be overridden by session enablement", async () => {
    const harness = freshHarness({ runtimeAware: true, runtimeStateIssue: "invalid-json", classifierSessionOverride: true });
    try {
      harness.writeFile(".pi/bifrost.json", { schemaVersion: 2, default: "custom", models: { custom: ["beta/code"] }, classifier: { enabled: false } });
      const checked = detailsOf<ConfigAgentCheckResult>(await harness.run({ operation: "check", patch: { strategy: "first" } }));
      assert.equal(checked.routingBefore?.classifier.enabled, false);
      assert.ok(checked.notes.some((note) => /fail.closed/i.test(note)));
      assert.ok(!checked.notes.some((note) => /unless.*explicitly enables/i.test(note)));
    } finally { harness.cleanup(); }
  });

  for (const enabled of [true, false]) {
    it(`previews classifier ${enabled ? "enable" : "disable"} using projected runtime`, async () => {
      const harness = freshHarness({ runtimeAware: true, loadedClassifierEnabled: !enabled });
      try {
        harness.writeFile(".pi/bifrost.json", {
          schemaVersion: 2, default: "custom", models: { custom: ["beta/code"] },
          classifier: { enabled: !enabled, backend: "prompt" },
        });
        const result = detailsOf<ConfigAgentPreviewResult>(await harness.run({
          operation: "preview", patch: { classifier: { enabled, backend: "prompt" } }, prompts: ["ordinary task"],
        }));
        assert.equal(result.status, "ok");
        assert.equal(result.routing?.classifier.enabled, !enabled);
        assert.equal(result.routing?.classifier.projected?.enabled, enabled);
        assert.equal(result.cases[0]?.confidence, enabled ? "classifier_dependent" : "deterministic");
      } finally { harness.cleanup(); }
    });
  }

  it("shows requested tier, selected fallback tier, and fallback reason in preview", async () => {
    const harness = freshHarness();
    try {
      const result = await harness.run({
        operation: "preview",
        candidate: {
          schemaVersion: 2,
          default: "general",
          models: { quick: [], general: ["beta/code"] },
          tierPolicies: { quick: { fallbackTiers: ["general"] } },
          classifier: { enabled: false },
        },
        prompts: ["quick review this code"],
      });
      const details = detailsOf<ConfigAgentPreviewResult>(result);
      const entry = details.cases[0];
      assert.equal(entry?.tier, "quick");
      assert.equal(entry?.selectedTier, "general");
      assert.equal(entry?.fallbackReason, "requested_tier_unavailable");
      const text = contentOf(result);
      assert.match(text, /requested=quick; selected=general => beta\/code/u);
      assert.match(text, /fallback: requested_tier_unavailable/u);
    } finally {
      harness.cleanup();
    }
  });
});

describe("resolveProviderAuth waits", () => {
  it("reports a slow resolution as unknown rather than a dead sign-in", async () => {
    // Pre-dispatch resolution may not outlast the caller's patience: a budget
    // that ends must not turn a slow refresh into an exclusion.
    const result = await resolveProviderAuth(
      { getProviderAuth: () => new Promise((resolve) => setTimeout(() => resolve({ auth: { apiKey: "late" } }), 50)) } as any,
      ["slow"],
      { timeoutMs: 5 },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].state, "unknown");
    assert.match(result[0].reason ?? "", /did not resolve within 5ms/);
  });

  it("bounds the whole resolution, not just each provider", async () => {
    // Sequential per-provider waits alone scale with configuration size: thirty
    // unresponsive providers would hold the turn for two minutes. The total
    // budget ends the wait, and every provider it did not reach stays `unknown`,
    // which never excludes.
    const providers = Array.from({ length: 6 }, (_, index) => `hang${index}`);
    const started = Date.now();
    let calls = 0;
    const result = await resolveProviderAuth(
      { getProviderAuthStatus: () => ({ configured: true }), getProviderAuth: () => { calls += 1; return new Promise(() => {}); } } as any,
      providers,
      { timeoutMs: 40, totalBudgetMs: 100 },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.length, providers.length);
    assert.ok(elapsed < 400, `resolution must stop at the total budget, took ${elapsed}ms`);
    assert.ok(calls < providers.length, `the budget must stop asking, asked ${calls} times`);
    assert.deepEqual(result.map((entry) => entry.state), providers.map(() => "unknown"));
    assert.match(result.at(-1)?.reason ?? "", /reached its 100ms budget before this provider was checked/);
  });

  it("observes an auth rejection when the resolver aborts synchronously", async () => {
    const controller = new AbortController();
    const result = await resolveProviderAuth({
      getProviderAuth: () => {
        controller.abort();
        return Promise.reject(new Error("fixture auth rejection"));
      },
    } as any, ["alpha"], { signal: controller.signal });
    assert.equal(result[0]?.state, "unknown");
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("stops asking after the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await resolveProviderAuth(
      { getProviderAuth: async () => { calls += 1; return null; } } as any,
      ["alpha"],
      { signal: controller.signal },
    );
    assert.equal(calls, 0);
    assert.equal(result[0].state, "unknown");
    assert.match(result[0].reason ?? "", /cancelled before sign-in could be resolved/);
  });
});
