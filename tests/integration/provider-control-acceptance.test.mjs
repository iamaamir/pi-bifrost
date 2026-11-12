import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { ProviderCooldownStore } from "../../provider-cooldowns.ts";
import { ReliabilityV2Store } from "../../reliability-v2-store.ts";
import { createProviderCooldownStore, providerReliabilityPath, reliabilityV2Config } from "../../runtime-reliability-v2.ts";
import { runControlledFault } from "../fixtures/controlled-source-fault.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const EXTENSION = join(ROOT, "index.ts");
const FAKE_SERVER = join(ROOT, "scripts", "fake-provider-server.mjs");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");
let fakePort;
let server;

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
    child.once("close", () => { clearTimeout(force); resolve(); });
    child.kill("SIGTERM");
  });
}

function startNodeServer(script, label) {
  const child = spawn("node", [script], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await stopChild(child);
      reject(new Error(`${label} startup timed out`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      try {
        const ready = JSON.parse(output);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: ready.port });
      } catch { /* wait for the startup record */ }
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} failed before startup`));
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} exited before startup`));
    });
  });
}

function environment(home, allowLoopback = false) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
    ...(allowLoopback ? { BIFROST_TEST_ALLOW_LOOPBACK: "1" } : {}),
  };
}

function writeModels(home, models) {
  const providers = {};
  for (const { provider = "fake", ...model } of models) {
    const entry = providers[provider] ??= {
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      api: "openai-completions",
      apiKey: `fixture-${provider}`,
      models: [],
    };
    entry.models.push({ reasoning: false, contextWindow: 8192, maxTokens: 512, ...model });
  }
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    retry: { enabled: false },
    enabledModels: Object.keys(providers).map((provider) => `${provider}/*`),
  }));
}

function writeConfig(work, config) {
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify(config));
}

function freshDirs() {
  return {
    home: mkdtempSync(join(tmpdir(), "bifrost-provider-control-home-")),
    work: mkdtempSync(join(tmpdir(), "bifrost-provider-control-work-")),
  };
}

