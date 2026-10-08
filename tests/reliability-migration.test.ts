import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { convertReliabilityV1Snapshot } from "../reliability-migration.ts";
import { modelScopeKey, validateReliabilityV2State, type ReliabilityV2Config } from "../reliability-v2.ts";
import { ReliabilityV2Store, ReliabilityV2StoreError } from "../reliability-v2-store.ts";
import { acquireReliabilitySourceFenceSync, reliabilitySourceFencePath, releaseReliabilitySourceFence } from "../reliability-v1-fence.ts";
import { saveReliability, type ReliabilityState } from "../reliability.ts";
import { writeJsonFile } from "../storage.ts";

const config: ReliabilityV2Config = {
  failureThreshold: 2,
  windowMs: 300_000,
  cooldownMs: 600_000,
  leaseTtlMs: 120_000,
  maxDispatchLifetimeMs: 600_000,
  dedupRetentionMs: 600_000,
  maxDedupEntries: 16,
  maxDispatchReceipts: 16,
};

const directories: string[] = [];
after(() => {
  for (const path of directories) fs.rmSync(path, { recursive: true, force: true });
});

function tempDirectory(): string {
  const path = fs.mkdtempSync(join(tmpdir(), "bifrost-migration-"));
  directories.push(path);
  return path;
}

function v1Snapshot(): Buffer {
  return Buffer.from(`{\n  "version": 1,\n  "models": {\n    "provider/model": {\n      "failures": [10, 20, 30],\n      "openUntil": 900,\n      "trialActive": true,\n      "cooldownMultiplier": 2,\n      "lastFailureAt": 30,\n      "lastFailureSource": "agent_settled",\n      "lastFailureReason": "private prompt / /Users/secret/key",\n      "lastSuccessAt": 5,\n      "lastSuccessSource": "probe"\n    }\n  }\n}\n`);
}

