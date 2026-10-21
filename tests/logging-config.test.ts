import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { mergeConfig, validateConfig } from "../config.ts";
import {
  createProcessIdentity,
  destinationFor,
  mergeIdentity,
  resolveDebugConfig,
  sanitizeFragment,
} from "../logging/context.ts";
import type { BifrostConfig } from "../config.ts";

const cwd = "/tmp/bifrost-config-project";

function baseConfig(): BifrostConfig {
  return {
    enabled: true,
    default: "general",
    models: { general: "provider/model" },
    classifier: { enabled: false },
  };
}

function debugErrors(debug: unknown): string[] {
  return validateConfig({ ...baseConfig(), debug } as BifrostConfig)
    .filter((issue) => issue.path?.startsWith("debug") && issue.severity === "error")
    .map((issue) => issue.code ?? issue.message);
}

describe("logging configuration", () => {
  it("defaults to bounded session-scoped storage", () => {
    const resolved = resolveDebugConfig({ enabled: true }, cwd);
    assert.equal(resolved.sharedPath, null);
    assert.equal(resolved.level, "debug");
    assert.equal(resolved.directory, join(cwd, ".pi", "bifrost", "logs"));
    assert.deepEqual(resolved.queue, { maxEntries: 1_000, maxBytes: 1_048_576, overflowPolicy: "severity-first" });
    assert.equal(resolved.drain.intervalMs, 50);
    assert.equal(resolved.drain.maxBatchBytes, 65_536);
    assert.equal(resolved.sink.maxFileSizeBytes, 10 * 1024 * 1024);
  });

  it("expands a home-relative directory without joining the user name", () => {
    const resolved = resolveDebugConfig({ enabled: true, directory: "~/logs" }, cwd);
    assert.equal(resolved.directory, join(homedir(), "logs"));
  });

  it("sanitizes Windows-reserved and trailing-dot fragments", () => {
    assert.equal(sanitizeFragment("CON"), "_CON");
    assert.equal(sanitizeFragment("name. "), "name");
    assert.equal((sanitizeFragment("lpt1.log") ?? "").startsWith("_"), true);
  });

  it("keeps an explicit shared path authoritative", () => {
    const resolved = resolveDebugConfig({ enabled: true, path: ".pi/bifrost-debug.jsonl", scope: "session" }, cwd);
    assert.equal(resolved.sharedPath, join(cwd, ".pi", "bifrost-debug.jsonl"));
    const identity = mergeIdentity(createProcessIdentity({}, 1), { sessionId: "s" });
    const destination = destinationFor(resolved, identity);
    assert.equal(destination.shared, true);
    assert.equal(destination.path, resolved.sharedPath);
  });

  it("treats scope file as the shared default file", () => {
    const resolved = resolveDebugConfig({ enabled: true, scope: "file" }, cwd);
    assert.equal(resolved.sharedPath, join(cwd, ".pi", "bifrost-debug.jsonl"));
  });

  it("clamps unsafe values instead of allowing unbounded memory", () => {
    const resolved = resolveDebugConfig({
      enabled: true,
      level: "verbose" as never,
      queue: { maxEntries: 0, maxBytes: Number.POSITIVE_INFINITY, overflowPolicy: "unknown" as never },
      drain: { intervalMs: -5, maxBatchBytes: Number.POSITIVE_INFINITY },
      sink: { maxFileSizeMB: -1, rotatedFiles: 99 },
    }, cwd);
    assert.equal(resolved.level, "debug");
    assert.equal(resolved.queue.maxEntries, 1_000);
    assert.equal(resolved.queue.maxBytes, 1_048_576);
    assert.equal(resolved.queue.overflowPolicy, "severity-first");
    assert.equal(resolved.drain.intervalMs, 50);
    assert.equal(resolved.drain.maxBatchBytes, 65_536);
    assert.equal(resolved.sink.maxFileSizeBytes, 10 * 1024 * 1024);
    assert.equal(resolved.sink.rotatedFiles, 3);
  });

  it("rejects invalid values during configuration validation", () => {
    assert.deepEqual(debugErrors({ level: "loud" }), ["config.debug_level_invalid"]);
    assert.deepEqual(debugErrors({ queue: { maxEntries: 0 } }), ["config.debug_queue_invalid"]);
    assert.deepEqual(debugErrors({ queue: { maxBytes: 10 } }), ["config.debug_queue_invalid"]);
    assert.deepEqual(debugErrors({ queue: { overflowPolicy: "newest" } }), ["config.debug_queue_invalid"]);
    assert.deepEqual(debugErrors({ drain: { intervalMs: -1 } }), ["config.debug_drain_invalid"]);
    assert.deepEqual(debugErrors({ drain: { maxBatchBytes: 1 } }), ["config.debug_drain_invalid"]);
    assert.deepEqual(debugErrors({ sink: { type: "http" } }), ["config.debug_sink_invalid"]);
    assert.deepEqual(debugErrors({ sink: { rotation: 2 } }), []);
    assert.deepEqual(debugErrors({ directory: "" }), ["config.debug_directory_invalid"]);
    assert.deepEqual(debugErrors("on"), ["config.debug_invalid"]);
  });

  it("rejects and clamps a batch limit larger than queue capacity", () => {
    const debug = {
      queue: { maxBytes: 1_048_576 },
      drain: { maxBatchBytes: 8 * 1024 * 1024 },
    };
    assert.deepEqual(debugErrors(debug), ["config.debug_drain_invalid"]);
    const resolved = resolveDebugConfig({ enabled: true, ...debug }, cwd);
    assert.equal(resolved.drain.maxBatchBytes, 1_048_576);
  });

  it("warns when an explicit path overrides session scope", () => {
    const issues = validateConfig({
      ...baseConfig(),
      debug: { enabled: true, path: ".pi/trace.jsonl", scope: "session" },
    } as BifrostConfig);
    assert.ok(issues.some((issue) => issue.code === "config.debug_path_precedence" && issue.severity === "warning"));
  });

  it("deep-merges queue, drain, and sink layers", () => {
    const merged = mergeConfig(
      { ...baseConfig(), debug: { enabled: true, queue: { maxEntries: 10, maxBytes: 4_096, overflowPolicy: "drop-oldest" } } },
      { debug: { queue: { maxEntries: 20 } } },
    );
    assert.equal(merged.debug?.queue?.maxEntries, 20);
    assert.equal(merged.debug?.queue?.maxBytes, 4_096);
    assert.equal(merged.debug?.queue?.overflowPolicy, "drop-oldest");
  });

  it("ships schema properties for the new configuration surface", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8")) as {
      definitions?: { DebugConfig?: { additionalProperties?: boolean; properties?: Record<string, unknown> } };
    };
    const definition = schema.definitions?.DebugConfig;
    assert.equal(definition?.additionalProperties, false);
    for (const key of ["enabled", "path", "level", "scope", "directory", "queue", "drain", "sink"]) {
      assert.ok(definition?.properties?.[key], `schema must expose debug.${key}`);
    }
  });

  it("sanitizes untrusted identity fragments and keeps destinations inside the root", () => {
    const fragment = sanitizeFragment("../../etc/passwd");
    assert.ok(fragment);
    assert.equal(fragment.includes("/"), false);
    assert.equal(fragment.includes(".."), false);
    assert.equal(sanitizeFragment(".."), undefined);
    assert.equal(sanitizeFragment(""), undefined);
    const config = resolveDebugConfig({ enabled: true }, cwd);
    const identity = mergeIdentity(createProcessIdentity({}, 1), {
      sessionId: "../../escape",
      agentId: "../agent",
    });
    const destination = destinationFor(config, identity);
    assert.equal(destination.path.startsWith(`${config.directory}${sep}`), true);
    assert.doesNotMatch(destination.path, /\.\./);
  });
});