function runPi({ home, work, model = "bifrost/auto", messages, allowLoopback = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
      stdio: ["ignore", "pipe", "pipe"], cwd: work, env: environment(home, allowLoopback),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let force;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, 90_000);
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(force); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      try {
        const violations = readFileSync(join(home, "test-network-violations.log"), "utf8");
        assert.equal(violations, "", "the outbound guard recorded an external request");
      } catch (error) {
        if (error.code !== "ENOENT") { reject(error); return; }
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function statsFrom(port) {
  const response = await fetch(`http://127.0.0.1:${port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function fakeStats() { return statsFrom(fakePort); }

function generationCount(stats, model) {
  return stats.stats.filter((entry) => entry.kind === "generation" && entry.model === model).length;
}

function delta(before, after, model) {
  return generationCount(after, model) - generationCount(before, model);
}

function baseConfig(quick, reliability = {}) {
  return {
    enabled: true,
    default: "quick",
    strategy: "first",
    categoryStrategies: { quick: "first" },
    classifier: { enabled: false },
    models: { quick },
    reliability: {
      enabled: true,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
      retryOnAllowanceExhausted: false,
      ...reliability,
    },
  };
}

function v2(config) {
  return {
    ...config,
    schemaVersion: 2,
    reliability: { ...config.reliability, stateVersion: 2 },
  };
}

function providerState(work) {
  const path = join(work, ".pi", "bifrost-provider-reliability.json");
  return { path, value: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined };
}

function providerScopeKeys(work) {
  const { value } = providerState(work);
  return Object.keys(value?.scopes ?? {});
}

describe("provider pause control acceptance against pinned Pi", { timeout: 300_000, concurrency: 1 }, () => {
  before(async () => {
    server = await startNodeServer(FAKE_SERVER, "fake provider");
    fakePort = server.port;
  });
  after(async () => {
    if (server?.child) await stopChild(server.child);
  });

  it("applies a persisted Retry-After pause in real Pi, blocks the provider until expiry, then recovers a healthy same-provider model", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [
        { provider: "fake-a", id: "healthy", reasoning: false },
        { provider: "fake-b", id: "alternate", reasoning: false },
      ]);
      const config = baseConfig(["fake-a/healthy", "fake-b/alternate"]);
      writeConfig(work, config);
      mkdirSync(join(work, ".pi"), { recursive: true });
      // Boundary: Retry-After parsing and pause persistence are pinned at the
      // ProviderCooldownStore boundary; this journey proves real Pi applies the
      // persisted expiry and settles one controlled recovery trial.
      const store = createProviderCooldownStore(work, config.reliability);
      // A long enough window to cover Pi cold start under concurrent load; the
      // exact one-second/expiry boundary is pinned deterministically in case 5.
      const retryAt = Date.now() + 30_000;
      const openUntil = await store.pauseRate("fake-a", retryAt);
      assert.ok(openUntil > Date.now() && openUntil <= retryAt, "Retry-After must persist a bounded future pause");

      const beforeBlocked = await fakeStats();
      const blocked = await runPi({ home, work, messages: ["a turn while the provider remains paused"] });
      const afterBlocked = await fakeStats();
      assert.equal(blocked.code, 0, blocked.stderr);
      assert.equal(delta(beforeBlocked, afterBlocked, "healthy"), 0, "a same-provider model is excluded while Retry-After is active");
      assert.equal(delta(beforeBlocked, afterBlocked, "alternate"), 1, "another provider remains eligible");

      const waitMs = Math.max(0, openUntil - Date.now() + 150);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const beforeRecovery = await fakeStats();
      const recovered = await runPi({ home, work, model: "fake-a/healthy", messages: ["recover through the healthy same-provider model"] });
      const afterRecovery = await fakeStats();
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.equal(delta(beforeRecovery, afterRecovery, "healthy"), 1,
        "after Retry-After expiry one controlled trial reaches the healthy same-provider model");
      assert.match(recovered.stdout, /healthy/u);
      const finalView = createProviderCooldownStore(work, config.reliability).read("fake-a", true);
      assert.equal(finalView.recoveryPending, false, "no half-open recovery remains pending after success");
      const raw = providerState(work).value;
      const liveTrial = Object.entries(raw?.scopes ?? {}).find(([key, scope]) =>
        key.includes("bifrost-provider-trial/fake-a")
        && typeof scope?.lease?.expiresAt === "number" && scope.lease.expiresAt > Date.now());
      assert.equal(liveTrial, undefined, "the settled recovery trial owns no live lease");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not pause a provider when allowance cooldown is disabled", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [
        { provider: "fake-a", id: "credits-exhausted", reasoning: false },
        { provider: "fake-a", id: "sibling", reasoning: false },
        { provider: "fake-b", id: "alternate", reasoning: false },
      ]);
      writeConfig(work, baseConfig(
        ["fake-a/credits-exhausted", "fake-a/sibling", "fake-b/alternate"],
        { cooldownOnAllowanceExhausted: false },
      ));
      const beforeFailure = await fakeStats();
      const failed = await runPi({ home, work, messages: ["trigger a disabled-cooldown billing denial"] });
      const afterFailure = await fakeStats();
      assert.notEqual(failed.code, 0, failed.stderr);
      assert.equal(delta(beforeFailure, afterFailure, "credits-exhausted"), 1);
      assert.equal(providerScopeKeys(work).some((key) => key.includes("bifrost-provider-usage/fake-a")), false,
        "disabled allowance cooldowns must not write a provider usage pause");

      writeConfig(work, baseConfig(
        ["fake-a/sibling", "fake-a/credits-exhausted", "fake-b/alternate"],
        { cooldownOnAllowanceExhausted: false },
      ));
      const beforeRetry = await fakeStats();
      const retried = await runPi({ home, work, messages: ["use the same-provider sibling on the next turn"] });
      const afterRetry = await fakeStats();
      assert.equal(retried.code, 0, retried.stderr);
      assert.equal(delta(beforeRetry, afterRetry, "credits-exhausted"), 0);
      assert.equal(delta(beforeRetry, afterRetry, "sibling"), 1, "the same-provider sibling is not excluded when cooldowns are disabled");
      assert.equal(delta(beforeRetry, afterRetry, "alternate"), 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("applies model vs provider allowance cooldown scope across restarts in both directions", async () => {
    const modelOnlyRun = freshDirs();
    const providerWideRun = freshDirs();
    try {
      const models = [
        { provider: "fake-a", id: "usage-exhausted", reasoning: false },
        { provider: "fake-a", id: "sibling", reasoning: false },
        { provider: "fake-b", id: "alternate", reasoning: false },
      ];
      // Model scope is the config the first Pi process observes: only the failed model is paused.
      writeModels(modelOnlyRun.home, models);
      writeConfig(modelOnlyRun.work, v2(baseConfig(
        ["fake-a/usage-exhausted", "fake-a/sibling", "fake-b/alternate"],
        { allowanceCooldownScope: "model" },
      )));
      const p2mBeforeFailure = await fakeStats();
      const p2mFailed = await runPi({ home: modelOnlyRun.home, work: modelOnlyRun.work, messages: ["/bifrost reliability migrate --fresh", "model scope failure after reload"] });
      const p2mAfterFailure = await fakeStats();
      assert.notEqual(p2mFailed.code, 0, p2mFailed.stderr);
      assert.equal(delta(p2mBeforeFailure, p2mAfterFailure, "usage-exhausted"), 1);
      assert.equal(providerScopeKeys(modelOnlyRun.work).some((key) => key.includes("bifrost-provider-usage/fake-a")), false,
        "the model scope must not write a provider usage pause");

      const p2mBeforeNext = await fakeStats();
      const p2mNext = await runPi({ home: modelOnlyRun.home, work: modelOnlyRun.work, messages: ["sibling under model scope"] });
      const p2mAfterNext = await fakeStats();
      assert.equal(p2mNext.code, 0, p2mNext.stderr);
      assert.equal(delta(p2mBeforeNext, p2mAfterNext, "sibling"), 1,
        "the model scope makes the same-provider sibling eligible");
      assert.equal(delta(p2mBeforeNext, p2mAfterNext, "alternate"), 0);

      // Provider scope is the config the first Pi process observes: the provider becomes paused.
      writeModels(providerWideRun.home, models);
      writeConfig(providerWideRun.work, v2(baseConfig(
        ["fake-a/usage-exhausted", "fake-a/sibling", "fake-b/alternate"],
        { allowanceCooldownScope: "provider" },
      )));
      const m2pBeforeFailure = await fakeStats();
      const m2pFailed = await runPi({ home: providerWideRun.home, work: providerWideRun.work, messages: ["/bifrost reliability migrate --fresh", "provider scope failure after reload"] });
      const m2pAfterFailure = await fakeStats();
      assert.notEqual(m2pFailed.code, 0, m2pFailed.stderr);
      assert.equal(delta(m2pBeforeFailure, m2pAfterFailure, "usage-exhausted"), 1);
      assert.ok(providerScopeKeys(providerWideRun.work).some((key) => key.includes("bifrost-provider-usage/fake-a")),
        "the provider scope writes a provider usage pause");

      const m2pBeforeNext = await fakeStats();
      const m2pNext = await runPi({ home: providerWideRun.home, work: providerWideRun.work, messages: ["alternate under provider scope"] });
      const m2pAfterNext = await fakeStats();
      assert.equal(m2pNext.code, 0, m2pNext.stderr);
      assert.equal(delta(m2pBeforeNext, m2pAfterNext, "sibling"), 0,
        "the provider scope excludes the same-provider sibling");
      assert.equal(delta(m2pBeforeNext, m2pAfterNext, "alternate"), 1,
        "another provider remains eligible under the provider scope");
    } finally {
      for (const dirs of [modelOnlyRun, providerWideRun]) {
        rmSync(dirs.home, { recursive: true, force: true });
        rmSync(dirs.work, { recursive: true, force: true });
      }
    }
  });

  it("resets only the exact provider and leaves other provider pauses intact", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [
        { provider: "fake-a", id: "healthy", reasoning: false },
        { provider: "fake-b", id: "alternate", reasoning: false },
      ]);
      const config = baseConfig(["fake-a/healthy", "fake-b/alternate"]);
      writeConfig(work, config);
      mkdirSync(join(work, ".pi"), { recursive: true });
      const store = createProviderCooldownStore(work, config.reliability);
      await store.pauseUsage("fake-a");
      await store.pauseUsage("fake-b");
      assert.ok(store.read("fake-a").openUntil !== undefined);
      assert.ok(store.read("fake-b").openUntil !== undefined);

      const reset = await runPi({ home, work, model: "fake-a/healthy", messages: ["/bifrost reliability reset --provider fake-a"] });
      assert.equal(reset.code, 0, reset.stderr);
      assert.match(`${reset.stdout}\n${reset.stderr}`, /Provider fake-a cooldown was reset/u);
      const scopes = providerState(work).value.scopes;
      const scopeFor = (provider) => Object.entries(scopes).find(([key]) => key.includes(`bifrost-provider-usage/${provider}`))?.[1];
      assert.equal(scopeFor("fake-a")?.openUntil, undefined,
        "the exact requested provider pause is cleared");
      assert.ok(scopeFor("fake-b")?.openUntil > Date.now(),
        "a different provider pause is not cleared by the exact-provider reset");

      const before = await fakeStats();
      const routed = await runPi({ home, work, messages: ["route after the exact-provider reset"] });
      const after = await fakeStats();
      assert.equal(routed.code, 0, routed.stderr);
      assert.equal(delta(before, after, "healthy"), 1, "the reset provider is eligible on the next Auto turn");
      assert.equal(delta(before, after, "alternate"), 0, "the other provider remains paused");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("provider pause exact boundaries and controlled fault", { timeout: 300_000, concurrency: 1 }, () => {
  it("admits one recovery trial at the exact Retry-After expiry and refuses reset until it settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-provider-exact-"));
    let now = 1_800_000_000_000;
    try {
      const config = reliabilityV2Config({ cooldownMinutes: 1 });
      const path = providerReliabilityPath(directory);
      const store = new ProviderCooldownStore(
        new ReliabilityV2Store({ path, config: { ...config, cooldownMs: 60_000 }, now: () => now }),
        60_000,
      );
      await store.pauseRate("provider-a", now + 1_000, now);
      assert.equal(store.read("provider-a", true, now).openUntil, now + 1_000);
      assert.equal((await store.claimTrial("provider-a", true, now + 999)).allowed, false,
        "one millisecond before expiry remains paused");

      now += 1_000;
      const trial = await store.claimTrial("provider-a", true, now);
      assert.ok(trial.allowed, "the exact Retry-After expiry boundary must admit one controlled recovery trial");
      assert.ok(trial.claim, "the admitted recovery owns a trial lease");
      assert.equal(store.read("provider-a", true, now).trialActive, true);
      assert.equal(await store.reset("provider-a"), "trial_active",
        "reset must be rejected while the recovery trial is active");
      assert.equal(store.read("provider-a", true, now).trialActive, true,
        "the rejected reset leaves the active trial intact");

      await store.settleTrial(trial.claim);
      assert.equal(store.read("provider-a", true, now).trialActive, false);
      assert.equal(store.read("provider-a", true, now).openUntil, undefined,
        "successful settlement clears the expired rate pause");
      assert.equal(await store.reset("provider-a"), "already_clear");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("RED-proves the provider pause/expiry guard in an isolated source copy", async () => {
    const target = "admits one recovery trial at the exact Retry-After expiry and refuses reset until it settles";
    const proof = await runControlledFault({
      root: ROOT,
      testFile: "tests/integration/provider-control-acceptance.test.mjs",
      targetFile: "provider-cooldowns.ts",
      testName: target,
      expectedRed: "the exact Retry-After expiry boundary must admit one controlled recovery trial",
      mutation(source) {
        const needle = "if ([usage?.openUntil, rate?.openUntil].some((until) => until !== undefined && until > now)) return { allowed: false };";
        assert.ok(source.includes(needle), "the claimTrial pause/expiry guard anchor must exist");
        return source.replace(needle, needle.replace("until > now", "until >= now"));
      },
    });
    assert.equal(proof.baseline.code, 0);
    assert.notEqual(proof.red.code, 0);
    assert.equal(proof.restored.code, 0);
  });
});
