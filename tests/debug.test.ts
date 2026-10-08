import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { debug, debugMeasure, flushDebug, isDebugEnabled, setupDebug } from "../debug.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("structured debug logger", () => {
  it("can enable a valid path after an earlier directory setup failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-debug-recover-"));
    const blocker = join(directory, "not-a-directory");
    const validPath = join(directory, "recovered", "trace.jsonl");
    try {
      await writeFile(blocker, "file");
      setupDebug({ enabled: true, path: join(blocker, "nested", "trace.jsonl") }, directory);
      assert.equal(isDebugEnabled(), false);

      setupDebug({ enabled: true, path: validPath }, directory);
      assert.equal(isDebugEnabled(), true);
      debug("test", "recovered");
      await flushDebug(1_000);
      const rows = (await readFile(validPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(rows.map((row) => row.event), ["recovered"]);
    } finally {
      setupDebug({ enabled: false, path: validPath }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps overlapping measurements independent and flushes before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-debug-overlap-"));
    const path = join(directory, "trace.jsonl");
    try {
      setupDebug({ enabled: true, path }, directory);
      assert.equal(isDebugEnabled(), true);
      const stopFirst = debugMeasure("test", "same-name");
      await delay(20);
      const stopSecond = debugMeasure("test", "same-name");
      await delay(15);
      stopFirst({ id: "first" });
      await delay(20);
      stopSecond({ id: "second" });
      await flushDebug(1_000);

      const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const measures = rows.filter((row) => row.entryType === "measure");
      assert.equal(measures.length, 2);
      const first = measures.find((row) => row.id === "first");
      const second = measures.find((row) => row.id === "second");
      assert.ok(first && first.duration_ms >= 30);
      assert.ok(second && second.duration_ms >= 30);
      assert.equal(rows.filter((row) => row.id === "first").length, 1);
      const info = await stat(path);
      assert.equal(info.mode & 0o077, 0);
    } finally {
      setupDebug({ enabled: false, path }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight batch on the path captured when its flush started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-debug-path-"));
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    try {
      await writeFile(firstPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
      setupDebug({ enabled: true, path: firstPath }, directory);
      debug("test", "captured-path");
      const draining = flushDebug(1_000);
      setupDebug({ enabled: true, path: secondPath }, directory);
      await draining;

      const firstRows = (await readFile(firstPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(firstRows.map((row) => row.event), ["captured-path"]);
      assert.ok((await stat(`${firstPath}.old`)).size > 10 * 1024 * 1024);
      await assert.rejects(readFile(secondPath, "utf8"));
    } finally {
      setupDebug({ enabled: false, path: secondPath }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps disabled logging off and rotates paths without a jsonl suffix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-debug-rotate-"));
    const path = join(directory, "trace");
    try {
      setupDebug({ enabled: false, path }, directory);
      assert.equal(isDebugEnabled(), false);
      debug("test", "disabled");
      debugMeasure("test", "disabled")();
      await flushDebug(1_000);
      await assert.rejects(readFile(path, "utf8"));

      await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
      setupDebug({ enabled: true, path }, directory);
      debug("test", "after-rotation");
      await flushDebug(1_000);
      const rotated = await stat(`${path}.old`);
      assert.ok(rotated.size > 10 * 1024 * 1024);
      const current = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(current.map((row) => row.event), ["after-rotation"]);
    } finally {
      setupDebug({ enabled: false, path }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops an active measurement stopped after logging is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifrost-debug-disable-measure-"));
    const path = join(directory, "trace.jsonl");
    try {
      setupDebug({ enabled: true, path }, directory);
      const stop = debugMeasure("test", "disabled-before-stop");
      setupDebug({ enabled: false, path }, directory);
      stop({ private: "must-not-be-queued" });
      await flushDebug(1_000);
      await assert.rejects(readFile(path, "utf8"));
    } finally {
      setupDebug({ enabled: false, path }, directory);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
