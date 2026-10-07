import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { debug } from "./debug.ts";
import { promptWithMinimalSession } from "./session-fallback.ts";

// ── Classifier model — union type, no type-cast lies ─────────

/** A model from pi's registry — full auth, provider support. */
interface RegistryClassifier {
  readonly kind: "registry";
  readonly model: Model<Api>;
}

/** A direct HTTP endpoint — no auth, OpenAI-compatible only. */
interface EndpointClassifier {
  readonly kind: "endpoint";
  readonly id: string;
  readonly baseUrl: string;
}

/** Union: either a registry model or a raw endpoint. */
export type ClassifierModel = RegistryClassifier | EndpointClassifier;

function classifierBaseUrl(cm: ClassifierModel): string {
  return cm.kind === "endpoint" ? cm.baseUrl : cm.model.baseUrl;
}

function classifierId(cm: ClassifierModel): string {
  return cm.kind === "registry" ? cm.model.id : cm.id;
}

function isOpenAiCompatibleEndpoint(cm: ClassifierModel): boolean {
  if (cm.kind === "endpoint") return true; // endpoint config implies OpenAI-compatible
  const api = cm.model.api;
  return (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "openai-codex-responses" ||
    api === "azure-openai-responses" ||
    api === "mistral-conversations"
  );
}

function promptHttpSignal(ctx: ExtensionContext, signal?: AbortSignal): AbortSignal | undefined {
  const activeSignal = signal ?? ctx.signal;
  if (ctx.signal) return activeSignal;
  if (typeof AbortSignal === "undefined" || !("timeout" in AbortSignal) || !("any" in AbortSignal)) return activeSignal;
  const timeout = AbortSignal.timeout(30_000);
  return activeSignal ? AbortSignal.any([activeSignal, timeout]) : timeout;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a routing classifier. Classify each request into exactly one tier." +
  " Respond with only the tier name. No explanation, no punctuation.";

export interface ClassifierOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  method?: "direct" | "subprocess" | "auto";
  /** Test seam for verifying that only the subprocess owned by this attempt is terminated. */
  spawnImpl?: typeof spawn;
  /** Test seam for deterministic prompt HTTP cancellation coverage. */
  fetchImpl?: typeof fetch;
}

export function categoryLabel(category: string): string {
  return category;
}

export function classificationPrompt(
  categories: readonly string[],
  userPrompt: string,
): string {
  return (
    `Categories: ${categories.map(categoryLabel).join(", ")}\n\n` +
    `Classify the request into exactly one category. Respond with only the category name.\n\n` +
    `Request: ${userPrompt}\n\n` +
    `Category:`
  );
}

export function extractCategory(text: string, categories: readonly string[]): string | undefined {
  // Strip punctuation and whitespace — LLM may output "frontier." or "frontier\n".
  const needle = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+$/gu, "").replace(/^[^\p{L}\p{N}]+/gu, "");
  return categories.find((cat) => cat.toLowerCase() === needle);
}

function piCommand(): { command: string; args: string[] } {
  // Reuse the current Node binary and script path for subprocess.
  // Falls back to bare "pi" if argv[1] is unavailable (e.g. bundled executable).
  const script = process.argv[1];
  if (script) return { command: process.execPath, args: [script] };
  return { command: "pi", args: [] };
}

