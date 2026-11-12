import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ProviderCooldownStore, projectProviderCooldownsForRouting } from "../provider-cooldowns.ts";
import { ReliabilityV2Store } from "../reliability-v2-store.ts";
import { createProviderCooldownStore, reliabilityV2Config, providerReliabilityPath } from "../runtime-reliability-v2.ts";
import { getCircuitState } from "../reliability.ts";

const directories: string[] = [];
const cfg = reliabilityV2Config({ cooldownMinutes: 1 });

function fixture(cooldownMs = 100) {
  const cwd = fs.mkdtempSync(join(tmpdir(), "bifrost-provider-cooldown-"));
  directories.push(cwd);
  let now = 1_800_000_000_000;
  const path = providerReliabilityPath(cwd);
  const make = () => new ProviderCooldownStore(
    new ReliabilityV2Store({ path, config: { ...cfg, cooldownMs }, now: () => now }), cooldownMs,
  );
  return { cwd, path, make, advance: (ms: number) => { now += ms; }, now: () => now };
}

after(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared provider cooldowns", () => {
  it("admits a healthy provider read-only without creating state or a lock", async () => {
    const f = fixture();
    const result = await f.make().claimTrial("provider-a");
    assert.deepEqual(result, { allowed: true });
    assert.equal(fs.existsSync(f.path), false);
    assert.equal(fs.existsSync(`${f.path}.lock`), false);
  });

  it("uses bounded provider-only defaults for otherwise-valid large v1 model thresholds", async () => {
    const cwd = fs.mkdtempSync(join(tmpdir(), "bifrost-provider-config-bounds-"));
    directories.push(cwd);
    const store = createProviderCooldownStore(cwd, {
      failureThreshold: 10_001, windowMinutes: 1_000_001, cooldownMinutes: 1_000_001,
    });
    await store.pauseUsage("provider-a", 1_800_000_000_000);
    assert.equal(store.read("provider-a", true, 1_800_000_000_000).openUntil, 1_860_000_000_000);
  });

  it("projects one provider pause onto its models while another provider remains eligible", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    const models = [
      { provider: "provider-a", id: "model-one" },
      { provider: "provider-a", id: "model-two" },
      { provider: "provider-b", id: "model-three" },
    ];
    const projected = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store, models, true, f.now());
    assert.equal(getCircuitState(projected, "provider-a/model-one", f.now(), undefined).open, true);
    assert.equal(getCircuitState(projected, "provider-a/model-two", f.now(), undefined).open, true);
    assert.equal(getCircuitState(projected, "provider-b/model-three", f.now(), undefined).open, false);
    assert.deepEqual(store.list(f.now()).map((item) => item.providerId), ["provider-a"]);
  });

  it("loads one validated snapshot for a routing projection and preserves provider pause semantics", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    await store.pauseRate("provider-b", f.now() + 60_000, f.now());
    f.advance(101);
    const trial = await store.claimTrial("provider-a", true, f.now());
    assert.ok(trial.allowed && trial.claim);
    await store.pauseUsage("provider-c", f.now());
    await store.pauseUsage("provider-e", f.now());

    let reads = 0;
    const readSnapshot = store.store.readSnapshot.bind(store.store);
    store.store.readSnapshot = () => { reads++; return readSnapshot(); };
    const models = [
      { provider: "provider-a", id: "active-usage" },
      { provider: "provider-a", id: "same-provider" },
      { provider: "provider-b", id: "active-rate" },
      { provider: "provider-c", id: "usage-disabled" },
      { provider: "provider-e", id: "active-usage" },
      { provider: "provider-d", id: "healthy" },
    ];
    const existing = { failures: [f.now() - 1], openUntil: f.now() + 500, trialActive: false };
    const projected = projectProviderCooldownsForRouting({
      version: 1,
      models: Object.assign(Object.create(null), { "provider-a/active-usage": existing }),
    }, store, models, false, f.now());

    assert.equal(reads, 1);
    assert.deepEqual(projected.models["provider-a/active-usage"], {
      failures: existing.failures, openUntil: existing.openUntil, trialActive: true,
    });
    assert.equal(projected.models["provider-a/same-provider"]?.trialActive, true);
    assert.equal(projected.models["provider-b/active-rate"]?.openUntil, f.now() + 59_899);
    assert.equal(projected.models["provider-c/usage-disabled"], undefined);
    assert.equal(projected.models["provider-e/active-usage"], undefined);
    assert.equal(projected.models["provider-d/healthy"], undefined);

    reads = 0;
    const withUsage = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store, models, true, f.now());
    assert.equal(reads, 1);
    assert.equal(withUsage.models["provider-c/usage-disabled"]?.openUntil, f.now() + 100);
    assert.equal(withUsage.models["provider-e/active-usage"]?.openUntil, f.now() + 100);
  });

  it("does not load provider state when the routing projection has no models", () => {
    const f = fixture();
    const store = f.make();
    let reads = 0;
    const readSnapshot = store.store.readSnapshot.bind(store.store);
    store.store.readSnapshot = () => { reads++; return readSnapshot(); };
    const projected = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store, [], true, f.now());
    assert.deepEqual(Object.keys(projected.models), []);
    assert.equal(reads, 0);
  });

  it("does not project an expired provider recovery lease", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-f", f.now());
    f.advance(101);
    const trial = await store.claimTrial("provider-f", true, f.now());
    assert.ok(trial.allowed && trial.claim);
    f.advance(120_001);
    const view = store.read("provider-f", true, f.now());
    assert.equal(view.trialActive, false);
    assert.equal(view.recoveryPending, true);
    const projected = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store,
      [{ provider: "provider-f", id: "expired-trial" }], true, f.now());
    assert.equal(projected.models["provider-f/expired-trial"], undefined);
  });

  it("keeps one projection on its captured revision and reads newer state on the next projection", async () => {
    const f = fixture();
    const store = f.make();
    let reads = 0;
    let revisionChange: Promise<number> | undefined;
    const readSnapshot = store.store.readSnapshot.bind(store.store);
    store.store.readSnapshot = () => {
      const snapshot = readSnapshot();
      reads++;
      if (reads === 1) revisionChange = store.pauseRate("provider-b", f.now() + 10_000, f.now());
      return snapshot;
    };
    const models = [{ provider: "provider-a", id: "first" }, { provider: "provider-b", id: "second" }];
    const first = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store, models, true, f.now());
    assert.equal(first.models["provider-b/second"], undefined);
    await revisionChange;
    const second = projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store, models, true, f.now());
    assert.equal(second.models["provider-b/second"]?.openUntil, f.now() + 10_000);
    assert.equal(reads, 2);
  });

  it("allows one cross-instance half-open trial and settles it after recovery", async () => {
    const f = fixture();
    const first = f.make();
    const second = f.make();
    await first.pauseUsage("provider-a", f.now());
    f.advance(101);
    const results = await Promise.all([first.claimTrial("provider-a", true, f.now()), second.claimTrial("provider-a", true, f.now())]);
    assert.equal(results.filter((item) => item.allowed && item.claim).length, 1);
    assert.equal(results.filter((item) => !item.allowed).length, 1);
    const claim = results.find((item) => item.allowed && item.claim);
    assert.ok(claim?.allowed && claim.claim);
    assert.equal(await first.reset("provider-a"), "trial_active");
    await first.settleTrial(claim.claim);
    assert.deepEqual(first.list(f.now()), []);
    assert.equal(await second.reset("provider-a"), "already_clear");
  });

  it("renews the exact provider half-open lease before its original expiry", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    f.advance(101);
    const result = await store.claimTrial("provider-a", true, f.now());
    assert.ok(result.allowed && result.claim);
    const claim = result.claim;
    const firstExpiry = claim.leases[0]!.expiresAt;
    f.advance(90_000);
    await store.renewTrial(claim);
    assert.ok(claim.leases[0]!.expiresAt > firstExpiry);
    assert.equal(claim.leases[0]!.expiresAt, f.now() + 120_000);
    await store.releaseTrial(claim);
  });

  it("accepts stale expired leases as completed trial finalization", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-stale", f.now());
    f.advance(101);
    const settled = await store.claimTrial("provider-stale", true, f.now());
    assert.ok(settled.allowed && settled.claim);
    f.advance(120_001);
    await assert.doesNotReject(store.settleTrial(settled.claim));

    await store.pauseUsage("provider-release", f.now());
    f.advance(101);
    const released = await store.claimTrial("provider-release", true, f.now());
    assert.ok(released.allowed && released.claim);
    f.advance(120_001);
    await assert.doesNotReject(store.releaseTrial(released.claim));

    await store.pauseUsage("provider-expired-settle", f.now());
    f.advance(101);
    const expiredSettle = await store.claimTrial("provider-expired-settle", true, f.now());
    assert.ok(expiredSettle.allowed && expiredSettle.claim);
    f.advance(24 * 60 * 60 * 1_000);
    await assert.doesNotReject(store.settleTrial(expiredSettle.claim));

    await store.pauseUsage("provider-expired-release", f.now());
    f.advance(101);
    const expiredRelease = await store.claimTrial("provider-expired-release", true, f.now());
    assert.ok(expiredRelease.allowed && expiredRelease.claim);
    f.advance(24 * 60 * 60 * 1_000);
    await assert.doesNotReject(store.releaseTrial(expiredRelease.claim));
  });

  it("does not renew a provider lease after settlement has begun", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    f.advance(101);
    const result = await store.claimTrial("provider-a", true, f.now());
    assert.ok(result.allowed && result.claim);
    const claim = result.claim;
    await store.settleTrial(claim);
    assert.equal(claim.finalized, true);
    await store.renewTrial(claim);
    assert.deepEqual(store.list(f.now()), []);
  });

  it("does not let a stale trial clear a newer pause or let 429 shorten a credit pause", async () => {
    const f = fixture(60 * 60 * 1000);
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    const creditPause = f.now() + 60 * 60 * 1000;
    await store.pauseRate("provider-a", f.now() + 5_000, f.now());
    assert.equal(store.read("provider-a").openUntil, creditPause);
    f.advance(60 * 60 * 1000 + 1);
    const trial = await store.claimTrial("provider-a", true, f.now());
    assert.ok(trial.allowed && trial.claim);
    await store.pauseUsage("provider-a", f.now());
    await store.settleTrial(trial.claim);
    assert.equal(store.read("provider-a").openUntil, f.now() + 60 * 60 * 1000);
    assert.ok(creditPause < f.now());
  });

  it("imports an active legacy allowance once and does not resurrect it after provider reset", async () => {
    const f = fixture();
    const store = f.make();
    const marker = {
      providerId: "provider-a", modelKey: "provider-a/old-model",
      sourceId: "v1|provider-a/old-model|1700000000000|1800000005000",
      openUntil: f.now() + 5_000,
    };
    assert.equal(await store.importLegacyAllowance(marker, f.now()), true);
    assert.equal(store.read("provider-a").openUntil, marker.openUntil);
    assert.equal(await store.importLegacyAllowance(marker, f.now()), false);
    assert.equal(await store.reset("provider-a"), "reset");
    assert.equal(store.read("provider-a").openUntil, undefined);
    assert.equal(await store.importLegacyAllowance(marker, f.now()), false);
    assert.equal(store.read("provider-a").openUntil, undefined);
  });

  it("fails closed on malformed shared state and can reset only known exact provider scopes", async () => {
    const f = fixture();
    const store = f.make();
    await store.pauseUsage("provider-a", f.now());
    assert.equal(await store.reset("provider-b"), "already_clear");
    assert.equal(store.read("provider-a").openUntil, f.now() + 100);
    fs.writeFileSync(f.path, "{broken", "utf8");
    assert.throws(() => store.read("provider-a"));
    assert.throws(() => projectProviderCooldownsForRouting({ version: 1, models: Object.create(null) }, store,
      [{ provider: "provider-a", id: "model-one" }], true, f.now()));
    await assert.rejects(store.claimTrial("provider-a"));
  });
});
