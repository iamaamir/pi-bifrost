import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  admitReliabilityV2Dispatch,
  emptyReliabilityV2State,
  modelScopeKey,
  validateReliabilityV2State,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "../reliability-v2.ts";
import { normalizeFailureObservation } from "../failure-observations.ts";
import {
  ReliabilityV2Store,
  ReliabilityV2StoreError,
} from "../reliability-v2-store.ts";
import { writeJsonFile, writeTextFileWithOperations } from "../storage.ts";

const config: ReliabilityV2Config = {
  failureThreshold: 1,
  windowMs: 60_000,
  cooldownMs: 10,
  leaseTtlMs: 120_000,
  maxDispatchLifetimeMs: 600_000,
  dedupRetentionMs: 600_000,
  maxDedupEntries: 64,
  maxDispatchReceipts: 64,
};

const temporaryDirectories: string[] = [];
const CHILD_DEADLINE_MS = 10_000;
const CHILD_OUTPUT_LIMIT = 16 * 1024;

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "bifrost-v2-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readState(path: string): ReliabilityV2State {
  return JSON.parse(fs.readFileSync(path, "utf8")) as ReliabilityV2State;
}

function errorCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReliabilityV2StoreError);
    assert.equal(error.code, code);
    return true;
  });
}

function childAdmission(path: string, modelKey: string, id: string): Promise<string> {
  const moduleUrl = new URL("../reliability-v2-store.ts", import.meta.url).href;
  const code = `
    const { ReliabilityV2Store } = await import(${JSON.stringify(moduleUrl)});
    const config = ${JSON.stringify(config)};
    const store = new ReliabilityV2Store({ path: process.argv[1], config, lockTimeoutMs: 2000, lockPollMs: 5 });
    const result = await store.admit({ ownerToken: "owner-" + process.argv[3], dispatchId: "dispatch-" + process.argv[3], outcomeId: "outcome-" + process.argv[3], modelKeys: [process.argv[2]] });
    process.stdout.write(result.status);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, path, modelKey, id], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let terminationReason: Error | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => terminate(new Error(`child exceeded ${CHILD_DEADLINE_MS}ms deadline`)), CHILD_DEADLINE_MS);
    const clearTimers = () => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
    };
    const terminate = (reason: Error) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      capturedBytes += chunk.byteLength;
      if (capturedBytes > CHILD_OUTPUT_LIMIT) {
        terminate(new Error(`child output exceeded ${CHILD_OUTPUT_LIMIT} byte limit`));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => {
      clearTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (status, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (terminationReason) reject(terminationReason);
      else if (status === 0) resolve(stdout);
      else reject(new Error(`child failed (${status ?? signal}): ${stderr}`));
    });
  });
}

function releaseLiveLockSoon(path: string): void {
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ ownerToken: "test-owner", pid: process.pid, createdAt: Date.now() }));
  setTimeout(() => fs.unlinkSync(`${path}.lock`), 40);
}

describe("experimental reliability v2 file transactions", () => {
  it("serializes separate processes and reloads each latest state before mutation", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const models = Array.from({ length: 8 }, (_, index) => `provider/model-${index}`);
    const statuses = await Promise.all(models.map((model, index) => childAdmission(path, model, String(index))));
    assert.ok(statuses.every((status) => status === "admitted"));

    const state = readState(path);
    assert.equal(validateReliabilityV2State(state, config), true);
    assert.equal(state.revision, models.length, JSON.stringify({ statuses, dispatches: Object.keys(state.dispatches) }));
    assert.equal(Object.keys(state.dispatches).length, models.length, JSON.stringify({ statuses, dispatches: Object.keys(state.dispatches), scopes: Object.keys(state.scopes) }));
    assert.deepEqual(Object.keys(state.scopes).sort(), models.map((model) => modelScopeKey(model)).sort());
  });

  it("allows exactly one process to take a half-open model lease", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const state = emptyReliabilityV2State();
    state.scopes[modelScopeKey("provider/model")] = { generation: 1, failures: [1], openUntil: Date.now() - 10 };
    fs.writeFileSync(path, JSON.stringify(state));

    const statuses = await Promise.all([
      childAdmission(path, "provider/model", "a"),
      childAdmission(path, "provider/model", "b"),
    ]);
    assert.equal(statuses.filter((status) => status === "admitted").length, 1);
    assert.equal(statuses.filter((status) => status === "blocked").length, 1);
    assert.equal(validateReliabilityV2State(readState(path), config), true);
  });

  it("fails closed on a dead-owner orphan lock and leaves it for explicit repair", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const lockPath = `${path}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ ownerToken: "prior-owner", pid: 2_000_000_000, createdAt: 1 }));
    const store = new ReliabilityV2Store({ path, config, lockTimeoutMs: 0 });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "orphan_lock");
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fs.existsSync(path), false);
  });

  it("requires initialized state for runtime snapshots and admission when configured", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const store = new ReliabilityV2Store({ path, config, requireInitialized: true });

    assert.throws(() => store.readSnapshot(), (error: unknown) => error instanceof ReliabilityV2StoreError && error.code === "uninitialized_state");
    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "uninitialized_state");
    assert.equal(fs.existsSync(path), false);
  });

  it("reads a detached latest snapshot without writing and fails admission after sidecar deletion", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const writer = new ReliabilityV2Store({ path, config });
    const reader = new ReliabilityV2Store({ path, config, requireInitialized: true });
    const admitted = await writer.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] });
    assert.equal(admitted.status, "admitted");
    const before = fs.readFileSync(path);
    const lockPath = `${path}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ ownerToken: "unrelated-live-owner", pid: process.pid, createdAt: Date.now() }));
    const snapshot = reader.readSnapshot();
    assert.equal(snapshot.revision, 1);
    assert.equal(Object.keys(snapshot.dispatches).length, 1);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(fs.readFileSync(path), before);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).ownerToken, "unrelated-live-owner");

    fs.unlinkSync(lockPath);
    fs.unlinkSync(path);
    await errorCode(reader.admit({ ownerToken: "owner-next", dispatchId: "dispatch-next", outcomeId: "outcome-next", modelKeys: ["provider/model"] }), "uninitialized_state");
    assert.equal(fs.existsSync(path), false);
  });

  it("reports live and malformed locks without taking ownership", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const lockPath = `${path}.lock`;
    const store = new ReliabilityV2Store({ path, config, lockTimeoutMs: 0 });
    fs.writeFileSync(lockPath, JSON.stringify({ ownerToken: "live-owner", pid: process.pid, createdAt: Date.now() }));
    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "live-dispatch", outcomeId: "live-outcome", modelKeys: ["provider/model"] }), "lock_contended");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).ownerToken, "live-owner");

    fs.writeFileSync(lockPath, "not a lock record");
    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "bad-dispatch", outcomeId: "bad-outcome", modelKeys: ["provider/model"] }), "invalid_lock");
    assert.equal(fs.readFileSync(lockPath, "utf8"), "not a lock record");
  });

  it("rejects a symlink lock instead of following or deleting it", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const linked = join(directory, "linked-lock.json");
    const contents = JSON.stringify({ ownerToken: "other-owner", pid: process.pid, createdAt: Date.now() });
    fs.writeFileSync(linked, contents);
    fs.symlinkSync(linked, `${path}.lock`);
    const store = new ReliabilityV2Store({ path, config, lockTimeoutMs: 0 });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "invalid_lock");
    assert.equal(fs.readFileSync(linked, "utf8"), contents);
    assert.equal(fs.lstatSync(`${path}.lock`).isSymbolicLink(), true);
  });

  it("rejects corrupt state without replacing it with an empty store", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const corrupt = "{ definitely not json";
    fs.writeFileSync(path, corrupt);
    const store = new ReliabilityV2Store({ path, config });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "corrupt_state");
    assert.equal(fs.readFileSync(path, "utf8"), corrupt);
  });

  it("rejects a symlink state target without touching the linked file", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const linked = join(directory, "linked.json");
    const contents = JSON.stringify(emptyReliabilityV2State());
    fs.writeFileSync(linked, contents);
    fs.symlinkSync(linked, path);
    const store = new ReliabilityV2Store({ path, config });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "unsafe_state_target");
    assert.equal(fs.readFileSync(linked, "utf8"), contents);
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
  });

  it("preserves the prior state when atomic rename fails", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const original = JSON.stringify(emptyReliabilityV2State()) + "\n";
    fs.writeFileSync(path, original);
    const store = new ReliabilityV2Store({
      path,
      config,
      io: {
        writeState: (target, state) => writeTextFileWithOperations(target, `${JSON.stringify(state)}\n`, {
          renameSync() { throw new Error("simulated rename failure"); },
        }),
      },
    });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "state_write_failed");
    assert.equal(fs.readFileSync(path, "utf8"), original);
    assert.equal(validateReliabilityV2State(readState(path), config), true);
  });

  it("removes only its newly created lock when lock metadata writing fails", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const store = new ReliabilityV2Store({ path, config, io: { writeLock() { throw new Error("simulated lock write failure"); } } });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "lock_create_failed");
    assert.equal(fs.existsSync(`${path}.lock`), false);
    assert.equal(fs.existsSync(path), false);
  });

  it("does not remove a replaced lock or return an admission after ownership is lost", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    let replaced = false;
    const store = new ReliabilityV2Store({
      path,
      config,
      io: {
        writeState(target, state) {
          writeJsonFile(target, state);
          const lockPath = `${target}.lock`;
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, JSON.stringify({ ownerToken: "other-owner", pid: process.pid, createdAt: Date.now() }));
          replaced = true;
        },
      },
    });

    await errorCode(store.admit({ ownerToken: "owner", dispatchId: "dispatch", outcomeId: "outcome", modelKeys: ["provider/model"] }), "lock_owner_lost");
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(`${path}.lock`), true);
    assert.equal(JSON.parse(fs.readFileSync(`${path}.lock`, "utf8")).ownerToken, "other-owner");
  });

  it("snapshots mutable caller inputs and config before waiting for the lock", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const mutableConfig = { ...config };
    const store = new ReliabilityV2Store({ path, config: mutableConfig, lockTimeoutMs: 1000, lockPollMs: 5 });
    const modelKeys = ["provider/original"];
    releaseLiveLockSoon(path);
    const admission = store.admit({ ownerToken: "owner-a", dispatchId: "dispatch-a", outcomeId: "outcome-a", modelKeys });
    modelKeys[0] = "provider/changed";
    mutableConfig.failureThreshold = 0;
    const admitted = await admission;
    assert.equal(admitted.status, "admitted");
    assert.ok(admitted.state.scopes[modelScopeKey("provider/original")]);
    assert.equal(admitted.state.scopes[modelScopeKey("provider/changed")], undefined);

    const halfOpen = emptyReliabilityV2State();
    halfOpen.scopes[modelScopeKey("provider/lease")] = { generation: 1, failures: [1], openUntil: Date.now() - 10 };
    const initial = admitReliabilityV2Dispatch(halfOpen, {
      ownerToken: "owner-b", dispatchId: "dispatch-b", outcomeId: "outcome-b", modelKeys: ["provider/lease"], now: Date.now(),
    }, config);
    assert.equal(initial.status, "admitted");
    fs.writeFileSync(path, JSON.stringify(initial.state));
    const references = initial.leases!;
    releaseLiveLockSoon(path);
    const renewing = store.renew({ ownerToken: "owner-b", dispatchId: "dispatch-b", outcomeId: "outcome-b", leaseReferences: references });
    references[0]!.generation += 1;
    const renewed = await renewing;
    assert.equal(renewed.status, "renewed");

    const settlement = { kind: "success" as const };
    releaseLiveLockSoon(path);
    const settling = store.settle({ ownerToken: "owner-b", dispatchId: "dispatch-b", outcomeId: "outcome-b", settlement });
    (settlement as { kind: "success" | "failure" }).kind = "failure";
    const settled = await settling;
    assert.equal(settled.status, "settled");
    assert.equal(settled.state.dispatches["dispatch-b"]?.settledKind, "success");
  });

  it("clones a normalized observation before waiting for the settlement lock", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    const store = new ReliabilityV2Store({ path, config, lockTimeoutMs: 1000, lockPollMs: 5 });
    const admitted = await store.admit({
      ownerToken: "owner-observation", dispatchId: "dispatch-observation", outcomeId: "outcome-observation",
      modelKeys: ["provider/model"],
    });
    assert.equal(admitted.status, "admitted");
    const observedAt = Date.now();
    const observation = normalizeFailureObservation({
      outcomeId: "outcome-observation", modelKey: "provider/model", source: "runtime", observedAt,
      structured: { category: "transport" },
    }, { now: observedAt })!;
    releaseLiveLockSoon(path);
    const settling = store.settle({
      ownerToken: "owner-observation", dispatchId: "dispatch-observation", outcomeId: "outcome-observation",
      settlement: { kind: "failure", observation },
    });
    (observation as { category: string }).category = "unknown";
    (observation as { scope: { kind: "model"; modelKey: string } }).scope.modelKey = "provider/changed";
    const result = await settling;
    assert.equal(result.status, "settled");
    assert.equal(result.state.settledOutcomes["outcome-observation"]?.observation?.category, "transport");
    assert.equal(result.state.settledOutcomes["outcome-observation"]?.observation?.modelKey, "provider/model");
  });
});