async function classifyWithDirectHttp(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTokens = options.maxTokens ?? 20;
  const temperature = options.temperature ?? 0;
  const userPrompt = classificationPrompt(categories, prompt);

  if (classifierModel.kind === "registry") {
    const stream = ctx.modelRegistry.streamSimple(
      classifierModel.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      {
        maxTokens,
        temperature,
        signal: signal ?? ctx.signal,
        cacheRetention: "none",
      },
    );
    const response = await stream.result();
    const content = response.content
      .filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n")
      .trim();

    if (!content) {
      if (signal?.aborted || ctx.signal?.aborted) return undefined;
      const fallbackText = await promptWithMinimalSession(
        classifierModel.model,
        userPrompt,
        { cwd: ctx.cwd, systemPrompt, signal: signal ?? ctx.signal },
      );
      if (!fallbackText?.trim()) {
        debug("classifier", "registry.empty_response", { model: classifierId(classifierModel) });
        return undefined;
      }
      const fallbackResult = extractCategory(fallbackText, categories);
      debug("classifier", "registry.session_done", {
        model: classifierId(classifierModel),
        raw: fallbackText.slice(0, 100),
        tier: fallbackResult,
      });
      return fallbackResult;
    }

    const result = extractCategory(content, categories);
    debug("classifier", "registry.done", {
      model: classifierId(classifierModel),
      raw: content.slice(0, 100),
      tier: result,
    });
    return result;
  }

  if (!isOpenAiCompatibleEndpoint(classifierModel)) {
    return undefined;
  }

  const body = {
    model: classifierId(classifierModel),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: temperature,
    stream: false,
  };

  const base = classifierBaseUrl(classifierModel);
  const baseUrl = base.endsWith("/") ? base : `${base}/`;
  const url = new URL("chat/completions", baseUrl).toString();

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: promptHttpSignal(ctx, signal),
    });

    if (!response.ok) {
      console.error(
        `[bifrost] classifier HTTP ${response.status} from ${classifierBaseUrl(classifierModel)}`,
      );
      return undefined;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      debug("classifier", "http.empty_response", { url: classifierBaseUrl(classifierModel) });
      return undefined;
    }

    const result = extractCategory(content, categories);
    debug("classifier", "http.done", {
      model: classifierId(classifierModel),
      raw: content.slice(0, 100),
      tier: result,
    });
    return result;
  } catch {
    return undefined;
  }
}

async function classifyWithSubprocess(
  _ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Subprocess only works with registry models (needs provider/id for --model).
  if (classifierModel.kind !== "registry") return undefined;
  const model = classifierModel.model;
  debug("classifier", "subprocess.start", { model: `${model.provider}/${model.id}` });

  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userPrompt = classificationPrompt(categories, prompt);
  const { command, args } = piCommand();

  const piArgs = [
    ...args,
    "--no-extensions",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--no-session",
    "--print",
    "--system-prompt",
    systemPrompt,
    "-p",
    userPrompt,
    "--model",
    `${model.provider}/${model.id}`,
  ];

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const child = (options.spawnImpl ?? spawn)(command, piArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const MAX_CHUNK = 2000;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk.slice(0, Math.max(0, MAX_CHUNK - stdout.length));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk.slice(0, Math.max(0, MAX_CHUNK - stderr.length));
    });

    let settled = false;
    let stopping = false;
    let deadlineExpired = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      console.error(`[bifrost] classifier subprocess timed out`);
      stopChild();
    }, 120_000);
    const finish = (result: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abortChild);
      resolve(result);
    };
    const stopChild = (): void => {
      if (settled || stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        cleanupTimer = setTimeout(() => finish(undefined), 250);
      }, 250);
    };
    const abortChild = (): void => stopChild();
    signal?.addEventListener("abort", abortChild, { once: true });
    if (signal?.aborted) abortChild();

    child.on("error", (err: Error) => {
      if (stopping || signal?.aborted) {
        finish(undefined);
        return;
      }
      console.error(`[bifrost] classifier subprocess error: ${err}`);
      finish(undefined);
    });

    child.on("close", (code: number | null) => {
      if (stopping || signal?.aborted || deadlineExpired) {
        finish(undefined);
        return;
      }
      if (code !== 0) {
        debug("classifier", "subprocess.error", {
          model: `${model.provider}/${model.id}`,
          exitCode: code,
          stderr: stderr.slice(0, 200),
        });
        console.error(
          `[bifrost] classifier subprocess exited ${code}: ${stderr.slice(0, 500)}`,
        );
        finish(undefined);
        return;
      }
      const result = extractCategory(stdout, categories);
      debug("classifier", "subprocess.done", {
        model: `${model.provider}/${model.id}`,
        raw: stdout.trim().slice(0, 100),
        tier: result,
      });
      finish(result);
    });
  });
}

export async function classifyWithLLM(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  const activeSignal = signal ?? ctx.signal;
  if (activeSignal?.aborted) return undefined;
  const method = options.method ?? "auto";

  if (method === "direct" || method === "auto") {
    const direct = await classifyWithDirectHttp(
      ctx,
      classifierModel,
      categories,
      prompt,
      options,
      activeSignal,
    );
    if (activeSignal?.aborted) return undefined;
    if (direct) return direct;
  }

  if (activeSignal?.aborted) return undefined;
  if (method === "subprocess" || method === "auto") {
    return classifyWithSubprocess(ctx, classifierModel, categories, prompt, options, activeSignal);
  }

  return undefined;
}
