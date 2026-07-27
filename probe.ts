// ── Model probe: availability testing ────────────────────────────
// Sends a tiny prompt to every available model and records results.
// Used by /bifrost probe to surface real-world model health.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProbeResult {
  provider: string;
  model: string;
  cost_input: number;
  cost_output: number;
  status: "ok" | "error" | "timeout" | "skipped";
  duration_ms: number;
  error?: string;
  tokens?: number;
}

const PROBE_PROMPT = "1+1=";
export const PROBE_PROMPT_TEXT = PROBE_PROMPT;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_TOKENS = 5;

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}


export async function runProbe(
  ctx: ExtensionContext,
  onProgress?: (done: number, total: number, last: ProbeResult) => void,
): Promise<{ results: ProbeResult[]; path: string }> {
  const available = ctx.modelRegistry.getAvailable();
  const total = available.length;
  const CONCURRENCY = 8;
  const results: ProbeResult[] = new Array(total);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      results[i] = await probeOne(ctx, available[i]);
      completed++;
      onProgress?.(completed, total, results[i]);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  const outputPath = join(process.cwd(), ".pi", "bifrost-probe.json");
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");
  return { results, path: outputPath };
}

async function probeOne(
  ctx: ExtensionContext,
  model: Model<Api>,
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
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) {
        base.status = "error";
        base.error = `unknown provider: ${model.provider}`;
        return base;
      }
      const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
      if (!auth) {
        base.status = "error";
        base.error = "auth unavailable";
        return base;
      }

      const stream = provider.streamSimple(
        model,
        {
          messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }],
        },
        {
          maxTokens: PROBE_MAX_TOKENS,
          temperature: 0,
          signal: controller.signal,
          cacheRetention: "none",
          apiKey: auth.auth.apiKey,
          headers: auth.auth.headers,
          env: auth.env,
        },
      );
      const response = await stream.result();
      base.duration_ms = +(performance.now() - start).toFixed(1);
      const text = assistantText(response);
      if (!text.trim()) {
        base.status = "error";
        base.error = "empty response";
        return base;
      }
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
