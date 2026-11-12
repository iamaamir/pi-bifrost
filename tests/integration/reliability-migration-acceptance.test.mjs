import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { acquireReliabilitySourceFenceSync, releaseReliabilitySourceFence } from "../../reliability-v1-fence.ts";
import { ReliabilityV2Store, ReliabilityV2StoreError } from "../../reliability-v2-store.ts";
import { reliabilityV2Config } from "../../runtime-reliability-v2.ts";
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

function startFakeServer() {
  const child = spawn("node", [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await stopChild(child);
      reject(new Error("fake provider startup timed out"));
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
      reject(new Error("fake provider failed before startup"));
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("fake provider exited before startup"));
    });
  });
}

function environment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${fakePort}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "test-network-violations.log"),
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

function writeConfig(work, stateVersion) {
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(work, ".pi", "bifrost.json"), JSON.stringify({
    ...(stateVersion === 2 ? { schemaVersion: 2 } : {}),
    enabled: true,
    default: "quick",
    strategy: "first",
    classifier: { enabled: false },
    models: { quick: ["fake-a/paused", "fake-a/healthy", "fake-b/alternate"] },
    reliability: {
      enabled: true,
      failureThreshold: 3,
      windowMinutes: 5,
      cooldownMinutes: 60,
      stateVersion,
      retryOnAllowanceExhausted: false,
    },
  }));
}

function v1Source(now, pausedUntil = now + 3_600_000) {
  return Buffer.from(JSON.stringify({
    version: 1,
    models: {
      "fake-a/paused": {
        failures: [now - 1_000],
        openUntil: pausedUntil,
        lastFailureAt: now - 1_000,
        lastFailureReason: "fixture-only migrated failure",
      },
    },
  }));
}

function freshDirs() {
  return {
    home: mkdtempSync(join(tmpdir(), "bifrost-migration-acceptance-home-")),
    work: mkdtempSync(join(tmpdir(), "bifrost-migration-acceptance-work-")),
  };
}

