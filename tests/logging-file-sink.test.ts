import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AsyncFileSink } from "../logging/file-sink.ts";
import type { LogDestination, LogEntry } from "../logging/types.ts";

interface FakeHandle {
  write(
    data: Buffer | string,
    offset?: number | null,
    length?: number | string | null,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Buffer }>;
  stat(): Promise<{ size: number }>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

interface BufferedFileState {
  content: Buffer;
  calls: number;
  failOnCall?: number;
  truncateFails?: boolean;
}

function bufferedHandle(state: BufferedFileState, chunkSize: number): FakeHandle {
  return {
    async write(data, offset, length) {
      state.calls += 1;
      if (state.failOnCall === state.calls) {
        const error = new Error("simulated partial-write failure");
        (error as { code?: string }).code = "EIO";
        throw error;
      }
      const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const start = typeof offset === "number" ? offset : 0;
      const size = typeof length === "number" ? Math.min(length, buffer.length - start) : buffer.length - start;
      const count = Math.min(chunkSize, size);
      state.content = Buffer.concat([state.content, buffer.subarray(start, start + count)]);
      return { bytesWritten: count, buffer };
    },
    async stat() {
      return { size: state.content.length };
    },
    async truncate(length) {
      if (state.truncateFails) {
        const error = new Error("simulated truncate failure");
        (error as { code?: string }).code = "EIO";
        throw error;
      }
      state.content = state.content.subarray(0, length);
    },
    async close() {},
  };
}

function entry(line: string, id: number, destination: LogDestination): LogEntry {
  return {
    id,
    level: "debug",
    retention: 1,
    destination,
    identity: { rootSessionId: "session", sessionId: "session", runId: "run", processId: 1 },
    line,
    bytes: Buffer.byteLength(line),
  };
}

function chunkedHandle(
  chunkSize: number,
  onWrite?: (written: number) => void,
): { handle: FakeHandle; chunks: Buffer[]; closes: () => number } {
  const chunks: Buffer[] = [];
  let closes = 0;
  const handle: FakeHandle = {
    async write(data, offset, length) {
      const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const start = typeof offset === "number" ? offset : 0;
      const size = typeof length === "number" ? Math.min(length, buffer.length - start) : buffer.length - start;
      const count = Math.min(chunkSize, size);
      chunks.push(Buffer.from(buffer.subarray(start, start + count)));
      onWrite?.(count);
      return { bytesWritten: count, buffer };
    },
    async close() {
      closes += 1;
    },
    async stat() {
      return { size: 0 };
    },
    async truncate() {},
  };
  return { handle, chunks, closes: () => closes };
}

describe("async file sink writes", () => {
  it("writes the complete payload across controlled short writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-short-"));
    try {
      const destination: LogDestination = {
        key: "short",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const lines = ['{"event":"one"}\n', '{"event":"two-é"}\n'];
      const { handle, chunks, closes } = chunkedHandle(3);
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => handle,
      });

      await sink.write(lines.map((line, index) => entry(line, index + 1, destination)));

      assert.equal(Buffer.concat(chunks).toString("utf8"), lines.join(""));
      assert.equal(closes(), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failure after a short write instead of treating the batch as persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-fail-"));
    try {
      const destination: LogDestination = {
        key: "fail",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const line = '{"event":"partial"}\n';
      let writes = 0;
      const failure = new Error("simulated disk failure");
      (failure as { code?: string }).code = "EIO";
      let opens = 0;
      let reported: unknown;
      const handle: FakeHandle = {
        async write(data) {
          writes += 1;
          if (writes === 1) {
            return { bytesWritten: 4, buffer: Buffer.from(data as string) };
          }
          throw failure;
        },
        async stat() {
          return { size: 0 };
        },
        async truncate() {},
        async close() {},
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        onFailure: (error) => { reported = error; },
        openFile: async () => {
          opens += 1;
          return handle;
        },
      });

      await assert.rejects(sink.write([entry(line, 1, destination)]), /simulated disk failure/);
      assert.equal(writes, 2, "the sink must continue until the payload is complete or a write fails");
      assert.equal(opens, 1, "an uncertain partial failure must not replay the batch");
      assert.equal(reported, failure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replay a batch when a missing-path failure follows a partial write", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-partial-enoent-"));
    try {
      const destination: LogDestination = {
        key: "partial-enoent",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const line = '{"event":"partial"}\n';
      let writes = 0;
      let opens = 0;
      let reported: unknown;
      const missing = new Error("missing after partial write");
      (missing as { code?: string }).code = "ENOENT";
      const handle: FakeHandle = {
        async write(data) {
          writes += 1;
          if (writes === 1) {
            return { bytesWritten: 4, buffer: Buffer.from(data as string) };
          }
          throw missing;
        },
        async stat() {
          return { size: 0 };
        },
        async truncate() {},
        async close() {},
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        onFailure: (error) => { reported = error; },
        openFile: async () => {
          opens += 1;
          return handle;
        },
      });

      await assert.rejects(sink.write([entry(line, 1, destination)]), /missing after partial write/);
      assert.equal(writes, 2);
      assert.equal(opens, 1, "a missing path after bytes were written is still an uncertain partial failure");
      assert.equal(reported, missing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a missing-path failure only when no bytes were written", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-enoent-"));
    try {
      const destination: LogDestination = {
        key: "enoent",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const lines = ['{"event":"retried"}\n'];
      const missing = new Error("directory briefly missing");
      (missing as { code?: string }).code = "ENOENT";
      let opens = 0;
      let writes = 0;
      const second = chunkedHandle(5);
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => {
          opens += 1;
          if (opens === 1) {
            return {
              async write() {
                writes += 1;
                throw missing;
              },
              async stat() {
                return { size: 0 };
              },
              async truncate() {},
              async close() {},
            };
          }
          return second.handle;
        },
      });

      await sink.write(lines.map((line, index) => entry(line, index + 1, destination)));

      assert.equal(opens, 2);
      assert.equal(writes, 1);
      assert.equal(Buffer.concat(second.chunks).toString("utf8"), lines.join(""));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an incomplete record before a later append", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-repair-"));
    try {
      const destination: LogDestination = {
        key: "repair",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const state: BufferedFileState = { content: Buffer.alloc(0), calls: 0, failOnCall: 2 };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => bufferedHandle(state, 8),
      });

