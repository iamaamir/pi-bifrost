import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categoryLabel,
  classificationPrompt,
  classifyWithLLM,
  extractCategory,
} from "../classifier.ts";
import { flushDebug, setupDebug } from "../debug.ts";
import { makeModel } from "./helpers.ts";

async function captureClassifierLogs(run: () => Promise<unknown>): Promise<{ result: unknown; debugText: string; stderrText: string }> {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-classifier-privacy-"));
  const path = join(directory, "debug.jsonl");
  const originalError = console.error;
  const stderr: string[] = [];
  setupDebug({ enabled: true, path }, directory);
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try {
    const result = await run();
    await flushDebug();
    return { result, debugText: readFileSync(path, "utf8"), stderrText: stderr.join("\n") };
  } finally {
    console.error = originalError;
    setupDebug({ enabled: false, path }, directory);
    rmSync(directory, { recursive: true, force: true });
  }
}

function classifierEvents(text: string): Array<Record<string, unknown>> {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("classifier", () => {
  describe("categoryLabel", () => {
    it("returns category name unchanged", () => {
      assert.equal(categoryLabel("frontier"), "frontier");
      assert.equal(categoryLabel("economical"), "economical");
      assert.equal(categoryLabel("local"), "local");
    });
  });

  describe("classificationPrompt", () => {
    it("lists categories by name", () => {
      const prompt = classificationPrompt(["frontier", "economical"], "hello");
      assert.ok(prompt.includes("frontier, economical"));
      assert.ok(prompt.includes("Request: hello"));
    });
  });

  it("routes registry classification through modelRegistry.streamSimple", async () => {
    let observedContext: { systemPrompt?: string; messages?: unknown[] } | undefined;
    let observedOptions: { maxTokens?: number; cacheRetention?: string } | undefined;
    const model = {
      provider: "fixture",
      id: "classifier",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      cost: { input: 0, output: 0 },
    };
    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      modelRegistry: {
        streamSimple: (_model: unknown, context: typeof observedContext, options: typeof observedOptions) => {
          observedContext = context;
          observedOptions = options;
          return {
            result: async () => ({
              role: "assistant",
              api: "openai-completions",
              provider: "fixture",
              model: "classifier",
              content: [{ type: "text", text: "frontier" }],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            }),
          };
        },
      },
    };

    const result = await classifyWithLLM(
      ctx as never,
      { kind: "registry", model } as never,
      ["quick", "frontier"],
      "design the architecture",
      { method: "direct" },
    );

    assert.equal(result, "frontier");
    assert.match(observedContext?.systemPrompt ?? "", /routing classifier/);
    assert.equal(observedContext?.messages?.length, 1);
    assert.equal(observedOptions?.maxTokens, 20);
    assert.equal(observedOptions?.cacheRetention, "none");
  });

  it("keeps registry classifier output out of generic debug fields while returning the tier", async () => {
    const sentinelPrompt = "PRIVATE_PROMPT_ECHO_SENTINEL";
    const logs = await captureClassifierLogs(() => classifyWithLLM({
      cwd: process.cwd(),
      signal: new AbortController().signal,
      modelRegistry: {
        streamSimple: () => ({ result: async () => ({ content: [{ type: "text", text: "frontier" }] }) }),
      },
    } as never, { kind: "registry", model: makeModel("fixture", "classifier") }, ["frontier"], sentinelPrompt, { method: "direct" }));

    assert.equal(logs.result, "frontier");
    assert.doesNotMatch(logs.debugText, /PRIVATE_PROMPT_ECHO_SENTINEL/u);
    const event = classifierEvents(logs.debugText).find((row) => row.event === "registry.done");
    assert.equal(event?.outputChars, 8);
    assert.equal(Object.hasOwn(event ?? {}, "raw"), false);
  });

  it("does not log a configured HTTP endpoint when returning a classifier tier", async () => {
    const endpointSecret = "PRIVATE_ENDPOINT_SECRET";
    const model = { kind: "endpoint" as const, id: "fixture-classifier", baseUrl: `https://example.invalid/${endpointSecret}/v1` };
    const logs = await captureClassifierLogs(() => classifyWithLLM(
      { cwd: process.cwd() } as never,
      model,
      ["frontier"],
      "request",
      { method: "direct", fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "frontier" } }] }) } as Response) },
    ));

    assert.equal(logs.result, "frontier");
    assert.doesNotMatch(logs.debugText + logs.stderrText, new RegExp(endpointSecret, "u"));
    const event = classifierEvents(logs.debugText).find((row) => row.event === "http.done");
    assert.equal(event?.outputChars, 8);
    assert.equal(Object.hasOwn(event ?? {}, "raw"), false);
  });

  it("keeps configured endpoint URLs out of empty and failed HTTP diagnostics", async () => {
    const endpointSecret = "PRIVATE_HTTP_ENDPOINT_SENTINEL";
    const model = { kind: "endpoint" as const, id: "fixture-classifier", baseUrl: `https://example.invalid/${endpointSecret}/v1` };
    const empty = await captureClassifierLogs(() => classifyWithLLM(
      { cwd: process.cwd() } as never,
      model,
      ["frontier"],
      "request",
      { method: "direct", fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) } as Response) },
    ));
    assert.equal(empty.result, undefined);
    assert.doesNotMatch(empty.debugText + empty.stderrText, new RegExp(endpointSecret, "u"));
    const emptyEvent = classifierEvents(empty.debugText).find((row) => row.event === "http.empty_response");
    assert.equal(emptyEvent?.outputPresent, false);

    const failed = await captureClassifierLogs(() => classifyWithLLM(
      { cwd: process.cwd() } as never,
      model,
      ["frontier"],
      "request",
      { method: "direct", fetchImpl: async () => ({ ok: false, status: 429 } as Response) },
    ));
    assert.equal(failed.result, undefined);
    assert.doesNotMatch(failed.debugText + failed.stderrText, new RegExp(endpointSecret, "u"));
    assert.match(failed.stderrText, /classifier HTTP request failed \(status 429\)/u);
    assert.equal(classifierEvents(failed.debugText).find((row) => row.event === "http.error")?.status, 429);
  });

  it("omits subprocess stderr and process error text from debug and stderr output", async () => {
    const sentinel = "PRIVATE_SUBPROCESS_STDERR_SENTINEL";
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const logs = await captureClassifierLogs(() => classifyWithLLM(
      { cwd: process.cwd() } as never,
      { kind: "registry", model: makeModel("fixture", "classifier") },
      ["frontier"],
      "request",
      { method: "subprocess", spawnImpl: (() => {
        queueMicrotask(() => {
          child.stderr.write(sentinel);
          child.emit("close", 1);
        });
        return child as unknown as ChildProcess;
      }) as unknown as typeof import("node:child_process").spawn },
    ));

    assert.equal(logs.result, undefined);
    assert.doesNotMatch(logs.debugText + logs.stderrText, new RegExp(sentinel, "u"));
    assert.match(logs.stderrText, /classifier subprocess exited with code 1/u);
    const event = classifierEvents(logs.debugText).find((row) => row.event === "subprocess.error");
    assert.equal(event?.stderrPresent, true);
    assert.equal(event?.stderrChars, sentinel.length);
    assert.equal(Object.hasOwn(event ?? {}, "stderr"), false);
  });

  it("does not interpolate child process errors into user-visible output", async () => {
    const sentinel = "PRIVATE_PROCESS_ERROR_SENTINEL";
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const logs = await captureClassifierLogs(() => classifyWithLLM(
      { cwd: process.cwd() } as never,
      { kind: "registry", model: makeModel("fixture", "classifier") },
      ["frontier"],
      "request",
      { method: "subprocess", spawnImpl: (() => {
        queueMicrotask(() => child.emit("error", new Error(sentinel)));
        return child as unknown as ChildProcess;
      }) as unknown as typeof import("node:child_process").spawn },
    ));

    assert.equal(logs.result, undefined);
    assert.doesNotMatch(logs.debugText + logs.stderrText, new RegExp(sentinel, "u"));
    assert.equal(logs.stderrText, "[bifrost] classifier subprocess failed");
    const event = classifierEvents(logs.debugText).find((row) => row.event === "subprocess.error");
    assert.equal(event?.errorCategory, "process_error");
  });

  it("propagates caller abort to registry classification and skips paid fallbacks", async () => {
    const controller = new AbortController();
    let registrySignal: AbortSignal | undefined;
    let subprocessCalls = 0;
    const classifierModel = { kind: "registry" as const, model: makeModel("fixture", "classifier") };
    const ctx = {
      cwd: process.cwd(),
      modelRegistry: {
        streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
          registrySignal = options.signal;
          return {
            result: () => new Promise((resolve) => {
              options.signal?.addEventListener("abort", () => resolve({ content: [] }), { once: true });
            }),
          };
        },
      },
    } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "auto",
      spawnImpl: (() => { subprocessCalls += 1; throw new Error("must not spawn after abort"); }) as unknown as typeof import("node:child_process").spawn,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.equal(registrySignal?.aborted, true);
    assert.equal(subprocessCalls, 0);
  });

  it("propagates caller abort to prompt HTTP fetch", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const classifierModel = { kind: "endpoint" as const, id: "fixture-classifier", baseUrl: "https://example.invalid/v1" };
    const ctx = { cwd: process.cwd() } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "direct",
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
      },
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.equal(requestSignal?.aborted, true);
  });

  it("terminates only its owned prompt subprocess when caller aborts", async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kills: string[] = [];
    child.kill = (signal) => {
      kills.push(signal ?? "default");
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const classifierModel = { kind: "registry" as const, model: makeModel("fixture", "classifier") };
    const ctx = { cwd: process.cwd() } as never;
    const resultPromise = classifyWithLLM(ctx, classifierModel, ["frontier"], "request", {
      method: "subprocess",
      spawnImpl: (() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await resultPromise, undefined);
    assert.deepEqual(kills, ["SIGTERM"]);
  });

  describe("extractCategory", () => {
    it("extracts exact category name", () => {
      assert.equal(extractCategory("frontier", ["frontier", "economical"]), "frontier");
    });

    it("is case-insensitive", () => {
      assert.equal(extractCategory("Frontier", ["frontier", "economical"]), "frontier");
    });

    it("handles surrounding whitespace", () => {
      assert.equal(extractCategory("  economical  ", ["frontier", "economical"]), "economical");
    });

    it("returns undefined for non-matching text", () => {
      assert.equal(extractCategory("unknown", ["frontier", "economical"]), undefined);
    });

    it("does not substring match", () => {
      // "not economical" should not match "economical"
      assert.equal(extractCategory("not economical", ["frontier", "economical"]), undefined);
    });
  });
});
