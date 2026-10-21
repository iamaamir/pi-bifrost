import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  applyReconciliationTransaction,
  ReconciliationStoreError,
  recoverReconciliationTransaction,
  type ApplyReconciliationTransactionInput,
  type ReconciliationStoreOperations,
} from "../reconciliation-store.ts";

const OLD_CONFIG = Buffer.from('{\n  "enabled": true,\n  "models": {"general": ["manual/model"]},\n  "unrelated": {"keep": true}\n}\n');
const NEXT_CONFIG = Buffer.from('{"enabled":true,"models":{"general":["manual/model","openai/gpt-5.4"]},"unrelated":{"keep":true}}\n');
const OLD_OWNERSHIP = Buffer.from('{"version":1,"sources":{"catalog":{"generated":{"general":["openai/old"]},"tombstones":{}}}}\n');
const NEXT_OWNERSHIP = Buffer.from('{"version":1,"sources":{"catalog":{"generated":{"general":["openai/gpt-5.4"]},"tombstones":{}}}}\n');

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function setup(options: { ownership?: Buffer; configMode?: number } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "bifrost-reconcile-"));
  const configPath = join(dir, "pi-bifrost.json");
  const ownershipPath = join(dir, "ownership.json");
  const journalPath = join(dir, "reconcile.journal");
  fs.writeFileSync(configPath, OLD_CONFIG, { mode: options.configMode ?? 0o640 });
  fs.chmodSync(configPath, options.configMode ?? 0o640);
  if (options.ownership) {
    fs.writeFileSync(ownershipPath, options.ownership, { mode: 0o600 });
    fs.chmodSync(ownershipPath, 0o600);
  }
  return {
    dir,
    configPath,
    ownershipPath,
    journalPath,
    paths: { configPath, ownershipPath, journalPath },
    input: (overrides: Partial<ApplyReconciliationTransactionInput> = {}): ApplyReconciliationTransactionInput => ({
      configPath,
      ownershipPath,
      journalPath,
      expectedConfigDigest: hash(OLD_CONFIG),
      expectedOwnershipDigest: options.ownership ? hash(options.ownership) : null,
      nextConfigBytes: NEXT_CONFIG,
      nextOwnershipBytes: NEXT_OWNERSHIP,
      ...overrides,
    }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function operations(options: {
  failWrite?: (path: string) => boolean;
  failFsync?: (path: string) => boolean;
  failRename?: (from: string, to: string) => "before" | "after" | undefined;
  stealLockAfterWrite?: (path: string) => string | undefined;
  stealLockAfterRead?: (path: string) => string | undefined;
  replaceWithSymlinkOnOpen?: { readonly path: string; readonly target: string };
} = {}): ReconciliationStoreOperations {
  const fdPaths = new Map<number, string>();
  let uuid = 0;
  let symlinkInjected = false;
  const native: ReconciliationStoreOperations = {
    realpathSync: (path) => fs.realpathSync(path),
    lstatSync: (path) => fs.lstatSync(path),
    fstatSync: (fd) => fs.fstatSync(fd),
    openSync: (path, flags, mode) => {
      if (!symlinkInjected && options.replaceWithSymlinkOnOpen?.path === path) {
        symlinkInjected = true;
        fs.unlinkSync(path);
        fs.symlinkSync(options.replaceWithSymlinkOnOpen.target, path);
      }
      const fd = fs.openSync(path, flags, mode);
      fdPaths.set(fd, path);
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => {
      const count = fs.readSync(fd, buffer, offset, length, position ?? null);
      const stolen = options.stealLockAfterRead?.(fdPaths.get(fd) ?? "");
      if (stolen) {
        fs.unlinkSync(stolen);
        fs.writeFileSync(stolen, "foreign-lock");
      }
      return count;
    },
    writeFileSync: (fd, data) => {
      const path = fdPaths.get(fd) ?? "";
      if (options.failWrite?.(path)) throw new Error("PRIVATE_INJECTED_WRITE_ERROR");
      fs.writeFileSync(fd, data);
      const stolen = options.stealLockAfterWrite?.(path);
      if (stolen) {
        fs.unlinkSync(stolen);
        fs.writeFileSync(stolen, "foreign-lock");
      }
    },
    fchmodSync: (fd, mode) => fs.fchmodSync(fd, mode),
    fsyncSync: (fd) => {
      const path = fdPaths.get(fd) ?? "";
      if (options.failFsync?.(path)) throw new Error("PRIVATE_INJECTED_FSYNC_ERROR");
      fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      fdPaths.delete(fd);
      fs.closeSync(fd);
    },
    renameSync: (from, to) => {
      const action = options.failRename?.(from, to);
      if (action === "before") throw new Error("PRIVATE_INJECTED_RENAME_ERROR");
      fs.renameSync(from, to);
      if (action === "after") throw new Error("PRIVATE_INJECTED_RENAME_ERROR");
    },
    unlinkSync: (path) => fs.unlinkSync(path),
    randomUUID: () => {
      uuid++;
      return `00000000-0000-4000-8000-${uuid.toString().padStart(12, "0")}`;
    },
  };
  return native;
}

function withSetup<T>(callback: (value: ReturnType<typeof setup>) => T, options: { ownership?: Buffer; configMode?: number } = {}): T {
  const value = setup(options);
  try { return callback(value); } finally { value.cleanup(); }
}

function assertStoreError(run: () => unknown, code: ReconciliationStoreError["code"]): void {
  assert.throws(run, (error: unknown) => error instanceof ReconciliationStoreError && error.code === code);
}

function waitForChildOutput(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => reject(new Error("child readiness deadline exceeded")), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      if (!output.includes(marker)) {
        clearTimeout(timer);
        reject(new Error(`child exited before readiness marker (${child.exitCode}/${child.signalCode}): ${errorOutput.slice(0, 1_000)}`));
      }
    });
  });
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child cleanup deadline exceeded")), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("journaled reconciliation store", () => {
  it("replaces both files atomically, keeps exact private backups, and preserves config mode", () => {
    withSetup(({ paths, input, configPath, ownershipPath }) => {
      const result = applyReconciliationTransaction(input());
      assert.equal(result.status, "committed");
      assert.equal(fs.readFileSync(configPath).toString(), NEXT_CONFIG.toString());
      assert.equal(fs.readFileSync(ownershipPath).toString(), NEXT_OWNERSHIP.toString());
      assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
      assert.equal(fs.statSync(ownershipPath).mode & 0o777, 0o600);
      assert.ok(result.configBackupPath);
      assert.deepEqual(fs.readFileSync(result.configBackupPath), OLD_CONFIG);
      assert.equal(fs.statSync(result.configBackupPath).mode & 0o777, 0o600);
      assert.ok(result.ownershipBackupPath);
      assert.deepEqual(fs.readFileSync(result.ownershipBackupPath), OLD_OWNERSHIP);
      assert.equal(fs.statSync(result.ownershipBackupPath).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(paths.journalPath), false);
      assert.equal(fs.readdirSync(dirname(configPath)).some((name) => name.endsWith(".bifrost-reconcile.lock")), false);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("accepts an absent old sidecar and does not claim a backup for it", () => {
    withSetup(({ input, ownershipPath }) => {
      const result = applyReconciliationTransaction(input());
      assert.equal(result.ownershipBackupPath, undefined);
      assert.equal(fs.readFileSync(ownershipPath).toString(), NEXT_OWNERSHIP.toString());
    });
  });

  it("rejects malformed prospective/current JSON and stale digests before target replacement", () => {
    withSetup(({ input, configPath, ownershipPath, journalPath }) => {
      assertStoreError(() => applyReconciliationTransaction(input({ nextConfigBytes: Buffer.from("{broken") })), "invalid_input");
      assertStoreError(() => applyReconciliationTransaction(input({ nextOwnershipBytes: Buffer.from('{"version":1,"sources":[]}') })), "invalid_input");
      assertStoreError(() => applyReconciliationTransaction(input({ expectedConfigDigest: "0".repeat(64) })), "conflict");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.equal(fs.existsSync(ownershipPath), false);
      assert.equal(fs.existsSync(journalPath), false);
    });
    withSetup(({ input, configPath }) => {
      fs.writeFileSync(configPath, "not json");
      assertStoreError(() => applyReconciliationTransaction(input({ expectedConfigDigest: hash(Buffer.from("not json")) })), "invalid_input");
      assert.equal(fs.readFileSync(configPath).toString(), "not json");
    });
  });

  it("rejects conflicting cross-source generated claims before writing either target", () => {
    withSetup(({ input, configPath, ownershipPath, journalPath }) => {
      const conflicting = Buffer.from(JSON.stringify({ version: 1, sources: {
        source_a: { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
        source_b: { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
      } }));
      assertStoreError(() => applyReconciliationTransaction(input({ nextOwnershipBytes: conflicting })), "invalid_input");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.equal(fs.existsSync(ownershipPath), false);
      assert.equal(fs.existsSync(journalPath), false);
    });
  });

  it("bounds old config reads and rejects a target swapped to a symlink before open", () => {
    withSetup(({ input, configPath, ownershipPath }) => {
      fs.truncateSync(configPath, 10_000_001);
      assertStoreError(() => applyReconciliationTransaction(input()), "invalid_input");
      assert.equal(fs.existsSync(ownershipPath), false);
    });

    withSetup(({ input, configPath, ownershipPath, dir }) => {
      const sentinelPath = join(dir, "sentinel.json");
      const sentinel = Buffer.from("private-sentinel");
      fs.writeFileSync(sentinelPath, sentinel);
      const raced = operations({ replaceWithSymlinkOnOpen: {
        path: join(fs.realpathSync(dir), "pi-bifrost.json"),
        target: sentinelPath,
      } });
      let caught: unknown;
      try { applyReconciliationTransaction(input(), raced); } catch (error) { caught = error; }
      assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
      assert.ok(caught instanceof ReconciliationStoreError, `expected rejection, received ${String(caught)}`);
      assert.ok(caught.code === "io_failure" || caught.code === "conflict");
      assert.deepEqual(fs.readFileSync(sentinelPath), sentinel);
      assert.equal(fs.existsSync(ownershipPath), false);
    });
  });

  it("rejects overlapping paths and symlink targets", () => {
    withSetup(({ input, paths, configPath, dir }) => {
      assertStoreError(() => applyReconciliationTransaction(input({ ownershipPath: configPath })), "invalid_input");
      assertStoreError(() => applyReconciliationTransaction(input({ journalPath: `${configPath}.bifrost-reconcile.lock` })), "invalid_input");
      const target = join(dir, "target.json");
      fs.symlinkSync(configPath, target);
      assertStoreError(() => applyReconciliationTransaction(input({ configPath: target })), "invalid_input");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.equal(fs.existsSync(paths.journalPath), false);
    });
  });

  it("refuses a preexisting cooperative lock without deleting it", () => {
    withSetup(({ input, paths, configPath }) => {
      const lockPath = `${paths.configPath}.bifrost-reconcile.lock`;
      fs.writeFileSync(lockPath, "foreign-lock");
      assertStoreError(() => applyReconciliationTransaction(input()), "locked");
      assert.equal(fs.readFileSync(lockPath).toString(), "foreign-lock");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      fs.unlinkSync(lockPath);
    });
  });

  it("does not delete a preexisting backup-name collision", () => {
    withSetup(({ input, paths, configPath }) => {
      const transactionId = "00000000-0000-4000-8000-000000000004";
      const backupPath = join(dirname(configPath), `.${"pi-bifrost.json"}.${transactionId}.config.backup`);
      const collision = Buffer.from("foreign backup sentinel");
      fs.writeFileSync(backupPath, collision, { flag: "wx" });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), operations()), "io_failure");
      assert.deepEqual(fs.readFileSync(backupPath), collision);
      assert.equal(recoverReconciliationTransaction(paths).status, "aborted");
      assert.deepEqual(fs.readFileSync(backupPath), collision);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("recovers old/old by aborting and removing only recorded transaction files", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "before" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      const result = recoverReconciliationTransaction(paths);
      assert.equal(result.status, "aborted");
      assert.equal(fs.existsSync(paths.journalPath), false);
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("recovers config-new/ownership-old by advancing only verified staged ownership bytes", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      assert.equal(recoverReconciliationTransaction(paths).status, "completed");
      assert.deepEqual(fs.readFileSync(ownershipPath), NEXT_OWNERSHIP);
      assert.equal(fs.existsSync(paths.journalPath), false);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("finalizes new/new after a crash after the ownership rename", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".ownership.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), NEXT_OWNERSHIP);
      assert.equal(recoverReconciliationTransaction(paths).status, "completed");
      assert.equal(fs.existsSync(paths.journalPath), false);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("leaves unknown manual edits and the journal untouched as a conflict", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const manualEdit = Buffer.from('{"models":{"manual/new":[]}}\n');
      fs.writeFileSync(configPath, manualEdit);
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), manualEdit);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      assert.equal(fs.existsSync(paths.journalPath), true);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("does not advance ownership when the journal lacks the staged-file identity", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const journal = JSON.parse(fs.readFileSync(paths.journalPath, "utf8")) as {
        ownership: Record<string, unknown>;
      };
      delete journal.ownership.stageIdentity;
      fs.writeFileSync(paths.journalPath, JSON.stringify(journal));
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("rejects unknown journal and target fields during recovery without changing either target", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const journal = JSON.parse(fs.readFileSync(paths.journalPath, "utf8")) as Record<string, unknown>;
      journal.privateSentinel = "must-not-be-accepted";
      fs.writeFileSync(paths.journalPath, JSON.stringify(journal));
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
    }, { ownership: OLD_OWNERSHIP });

    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const journal = JSON.parse(fs.readFileSync(paths.journalPath, "utf8")) as {
        ownership: Record<string, unknown>;
      };
      journal.ownership.unexpected = "extra-target-field";
      fs.writeFileSync(paths.journalPath, JSON.stringify(journal));
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("does not advance to a staged ownership payload with duplicate cross-source claims", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const journal = JSON.parse(fs.readFileSync(paths.journalPath, "utf8")) as {
        ownership: { stageName: string; nextDigest: string };
      };
      const staged = join(dirname(paths.ownershipPath), journal.ownership.stageName);
      const invalidOwnership = Buffer.from(JSON.stringify({ version: 1, sources: {
        source_a: { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
        source_b: { generated: { general: ["openai/gpt-5.4"] }, tombstones: {} },
      } }));
      fs.writeFileSync(staged, invalidOwnership);
      journal.ownership.nextDigest = hash(invalidOwnership);
      fs.writeFileSync(paths.journalPath, JSON.stringify(journal));
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      assert.deepEqual(fs.readFileSync(staged), invalidOwnership);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("stops apply when a lock is replaced during staging", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const configLock = `${paths.configPath}.bifrost-reconcile.lock`;
      const stolen = operations({
        stealLockAfterWrite: (path) => path.endsWith(".ownership.stage") ? configLock : undefined,
      });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), stolen), "conflict");
      assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      assert.equal(fs.readFileSync(configLock, "utf8"), "foreign-lock");
      fs.unlinkSync(configLock);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("does not let recovery replace ownership after a held lock is replaced", () => {
    withSetup(({ input, paths, configPath, ownershipPath }) => {
      const fault = operations({ failRename: (from) => from.endsWith(".config.stage") ? "after" : undefined });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const configLock = `${paths.configPath}.bifrost-reconcile.lock`;
      const stolen = operations({
        stealLockAfterRead: (path) => path.endsWith(".ownership.stage") ? configLock : undefined,
      });
      assert.equal(recoverReconciliationTransaction(paths, stolen).status, "conflict");
      assert.deepEqual(fs.readFileSync(configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      assert.equal(fs.readFileSync(configLock, "utf8"), "foreign-lock");
      fs.unlinkSync(configLock);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("requires verified stale-lock repair before recovering after a real writer crash", async () => {
    const value = setup({ ownership: OLD_OWNERSHIP });
    let child: ChildProcess | undefined;
    try {
      const storeUrl = pathToFileURL(join(process.cwd(), "reconciliation-store.ts")).href;
      const input = value.input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) });
      const childProgram = `
        import fs from "node:fs";
        import { randomUUID } from "node:crypto";
        const journalPath = ${JSON.stringify(join(fs.realpathSync(dirname(value.journalPath)), "reconcile.journal"))};
        const configPath = ${JSON.stringify(value.configPath)};
        const operations = {
          realpathSync: (path) => fs.realpathSync(path),
          lstatSync: (path) => fs.lstatSync(path),
          fstatSync: (fd) => fs.fstatSync(fd),
          openSync: (path, flags, mode) => fs.openSync(path, flags, mode),
          readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
          writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
          fchmodSync: (fd, mode) => fs.fchmodSync(fd, mode),
          fsyncSync: (fd) => fs.fsyncSync(fd),
          closeSync: (fd) => fs.closeSync(fd),
          renameSync: (from, to) => {
          const result = fs.renameSync(from, to);
          if (String(to) === journalPath && String(from).endsWith(".journal-tmp")
            && JSON.parse(fs.readFileSync(journalPath, "utf8")).phase === "config_installed") {
            process.stdout.write("CONFIG_INSTALLED\\n");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
          }
          return result;
          },
          unlinkSync: (path) => fs.unlinkSync(path),
          randomUUID,
        };
        const { applyReconciliationTransaction } = await import(${JSON.stringify(storeUrl)});
        applyReconciliationTransaction({
          configPath,
          ownershipPath: ${JSON.stringify(value.ownershipPath)},
          journalPath,
          expectedConfigDigest: ${JSON.stringify(input.expectedConfigDigest)},
          expectedOwnershipDigest: ${JSON.stringify(input.expectedOwnershipDigest)},
          nextConfigBytes: Buffer.from(${JSON.stringify(NEXT_CONFIG.toString("base64"))}, "base64"),
          nextOwnershipBytes: Buffer.from(${JSON.stringify(NEXT_OWNERSHIP.toString("base64"))}, "base64"),
        }, operations);
      `;
      child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childProgram], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForChildOutput(child, "CONFIG_INSTALLED\n", 5_000);
      child.kill("SIGKILL");
      await waitForChildClose(child, 5_000);
      child = undefined;

      const journal = JSON.parse(fs.readFileSync(value.journalPath, "utf8")) as {
        phase: string;
        config: { backupName: string };
        ownership: { backupName: string };
      };
      assert.equal(journal.phase, "config_installed");
      assert.deepEqual(fs.readFileSync(value.configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(value.ownershipPath), OLD_OWNERSHIP);
      assert.deepEqual(fs.readFileSync(join(dirname(value.configPath), journal.config.backupName)), OLD_CONFIG);
      assert.deepEqual(fs.readFileSync(join(dirname(value.ownershipPath), journal.ownership.backupName)), OLD_OWNERSHIP);

      const lockPaths = [value.configPath, value.ownershipPath, value.journalPath]
        .map((path) => `${path}.bifrost-reconcile.lock`);
      for (const lockPath of lockPaths) {
        assert.match(fs.readFileSync(lockPath, "utf8"), /^[a-f0-9-]{36}$/u);
      }
      assertStoreError(() => recoverReconciliationTransaction(value.paths), "locked");
      assert.deepEqual(fs.readFileSync(value.configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(value.ownershipPath), OLD_OWNERSHIP);
      assert.equal(fs.existsSync(value.journalPath), true);

      // Operator repair prerequisite: after confirming the child is gone and
      // every lock belongs to that dead writer, remove these exact stale files.
      for (const lockPath of lockPaths) fs.unlinkSync(lockPath);
      assert.equal(recoverReconciliationTransaction(value.paths).status, "completed");
      assert.deepEqual(fs.readFileSync(value.configPath), NEXT_CONFIG);
      assert.deepEqual(fs.readFileSync(value.ownershipPath), NEXT_OWNERSHIP);
      assert.equal(fs.existsSync(value.journalPath), false);
      assert.deepEqual(fs.readFileSync(join(dirname(value.configPath), journal.config.backupName)), OLD_CONFIG);
      assert.deepEqual(fs.readFileSync(join(dirname(value.ownershipPath), journal.ownership.backupName)), OLD_OWNERSHIP);
      assert.equal(lockPaths.some((path) => fs.existsSync(path)), false);
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await waitForChildClose(child, 5_000);
      }
      value.cleanup();
    }
  });

  it("does not delete an externally replaced stage file during recovery cleanup", () => {
    withSetup(({ input, paths }) => {
      const fault = operations({
        failRename: (from) => from.endsWith(".config.stage") ? "before" : undefined,
      });
      assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), fault), "io_failure");
      const journal = JSON.parse(fs.readFileSync(paths.journalPath, "utf8")) as { config: { stageName: string } };
      const stagePath = join(dirname(paths.configPath), journal.config.stageName);
      const foreign = Buffer.from("foreign stage sentinel");
      fs.unlinkSync(stagePath);
      fs.writeFileSync(stagePath, foreign, { flag: "wx" });
      assert.equal(recoverReconciliationTransaction(paths).status, "conflict");
      assert.deepEqual(fs.readFileSync(stagePath), foreign);
      assert.equal(fs.existsSync(paths.journalPath), true);
    }, { ownership: OLD_OWNERSHIP });
  });

  it("fails closed on write and fsync errors while preserving both original targets", () => {
    for (const [kind, injection] of [
      ["write", (path: string) => path.endsWith(".ownership.stage")],
      ["fsync", (path: string) => path.endsWith(".config.stage")],
    ] as const) {
      withSetup(({ input, paths, configPath, ownershipPath }) => {
        const failing = kind === "write"
          ? operations({ failWrite: injection })
          : operations({ failFsync: injection });
        assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), failing), "io_failure");
        assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
        assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
        const recovered = recoverReconciliationTransaction(paths);
        assert.equal(recovered.status, "aborted");
        assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
        assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      }, { ownership: OLD_OWNERSHIP });
    }
  });

  it("fault-injects every lock, journal, backup, and staged-payload write/fsync boundary", () => {
    const boundaries = [
      { label: "lock", matches: (path: string) => path.endsWith(".bifrost-reconcile.lock") },
      { label: "initial journal", matches: (path: string) => path.endsWith("/reconcile.journal") },
      { label: "journal update temp", matches: (path: string) => path.endsWith(".journal-tmp") },
      { label: "config backup", matches: (path: string) => path.endsWith(".config.backup") },
      { label: "ownership backup", matches: (path: string) => path.endsWith(".ownership.backup") },
      { label: "config stage", matches: (path: string) => path.endsWith(".config.stage") },
      { label: "ownership stage", matches: (path: string) => path.endsWith(".ownership.stage") },
    ];
    for (const kind of ["write", "fsync"] as const) {
      for (const boundary of boundaries) {
        withSetup(({ input, paths, configPath, ownershipPath }) => {
          const injected = kind === "write"
            ? operations({ failWrite: boundary.matches })
            : operations({ failFsync: boundary.matches });
          assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), injected), "io_failure");
          assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG, `${kind} failure at ${boundary.label} changed config`);
          assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP, `${kind} failure at ${boundary.label} changed ownership`);
          const recovery = recoverReconciliationTransaction(paths);
          assert.ok(["nothing_to_recover", "aborted"].includes(recovery.status), `${kind} failure at ${boundary.label} did not recover old/old`);
          assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
          assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
        }, { ownership: OLD_OWNERSHIP });
      }
    }
  });

  it("fault-injects journal-temp rename before and after replacement", () => {
    for (const point of ["before", "after"] as const) {
      withSetup(({ input, paths, configPath, ownershipPath }) => {
        const injected = operations({
          failRename: (from) => from.endsWith(".journal-tmp") ? point : undefined,
        });
        assertStoreError(() => applyReconciliationTransaction(input({ expectedOwnershipDigest: hash(OLD_OWNERSHIP) }), injected), "io_failure");
        assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
        assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
        const result = recoverReconciliationTransaction(paths);
        assert.ok(["nothing_to_recover", "aborted"].includes(result.status));
        assert.deepEqual(fs.readFileSync(configPath), OLD_CONFIG);
        assert.deepEqual(fs.readFileSync(ownershipPath), OLD_OWNERSHIP);
      }, { ownership: OLD_OWNERSHIP });
    }
  });

  it("never serializes raw injected errors into its public error", () => {
    withSetup(({ input }) => {
      const failing = operations({ failWrite: (path) => path.endsWith(".config.stage") });
      let caught: unknown;
      try { applyReconciliationTransaction(input(), failing); } catch (error) { caught = error; }
      assert.ok(caught instanceof ReconciliationStoreError);
      assert.equal(caught.message.includes("PRIVATE_INJECTED"), false);
      assert.equal(caught.code, "io_failure");
    });
  });
});