      await assert.rejects(
        sink.write([entry('{"event":"partial-record"}\n', 1, destination)]),
        /simulated partial-write failure/,
      );

      state.failOnCall = undefined;
      const next = '{"event":"next-record"}\n';
      await sink.write([entry(next, 2, destination)]);

      assert.equal(state.content.toString("utf8"), next, "an incomplete record must not merge into the next append");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a partial record on the next append when immediate truncation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-repair-deferred-"));
    try {
      const destination: LogDestination = {
        key: "repair-deferred",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const state: BufferedFileState = {
        content: Buffer.alloc(0),
        calls: 0,
        failOnCall: 2,
        truncateFails: true,
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => bufferedHandle(state, 8),
      });

      await assert.rejects(
        sink.write([entry('{"event":"partial-record"}\n', 1, destination)]),
        /simulated partial-write failure/,
      );

      state.failOnCall = undefined;
      state.truncateFails = false;
      const next = '{"event":"next-record"}\n';
      await sink.write([entry(next, 2, destination)]);

      assert.equal(state.content.toString("utf8"), next, "deferred repair must remove the incomplete prefix");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves valid records before an incomplete append", async () => {
    const root = await mkdtemp(join(tmpdir(), "bifrost-file-sink-repair-prefix-"));
    try {
      const destination: LogDestination = {
        key: "repair-prefix",
        path: join(root, "session", "run.jsonl"),
        shared: false,
        root,
      };
      const prefix = '{"event":"existing-record"}\n';
      const state: BufferedFileState = {
        content: Buffer.from(prefix, "utf8"),
        calls: 0,
        failOnCall: 2,
      };
      const sink = new AsyncFileSink(destination, {
        maxFileSizeBytes: 1_048_576,
        rotatedFiles: 0,
        openFile: async () => bufferedHandle(state, 8),
      });

      await assert.rejects(
        sink.write([entry('{"event":"partial-record"}\n', 1, destination)]),
        /simulated partial-write failure/,
      );

      state.failOnCall = undefined;
      const next = '{"event":"next-record"}\n';
      await sink.write([entry(next, 2, destination)]);

      assert.equal(
        state.content.toString("utf8"),
        prefix + next,
        "repair must restore the pre-write size, not discard earlier records",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
