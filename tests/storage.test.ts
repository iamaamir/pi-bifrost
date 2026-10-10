import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  chmodSync,
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJsonFile,
  resolveStoragePath,
  writeJsonFile,
  writeTextFile,
  writeTextFileWithOperations,
  type AtomicWriteOperations,
} from "../storage.ts";

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp") && name.startsWith("."));
}

describe("storage", () => {
  it("resolves absolute, tilde, relative, and default paths", () => {
    const cwd = "/project";
    const home = process.env.HOME;
    process.env.HOME = "/home/user";
    try {
      assert.equal(resolveStoragePath(cwd, undefined, ".pi/state.json"), "/project/.pi/state.json");
      assert.equal(resolveStoragePath(cwd, "/var/lib/state.json", ".pi/state.json"), "/var/lib/state.json");
      assert.equal(resolveStoragePath(cwd, "~/state.json", ".pi/state.json"), "/home/user/state.json");
      assert.equal(resolveStoragePath(cwd, "state.json", ".pi/state.json"), "/project/state.json");
    } finally {
      process.env.HOME = home;
    }
  });

  it("writes and reads json files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "nested", "state.json");
      writeJsonFile(path, { ok: true, count: 2 });
      assert.deepEqual(readJsonFile<{ ok: boolean; count: number }>(path), { ok: true, count: 2 });
      assert.equal(readJsonFile(join(cwd, "missing.json")), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("atomically replaces an existing file and preserves its permission bits", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "state.json");
      writeFileSync(path, "old complete value", { mode: 0o600 });
      chmodSync(path, 0o640);

      writeTextFile(path, "new complete value");

      assert.equal(readFileSync(path, "utf-8"), "new complete value");
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o640);
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates new managed files with private permissions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "new-state.json");
      writeTextFile(path, "private state");

      assert.equal(readFileSync(path, "utf-8"), "private state");
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a symlink target without changing its referent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const referent = join(cwd, "referent.json");
      const link = join(cwd, "state.json");
      writeFileSync(referent, "keep this");
      symlinkSync(referent, link);

      assert.throws(() => writeTextFile(link, "replacement"), /Refusing to replace symlink/);
      assert.equal(readFileSync(referent, "utf-8"), "keep this");
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the old target and cleans its temp after a partial write failure", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "state.json");
      writeFileSync(path, "valid old state");
      const operations: Partial<AtomicWriteOperations> = {
        writeFileSync: ((fd: number) => {
          writeFileSync(fd, "partial new state", "utf-8");
          throw new Error("injected write failure");
        }) as AtomicWriteOperations["writeFileSync"],
      };

      assert.throws(
        () => writeTextFileWithOperations(path, "complete new state", operations),
        /injected write failure/,
      );
      assert.equal(readFileSync(path, "utf-8"), "valid old state");
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the old target and cleans its temp after a file sync failure", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "state.json");
      writeFileSync(path, "valid old state");
      assert.throws(
        () => writeTextFileWithOperations(path, "complete new state", {
          fsyncSync: (() => { throw new Error("injected file fsync failure"); }) as AtomicWriteOperations["fsyncSync"],
        }),
        /injected file fsync failure/,
      );
      assert.equal(readFileSync(path, "utf-8"), "valid old state");
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("preserves the write error when owned temp cleanup also fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    const path = join(cwd, "state.json");
    const sensitiveDetail = "sensitive temp path detail";
    const warnings: Array<Error & { code?: string }> = [];
    const onWarning = (warning: Error & { code?: string }) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      writeFileSync(path, "valid old state");
      assert.throws(
        () => writeTextFileWithOperations(path, "complete new state", {
          writeFileSync: (() => { throw new Error("injected primary write failure"); }) as AtomicWriteOperations["writeFileSync"],
          unlinkSync: (() => { throw new Error(sensitiveDetail); }) as AtomicWriteOperations["unlinkSync"],
        }),
        /injected primary write failure/,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(readFileSync(path, "utf-8"), "valid old state");
      assert.equal(tempFiles(cwd).length, 1);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.code, "BIFROST_STORAGE_CLEANUP");
      assert.doesNotMatch(warnings[0]?.message ?? "", /sensitive|state\.json|tmp/);
    } finally {
      process.off("warning", onWarning);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("warns when directory sync fails after the replacement has committed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    const path = join(cwd, "state.json");
    const warnings: Array<Error & { code?: string }> = [];
    const onWarning = (warning: Error & { code?: string }) => warnings.push(warning);
    let syncCount = 0;
    process.on("warning", onWarning);
    try {
      writeFileSync(path, "valid old state");
      writeTextFileWithOperations(path, "committed new state", {
        fsyncSync: ((fd: number) => {
          syncCount += 1;
          if (syncCount === 1) fsyncSync(fd);
          else throw new Error("sensitive directory sync detail");
        }) as AtomicWriteOperations["fsyncSync"],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(readFileSync(path, "utf-8"), "committed new state");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.code, "BIFROST_STORAGE_DIRSYNC");
      assert.doesNotMatch(warnings[0]?.message ?? "", /sensitive|state\.json|tmp/);
    } finally {
      process.off("warning", onWarning);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the old target and cleans its temp after rename failure", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "state.json");
      writeFileSync(path, "valid old state");

      assert.throws(
        () => writeTextFileWithOperations(path, "complete new state", {
          renameSync: (() => { throw new Error("injected rename failure"); }) as AtomicWriteOperations["renameSync"],
        }),
        /injected rename failure/,
      );
      assert.equal(readFileSync(path, "utf-8"), "valid old state");
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps concurrent same-path writes whole and uses collision-free temps", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    const path = join(cwd, "shared-state.json");
    const first = "a".repeat(128 * 1024);
    const second = "b".repeat(128 * 1024);
    writeFileSync(path, first);
    const storageUrl = new URL("../storage.ts", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { writeTextFile } = await import(workerData.storageUrl);
        parentPort.postMessage("ready");
        await new Promise((resolve) => parentPort.once("message", resolve));
        for (let i = 0; i < 24; i += 1) writeTextFile(workerData.path, workerData.text);
        parentPort.postMessage("done");
      })().catch((error) => parentPort.postMessage({ error: String(error) }));
    `;
    const workers = [first, second].map((text) => new Worker(workerSource, {
      eval: true,
      execArgv: ["--experimental-strip-types"],
      workerData: { path, text, storageUrl },
    }));
    let invalidRead: string | undefined;
    const observer = setInterval(() => {
      const contents = readFileSync(path, "utf-8");
      if (contents !== first && contents !== second) invalidRead = `observed ${contents.length} bytes of a partial value`;
    }, 1);
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => message === "ready" ? resolve() : reject(new Error(String(message))));
        worker.once("error", reject);
      })));
      for (const worker of workers) worker.postMessage("go");
      const completion = Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        let completed = false;
        worker.on("message", (message) => {
          if (message === "done") {
            completed = true;
            resolve();
          }
          else if (typeof message === "object" && message !== null && "error" in message) reject(new Error(String(message.error)));
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!completed) reject(new Error(`writer worker exited with ${code} before reporting done`));
        });
      })));
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("concurrent storage writers exceeded 10-second deadline")), 10_000);
      });
      await Promise.race([completion, timeout]);
      assert.equal(invalidRead, undefined);
      assert.ok([first, second].includes(readFileSync(path, "utf-8")));
      assert.deepEqual(tempFiles(cwd), []);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      clearInterval(observer);
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
