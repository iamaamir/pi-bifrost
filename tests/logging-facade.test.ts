import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bindDebugSession,
  debug,
  debugLoggerStats,
  debugMeasure,
  endDebugSession,
  flushDebug,
  isDebugEnabled,
  setupDebug,
  setupDebugForSession,
} from "../debug.ts";

async function logFiles(cwd: string): Promise<string[]> {
  const root = join(cwd, ".pi", "bifrost", "logs");
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function rows(paths: readonly string[]): Promise<Array<Record<string, unknown> & { file: string }>> {
  const output: Array<Record<string, unknown> & { file: string }> = [];
  for (const path of paths) {
    const contents = await readFile(path, "utf8").catch(() => "");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      output.push({ ...(JSON.parse(line) as Record<string, unknown>), file: path });
    }
  }
  return output;
}

describe("debug facade with session-scoped storage", () => {
  it("writes a run file under the bound session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-session-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-1" }) });
      debug("router", "selected", { model: "provider/model" }, { level: "info" });
      await flushDebug(1_000);
      assert.equal(isDebugEnabled(), true);
      const files = await logFiles(cwd);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /sess-1[\\/]main[\\/].+\.jsonl$/);
      const [row] = await rows(files);
      assert.equal(row!.event, "selected");
      assert.equal(row!.level, "info");
      assert.equal(row!.session_id, "sess-1");
      assert.equal(row!.root_session_id, "sess-1");
      assert.equal(typeof row!.run_id, "string");
      assert.equal(debugLoggerStats()?.batchesWritten, 1);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adopts startup events once the session is known", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-boot-"));
    try {
      setupDebug({ enabled: true }, cwd);
      debug("bifrost", "startup", { phase: "boot" }, { level: "info", protected: true });
      bindDebugSession({ getHeader: () => ({ id: "sess-boot" }) });
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /sess-boot[\\/]main[\\/]/);
      const output = await rows(files);
      assert.deepEqual(output.map((row) => row.event), ["startup"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns contextless events to an unattributed run after the session ends", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-end-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-end" }) });
      debug("router", "in-session");
      await flushDebug(1_000);
      endDebugSession();
      debug("router", "after-session");
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 2);
      const output = await rows(files);
      const inSession = output.find((row) => row.event === "in-session");
      const afterSession = output.find((row) => row.event === "after-session");
      assert.match(inSession!.file, /sess-end[\\/]main[\\/]/);
      assert.match(afterSession!.file, /_unattributed[\\/]main[\\/]/);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drains accepted events when logging is disabled before flush", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-pending-"));
    const path = join(cwd, "trace.jsonl");
    try {
      setupDebug({ enabled: true, path }, cwd);
      debug("router", "pending-before-disable");
      setupDebug({ enabled: false }, cwd);
      await flushDebug(1_000);
      const contents = await readFile(path, "utf8");
      assert.match(contents, /pending-before-disable/);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent for identical setup and starts a new run after a config change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-reload-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload" }) });
      setupDebug({ enabled: true }, cwd);
      debug("router", "first");
      await flushDebug(1_000);
      assert.equal((await logFiles(cwd)).length, 1);

      setupDebug({ enabled: true, level: "info" }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload" }) });
      debug("router", "filtered-out");
      debug("router", "second", undefined, { level: "info" });
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 2, "a config change starts a new run file");
      const output = await rows(files);
      assert.deepEqual(output.map((row) => row.event).sort(), ["first", "second"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops new events while disabled and works after re-enabling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-toggle-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-toggle" }) });
      debug("router", "before");
      await flushDebug(1_000);
      setupDebug({ enabled: false }, cwd);
      assert.equal(isDebugEnabled(), false);
      debug("router", "while-disabled");
      await flushDebug(1_000);
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-toggle" }) });
      debug("router", "after");
      await flushDebug(1_000);
      const output = await rows(await logFiles(cwd));
      assert.deepEqual(output.map((row) => row.event).sort(), ["after", "before"]);
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rebinds the requesting session when a reload enables logging", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-disabled-bind-"));
    try {
      const session = { getHeader: () => ({ id: "sess-late" }) };
      setupDebug({ enabled: false }, cwd);
      setupDebugForSession({ enabled: true }, cwd, session);
      debug("router", "enabled-late");
      await flushDebug(1_000);
      const files = await logFiles(cwd);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /sess-late[\\/]main[\\/]/);
      const output = await rows(files);
      assert.equal(output[0]!.session_id, "sess-late");
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("attributes an interleaved measurement to the session that started it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-measure-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-a" }) });
      const stopA = debugMeasure("test", "measure-a");
      bindDebugSession({ getHeader: () => ({ id: "sess-b" }) });
      const stopB = debugMeasure("test", "measure-b");
      stopA({ id: "a" });
      stopB({ id: "b" });
      await flushDebug(1_000);

      const output = await rows(await logFiles(cwd));
      const a = output.find((row) => row.event === "measure-a");
      const b = output.find((row) => row.event === "measure-b");
      assert.ok(a && b);
      assert.match(a!.file, /sess-a[\\/]main[\\/]/);
      assert.equal(a!.session_id, "sess-a");
      assert.match(b!.file, /sess-b[\\/]main[\\/]/);
      assert.equal(b!.session_id, "sess-b");
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drops a measurement whose originating logger was retired by a reload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-measure-reload-"));
    const firstPath = join(cwd, "first.jsonl");
    const secondPath = join(cwd, "second.jsonl");
    try {
      setupDebug({ enabled: true, path: firstPath }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload-measure" }) });
      const stop = debugMeasure("test", "reload-measure");
      setupDebug({ enabled: true, path: secondPath }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-reload-measure" }) });
      stop();
      await flushDebug(1_000);

      await assert.rejects(readFile(secondPath, "utf8"));
      await assert.rejects(readFile(firstPath, "utf8"));
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not clear another session's binding on shutdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bifrost-facade-shutdown-"));
    try {
      setupDebug({ enabled: true }, cwd);
      bindDebugSession({ getHeader: () => ({ id: "sess-a" }) });
      bindDebugSession({ getHeader: () => ({ id: "sess-b" }) });
      endDebugSession({ getHeader: () => ({ id: "sess-a" }) });
      debug("router", "still-b");
      await flushDebug(1_000);

      const output = await rows(await logFiles(cwd));
      const row = output.find((entry) => entry.event === "still-b");
      assert.ok(row);
      assert.match(row!.file, /sess-b[\\/]main[\\/]/);
      assert.equal(row!.session_id, "sess-b");
    } finally {
      setupDebug({ enabled: false }, cwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