function migrationError(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReliabilityV2StoreError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("reliability v1 migration foundation", () => {
  it("converts model-only health facts and drops raw text and unowned trial flags", () => {
    const state = convertReliabilityV1Snapshot(v1Snapshot(), config);
    const record = state.scopes[modelScopeKey("provider/model")];
    assert.deepEqual(record, { generation: 0, failures: [20, 30], openUntil: 900, cooldownMultiplier: 2 });
    assert.equal(validateReliabilityV2State(state, config), true);
    assert.equal(JSON.stringify(state).includes("private prompt"), false);
    assert.equal(JSON.stringify(state).includes("/Users/secret/key"), false);
  });

  it("keeps the latest timestamped failures when legacy order is irregular", () => {
    const snapshot = Buffer.from('{"version":1,"models":{"provider/model":{"failures":[30,10,20]}}}');
    const state = convertReliabilityV1Snapshot(snapshot, config);
    assert.deepEqual(state.scopes[modelScopeKey("provider/model")]?.failures, [20, 30]);
  });

  it("rejects malformed legacy shape, timestamps, unknown fields, and invalid model keys", () => {
    const invalid = [
      Buffer.from('{"version":1,"models":{},"unexpected":true}'),
      Buffer.from('{"version":1,"models":{"provider/model":{"failures":[-1]}}}'),
      Buffer.from('{"version":1,"models":{"provider/model":{"failures":[],"newField":1}}}'),
      Buffer.from('{"version":1,"models":{"bad model":{"failures":[]}}}'),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ];
    for (const snapshot of invalid) assert.throws(() => convertReliabilityV1Snapshot(snapshot, config));
  });

  it("requires explicit snapshot bytes and never invokes accessors on migration options", async () => {
    const directory = tempDirectory();
    const store = new ReliabilityV2Store({ path: join(directory, "reliability-v2.json"), config });
    let getterCalled = false;
    const accessorInput = Object.defineProperties({}, {
      sourceSnapshot: { enumerable: true, get() { getterCalled = true; return v1Snapshot(); } },
      backupPath: { enumerable: true, value: join(directory, "backup.json") },
    }) as { sourceSnapshot: Uint8Array; backupPath: string };

    await migrationError(store.initializeFromV1Migration({
      sourceSnapshot: undefined as unknown as Uint8Array,
      backupPath: join(directory, "backup.json"),
    }), "invalid_migration");
    await migrationError(store.initializeFromV1Migration(accessorInput), "invalid_migration");
    assert.equal(getterCalled, false);
    assert.equal(fs.existsSync(join(directory, "reliability-v2.json")), false);
    assert.equal(fs.existsSync(join(directory, "backup.json")), false);
  });

  it("backs up exact legacy bytes before seeding the separate v2 file", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const snapshot = v1Snapshot();
    const store = new ReliabilityV2Store({ path: statePath, config, requireInitialized: true });

    const result = await store.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath });
    assert.equal(result.status, "seeded");
    assert.deepEqual(fs.readFileSync(backupPath), snapshot);
    assert.equal(fs.statSync(backupPath).mode & 0o077, 0);
    assert.equal(validateReliabilityV2State(JSON.parse(fs.readFileSync(statePath, "utf8")), config), true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.state)), JSON.parse(fs.readFileSync(statePath, "utf8")));
  });

  it("does not reseed or create a backup when a valid v2 sidecar already exists", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const original = Buffer.from('{"version":2,"revision":0,"scopes":{},"dispatches":{},"settledOutcomes":{}}\n');
    fs.writeFileSync(statePath, original);
    const store = new ReliabilityV2Store({ path: statePath, config });

    const result = await store.initializeFromV1Migration({ sourceSnapshot: v1Snapshot(), backupPath });
    assert.equal(result.status, "already_initialized");
    assert.deepEqual(fs.readFileSync(statePath), original);
    assert.equal(fs.existsSync(backupPath), false);
  });

  it("fails closed on corrupt v2 state before creating or changing the backup", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const corrupt = Buffer.from("bad json");
    fs.writeFileSync(statePath, corrupt);
    const store = new ReliabilityV2Store({ path: statePath, config });

    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: v1Snapshot(), backupPath }), "corrupt_state");
    assert.deepEqual(fs.readFileSync(statePath), corrupt);
    assert.equal(fs.existsSync(backupPath), false);
  });

  it("rejects a mismatched existing backup and leaves both files unchanged", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const other = Buffer.from('{"version":1,"models":{}}');
    fs.writeFileSync(backupPath, other);
    const store = new ReliabilityV2Store({ path: statePath, config });

    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: v1Snapshot(), backupPath }), "backup_conflict");
    assert.deepEqual(fs.readFileSync(backupPath), other);
    assert.equal(fs.existsSync(statePath), false);
  });

  it("rejects backup paths that alias managed state, source, or symlink targets", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const snapshot = v1Snapshot();
    fs.writeFileSync(sourcePath, snapshot);
    const store = new ReliabilityV2Store({ path: statePath, config });

    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath: sourcePath, sourcePath }), "invalid_migration");
    fs.linkSync(sourcePath, backupPath);
    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath, sourcePath }), "invalid_migration");
    fs.unlinkSync(backupPath);
    fs.symlinkSync(sourcePath, backupPath);
    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath }), "backup_conflict");
    assert.equal(fs.lstatSync(backupPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(statePath), false);
  });

  it("waits for the cooperative v1 source fence and seeds the latest source, not caller bytes", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const callerSnapshot = v1Snapshot();
    fs.writeFileSync(sourcePath, callerSnapshot);
    const newerState: ReliabilityState = { version: 1, models: { "provider/model": { failures: [777, 778], openUntil: 5_000 } } };
    // Hold the source fence as a v1 writer, start migration behind it, then commit the writer's atomic file replacement.
    const writerOwner = acquireReliabilitySourceFenceSync(sourcePath);
    const store = new ReliabilityV2Store({ path: statePath, config, now: () => 1_000, lockTimeoutMs: 1000, lockPollMs: 5 });
    const pending = store.initializeFromV1Migration({ sourceSnapshot: callerSnapshot, sourcePath, backupPath });
    writeJsonFile(sourcePath, newerState);
    const latest = fs.readFileSync(sourcePath);
    releaseReliabilitySourceFence(writerOwner);

    const result = await pending;
    assert.equal(result.status, "seeded");
    assert.deepEqual(fs.readFileSync(backupPath), latest);
    assert.deepEqual(result.state.scopes[modelScopeKey("provider/model")]?.failures, [777, 778]);
    assert.equal(result.state.scopes[modelScopeKey("provider/model")]?.openUntil, 5_000);
    assert.deepEqual(fs.readFileSync(sourcePath), latest);
    const admission = await store.admit({
      ownerToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      dispatchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      outcomeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      modelKeys: ["provider/model"],
    });
    assert.equal(admission.status, "blocked", "latest persisted open circuit remains blocked after migration");
  });

  it("does not let a v1 writer overwrite the source while migration owns its fence", () => {
    const directory = tempDirectory();
    const sourcePath = join(directory, "reliability-v1.json");
    const original = v1Snapshot();
    fs.writeFileSync(sourcePath, original);
    const owner = acquireReliabilitySourceFenceSync(sourcePath);
    saveReliability(sourcePath, { version: 1, models: { "provider/model": { failures: [888] } } });
    assert.deepEqual(fs.readFileSync(sourcePath), original);
    releaseReliabilitySourceFence(owner);
    saveReliability(sourcePath, { version: 1, models: { "provider/model": { failures: [888] } } });
    assert.deepEqual(JSON.parse(fs.readFileSync(sourcePath, "utf8")), {
      version: 1,
      models: { "provider/model": { failures: [888] } },
    });
  });

  it("fails fresh initialization if a v1 source appears while waiting for the fence", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const owner = acquireReliabilitySourceFenceSync(sourcePath);
    const store = new ReliabilityV2Store({ path: statePath, config, lockTimeoutMs: 1000, lockPollMs: 5 });
    const pending = store.initializeFromV1Migration({
      sourceSnapshot: Buffer.from('{"version":1,"models":{}}'),
      sourcePath,
      backupPath,
      requireSourceAbsent: true,
    });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    fs.writeFileSync(sourcePath, v1Snapshot());
    releaseReliabilitySourceFence(owner);
    await migrationError(pending, "source_exists");
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(backupPath), false);
  });

  it("fresh initialization seeds empty state even if caller bytes contain legacy records", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const store = new ReliabilityV2Store({ path: statePath, config });
    const result = await store.initializeFromV1Migration({
      sourceSnapshot: v1Snapshot(),
      sourcePath,
      backupPath,
      requireSourceAbsent: true,
    });
    assert.equal(result.status, "seeded");
    assert.deepEqual(JSON.parse(JSON.stringify(result.state)), { version: 2, revision: 0, scopes: {}, dispatches: {}, settledOutcomes: {} });
    assert.deepEqual(fs.readFileSync(backupPath), Buffer.from('{"version":1,"models":{}}\n'));
    assert.equal(fs.existsSync(sourcePath), false);
  });

  it("leaves a replaced source lock untouched and does not create backup or v2 state", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const sourceLockPath = reliabilitySourceFencePath(sourcePath);
    const backupPath = join(directory, "reliability-v1.backup.json");
    fs.writeFileSync(sourcePath, v1Snapshot());
    let replacedLock = "";
    const store = new ReliabilityV2Store({
      path: statePath,
      config,
      io: {
        writeLock(fd, contents) {
          fs.unlinkSync(sourceLockPath);
          replacedLock = JSON.stringify({ ownerToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pid: process.pid, createdAt: Date.now() });
          fs.writeFileSync(sourceLockPath, replacedLock, { mode: 0o600 });
          fs.writeFileSync(fd, contents, "utf8");
          fs.fsyncSync(fd);
        },
      },
    });
    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: v1Snapshot(), sourcePath, backupPath }), "source_lock_failed");
    assert.equal(fs.readFileSync(sourceLockPath, "utf8"), replacedLock);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(statePath), false);
  });

  it("detects an uncooperative source replacement after backup and before v2 commit", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const original = v1Snapshot();
    const replacement = Buffer.from('{"version":1,"models":{"provider/model":{"failures":[900]}}}');
    fs.writeFileSync(sourcePath, original);
    const store = new ReliabilityV2Store({
      path: statePath,
      config,
      io: {
        writeMigrationBackup(path, bytes) {
          fs.writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
          fs.writeFileSync(sourcePath, replacement);
        },
      },
    });
    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: original, sourcePath, backupPath }), "source_changed");
    assert.deepEqual(fs.readFileSync(backupPath), original);
    assert.deepEqual(fs.readFileSync(sourcePath), replacement);
    assert.equal(fs.existsSync(statePath), false);
  });

  it("times out on an existing source fence without stealing or changing files", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const sourcePath = join(directory, "reliability-v1.json");
    const sourceLockPath = reliabilitySourceFencePath(sourcePath);
    const backupPath = join(directory, "reliability-v1.backup.json");
    const lockBytes = Buffer.from("operator-owned lock\n");
    fs.writeFileSync(sourcePath, v1Snapshot());
    fs.writeFileSync(sourceLockPath, lockBytes);
    const store = new ReliabilityV2Store({ path: statePath, config, lockTimeoutMs: 10, lockPollMs: 1 });
    await migrationError(store.initializeFromV1Migration({ sourceSnapshot: v1Snapshot(), sourcePath, backupPath }), "source_lock_contended");
    assert.deepEqual(fs.readFileSync(sourceLockPath), lockBytes);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(statePath), false);
  });

  it("allows retry after backup creation when the v2 atomic write fails", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const snapshot = v1Snapshot();
    const failing = new ReliabilityV2Store({ path: statePath, config, io: { writeState() { throw new Error("write failed"); } } });

    await migrationError(failing.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath }), "state_write_failed");
    assert.deepEqual(fs.readFileSync(backupPath), snapshot);
    assert.equal(fs.existsSync(statePath), false);

    const retry = new ReliabilityV2Store({ path: statePath, config });
    const result = await retry.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath });
    assert.equal(result.status, "seeded");
    assert.deepEqual(fs.readFileSync(backupPath), snapshot);
  });

  it("serializes concurrent migration attempts and preserves one backup-to-seed binding", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "reliability-v2.json");
    const backupPath = join(directory, "reliability-v1.backup.json");
    const snapshot = v1Snapshot();
    const first = new ReliabilityV2Store({ path: statePath, config, lockTimeoutMs: 1000, lockPollMs: 2 });
    const second = new ReliabilityV2Store({ path: statePath, config, lockTimeoutMs: 1000, lockPollMs: 2 });

    const results = await Promise.all([
      first.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath }),
      second.initializeFromV1Migration({ sourceSnapshot: snapshot, backupPath }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["already_initialized", "seeded"]);
    assert.deepEqual(fs.readFileSync(backupPath), snapshot);
    assert.equal(validateReliabilityV2State(JSON.parse(fs.readFileSync(statePath, "utf8")), config), true);
  });
});
