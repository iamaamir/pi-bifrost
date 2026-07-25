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

  // Only probe OpenAI-compatible HTTP models.
  const api = model.api as string | undefined;
  if (
    !api ||
    (!api.startsWith("openai-") && api !== "mistral-conversations")
  ) {
    base.error = `unsupported api: ${api}`;
    return base;
  }

  const start = performance.now();
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    const apiKey = auth.ok ? auth.apiKey : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(auth.ok && auth.headers ? auth.headers : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      let baseUrl = model.baseUrl.endsWith("/")
        ? model.baseUrl
        : `${model.baseUrl}/`;
      // Guard against providers that already include the endpoint path.
      if (baseUrl.endsWith("/chat/completions/") || baseUrl.endsWith("/v1/chat/completions/")) {
        // URL is already the full chat/completions endpoint.
      } else {
        baseUrl = new URL("chat/completions", baseUrl).toString();
      }
      const url = baseUrl;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      });

      base.duration_ms = +(performance.now() - start).toFixed(1);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        base.status = "error";
        base.error = `HTTP ${response.status}: ${body.slice(0, 200)}`;
        return base;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      base.status = "ok";
      base.tokens = data.usage?.total_tokens;
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