function runPi({ home, work, model = "bifrost/auto", messages }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, ["-e", EXTENSION, "--approve", "--no-session", "--no-tools", "--model", model, "-p", ...messages], {
      stdio: ["ignore", "pipe", "pipe"], cwd: work, env: environment(home),
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

async function fakeStats() {
  const response = await fetch(`http://127.0.0.1:${fakePort}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

function generationCount(stats, model) {
  return stats.stats.filter((entry) => entry.kind === "generation" && entry.model === model).length;
}

function delta(before, after, model) {
  return generationCount(after, model) - generationCount(before, model);
}

function paths(work) {
  const project = join(work, ".pi");
  return {
    source: join(project, "bifrost-reliability.json"),
    backup: join(project, "bifrost-reliability-v1.json.backup"),
    sidecar: join(project, "bifrost-reliability-v2.json"),
  };
}

describe("reliability migration acceptance against pinned Pi", { timeout: 300_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeServer(); fakePort = server.port; });
  after(async () => { if (server?.child) await stopChild(server.child); });

  it("migrates a nonempty v1 source to an exact backup and restarts into v2 state", async () => {
    const { home, work } = freshDirs();
    try {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeModels(home, [
        { provider: "fake-a", id: "paused", reasoning: false },
        { provider: "fake-a", id: "healthy", reasoning: false },
        { provider: "fake-b", id: "alternate", reasoning: false },
      ]);
      writeConfig(work, 1);
      const sourceBytes = v1Source(Date.now());
      writeFileSync(paths(work).source, sourceBytes);

      const migrated = await runPi({ home, work, model: "fake-a/healthy", messages: ["/bifrost reliability migrate"] });
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.match(`${migrated.stdout}\n${migrated.stderr}`, /Reliability v2 sidecar initialized/u);
      assert.equal(existsSync(paths(work).backup), true, "migration must create the explicit v1 backup");
      assert.deepEqual(readFileSync(paths(work).backup), sourceBytes,
        "the backup must be byte-for-byte the nonempty v1 source");
      assert.equal(existsSync(paths(work).sidecar), true, "migration must create the separate v2 sidecar");
      assert.deepEqual(readFileSync(paths(work).source), sourceBytes, "migration must not rewrite the v1 source");
      const sidecar = JSON.parse(readFileSync(paths(work).sidecar, "utf8"));
      assert.ok(Object.keys(sidecar.scopes ?? {}).some((key) => key.endsWith("fake-a/paused")),
        "the nonempty migrated model record must be present in v2 state");

      writeConfig(work, 2);
      const before = await fakeStats();
      const restarted = await runPi({ home, work, messages: ["use the migrated v2 state after restart"] });
      const after = await fakeStats();
      assert.equal(restarted.code, 0, restarted.stderr);
      assert.equal(delta(before, after, "paused"), 0, "the migrated open circuit blocks its model after restart");
      assert.equal(delta(before, after, "healthy") + delta(before, after, "alternate"), 1,
        `exactly one non-paused configured model completes the restarted turn; stats=${JSON.stringify(after.stats.slice(before.stats.length))}; stderr=${restarted.stderr}`);
      assert.deepEqual(readFileSync(paths(work).backup), sourceBytes,
        "the restart into v2 must not alter the exact backup");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt v2 sidecar before creating or changing any migration file", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [{ provider: "fake-a", id: "healthy", reasoning: false }]);
      writeConfig(work, 1);
      const sourceBytes = v1Source(Date.now());
      writeFileSync(paths(work).source, sourceBytes);
      const corrupt = Buffer.from("not valid v2 json\n");
      writeFileSync(paths(work).sidecar, corrupt);

      const result = await runPi({ home, work, model: "fake-a/healthy", messages: ["/bifrost reliability migrate"] });
      assert.match(`${result.stdout}\n${result.stderr}`, /existing reliability v2 sidecar is invalid or unsafe; repair it explicitly/u);
      assert.deepEqual(readFileSync(paths(work).source), sourceBytes, "the v1 source is untouched");
      assert.deepEqual(readFileSync(paths(work).sidecar), corrupt, "the corrupt sidecar is untouched");
      assert.equal(existsSync(paths(work).backup), false, "no backup is created before the corrupt sidecar is rejected");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("rejects --fresh when a nonempty v1 source exists before creating a backup", async () => {
    const { home, work } = freshDirs();
    try {
      writeModels(home, [{ provider: "fake-a", id: "healthy", reasoning: false }]);
      writeConfig(work, 1);
      const sourceBytes = v1Source(Date.now());
      writeFileSync(paths(work).source, sourceBytes);

      const result = await runPi({ home, work, model: "fake-a/healthy", messages: ["/bifrost reliability migrate --fresh"] });
      assert.match(`${result.stdout}\n${result.stderr}`, /--fresh is allowed only when no v1 reliability file exists/u);
      assert.deepEqual(readFileSync(paths(work).source), sourceBytes, "the conflicting v1 source is untouched");
      assert.equal(existsSync(paths(work).backup), false, "a source conflict must not create a backup");
      assert.equal(existsSync(paths(work).sidecar), false, "a source conflict must not create v2 state");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("migration exact mutation boundaries and controlled fault", { timeout: 300_000, concurrency: 1 }, () => {
  const config = reliabilityV2Config({ cooldownMinutes: 1 });

  it("rejects a held active v1 source writer before backup or v2 mutation at the deterministic fence boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-migration-held-"));
    try {
      const sourcePath = join(directory, "reliability-v1.json");
      const statePath = join(directory, "reliability-v2.json");
      const backupPath = join(directory, "reliability-v1.backup.json");
      const sourceBytes = v1Source(Date.now());
      writeFileSync(sourcePath, sourceBytes);
      const owner = acquireReliabilitySourceFenceSync(sourcePath);
      try {
        const store = new ReliabilityV2Store({ path: statePath, config, lockTimeoutMs: 20, lockPollMs: 1 });
        await assert.rejects(
          store.initializeFromV1Migration({ sourceSnapshot: sourceBytes, sourcePath, backupPath }),
          (error) => {
            assert.ok(error instanceof ReliabilityV2StoreError);
            assert.equal(error.code, "source_lock_contended");
            return true;
          },
        );
        assert.equal(existsSync(backupPath), false, "a held active writer must not permit a backup mutation");
        assert.equal(existsSync(statePath), false, "a held active writer must not permit a v2 mutation");
        assert.deepEqual(readFileSync(sourcePath), sourceBytes, "the held source remains unchanged");
      } finally {
        releaseReliabilitySourceFence(owner);
      }

      const retried = await new ReliabilityV2Store({ path: statePath, config }).initializeFromV1Migration({
        sourceSnapshot: sourceBytes, sourcePath, backupPath,
      });
      assert.equal(retried.status, "seeded", "migration succeeds only after the active writer releases its fence");
      assert.deepEqual(readFileSync(backupPath), sourceBytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid v1 source before creating a backup or v2 sidecar", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bifrost-migration-invalid-"));
    try {
      const statePath = join(directory, "reliability-v2.json");
      const backupPath = join(directory, "reliability-v1.backup.json");
      const store = new ReliabilityV2Store({ path: statePath, config });
      await assert.rejects(
        store.initializeFromV1Migration({ sourceSnapshot: Buffer.from("not a v1 snapshot\n"), backupPath }),
        (error) => {
          assert.ok(error instanceof ReliabilityV2StoreError);
          assert.equal(error.code, "invalid_migration");
          return true;
        },
      );
      assert.equal(existsSync(backupPath), false,
        "an invalid v1 source must not create a backup before validation fails");
      assert.equal(existsSync(statePath), false, "an invalid v1 source must not create a v2 sidecar");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("RED-proves the migration mutation-before-validation guard in an isolated source copy", async () => {
    const target = "rejects an invalid v1 source before creating a backup or v2 sidecar";
    const proof = await runControlledFault({
      root: ROOT,
      testFile: "tests/integration/reliability-migration-acceptance.test.mjs",
      targetFile: "reliability-v2-store.ts",
      testName: target,
      expectedRed: "an invalid v1 source must not create a backup before validation fails",
      mutation(source) {
        const needle = "        let seed: ReliabilityV2State;\n        try {\n          seed = convertReliabilityV1Snapshot(sourceSnapshot, this.config);";
        assert.ok(source.includes(needle), "the migration validation anchor must exist");
        return source.replace(needle,
          "        this.io.writeMigrationBackup(backupPath, sourceSnapshot);\n        let seed: ReliabilityV2State;\n        try {\n          seed = convertReliabilityV1Snapshot(sourceSnapshot, this.config);");
      },
    });
    assert.equal(proof.baseline.code, 0);
    assert.notEqual(proof.red.code, 0);
    assert.equal(proof.restored.code, 0);
  });
});
