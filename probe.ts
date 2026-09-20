// ── Model probe: availability testing ────────────────────────────
// Sends a tiny prompt to every available model and records results.
// Used by /bifrost probe to surface real-world model health.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promptWithMinimalSession } from "./session-fallback.ts";

export interface ProbeResult {
  provider: string;
  model: string;
  cost_input: number;
  cost_output: number;
  status: "ok" | "error" | "timeout" | "skipped";
  duration_ms: number;
  transport?: "streamSimple" | "session";
  error?: string;
  tokens?: number;
}

const PROBE_PROMPT = "1+1=";
export const PROBE_PROMPT_TEXT = PROBE_PROMPT;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 5;
/** Default worker count. Override via config `probe.concurrency` —
 * lower it if a provider rate-limits burst traffic. */
export const DEFAULT_PROBE_CONCURRENCY = 50;

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

type MinimalSessionPrompt = (
  model: Model<Api>,
  prompt: string,
  options: { cwd?: string; systemPrompt?: string },
) => Promise<string | undefined>;

export interface RunProbeOptions {
  onProgress?: (done: number, total: number, last: ProbeResult) => void;
  promptWithSession?: MinimalSessionPrompt;
  timeoutMs?: number;
  concurrency?: number;
}

/** RunProbe options derived from config (`probe.concurrency`/`probe.timeoutMs`).
 * Undefined fields fall back to runProbe defaults. */
export function probeOptionsFromConfig(config?: {
  concurrency?: number;
  timeoutMs?: number;
}): Pick<RunProbeOptions, "concurrency" | "timeoutMs"> {
  return { concurrency: config?.concurrency, timeoutMs: config?.timeoutMs };
}

export async function runProbe(
  ctx: ExtensionContext,
  options: RunProbeOptions = {},
): Promise<{ results: ProbeResult[]; path: string }> {
  const available = ctx.modelRegistry.getAvailable();
  const total = available.length;
  const results: ProbeResult[] = new Array(total);
  let cursor = 0;
  let completed = 0;

  const { onProgress, promptWithSession = promptWithMinimalSession, timeoutMs = PROBE_TIMEOUT_MS, concurrency = DEFAULT_PROBE_CONCURRENCY } = options;

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      results[i] = await probeOne(ctx, available[i], promptWithSession, timeoutMs);
      completed++;
      onProgress?.(completed, total, results[i]);
    }
  }

  // Use minimum of requested concurrency and total models, but at least 1
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, total));
  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  await Promise.all(workers);

  const outputPath = join(process.cwd(), ".pi", "bifrost-probe.json");
  try {
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  } catch (err) {
    // Persistence is best-effort: a completed probe must still return its
    // results so callers record reliability outcomes and render the report.
    console.error(`[bifrost] failed to write probe results: ${err}`);
    return { results, path: outputPath };
  }
  return { results, path: outputPath };
}

async function probeOne(
  ctx: ExtensionContext,
  model: Model<Api>,
  promptWithSession: MinimalSessionPrompt,
  timeoutMs: number,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    provider: model.provider,
    model: model.id,
    cost_input: model.cost?.input ?? 0,
    cost_output: model.cost?.output ?? 0,
    status: "skipped",
    duration_ms: 0,
  };

  const api = model.api as string | undefined;
  if (!api) {
    base.error = "unsupported api: undefined";
    return base;
  }

  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const stream = ctx.modelRegistry.streamSimple(
        model,
        {
          messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
        },
        {
          maxTokens: PROBE_MAX_TOKENS,
          temperature: 0,
          signal: controller.signal,
          cacheRetention: "none",
        },
      );
      const response = await stream.result();
      base.duration_ms = +(performance.now() - start).toFixed(1);
      const text = assistantText(response).trim();
      if (!text) {
        const fallbackText = await promptWithSession(model, PROBE_PROMPT, {
          cwd: ctx.cwd,
          systemPrompt: "You are a model probe. Reply with only the result.",
        });
        if (!fallbackText?.trim()) {
          base.status = "error";
          base.error = "empty response";
          return base;
        }
        base.status = "ok";
        base.transport = "session";
        return base;
      }
      base.transport = "streamSimple";
      base.status = response.stopReason === "error" ? "error" : "ok";
      if (response.stopReason === "error") {
        base.error = response.errorMessage ?? "model error";
      } else {
        base.tokens = response.usage.totalTokens;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    base.duration_ms = +(performance.now() - start).toFixed(1);
    base.status = err instanceof DOMException && err.name === "AbortError"
      ? "timeout"
      : "error";
    base.error = String(err).slice(0, 200);
  }

  return base;
}
