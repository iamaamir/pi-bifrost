import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { debug } from "./debug.ts";
import { promptWithMinimalSession } from "./session-fallback.ts";
import { classifierSubprocessInvocation, streamSimpleVia, ctxSignal, isOmpHost } from "./host.ts";

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

const DEFAULT_SYSTEM_PROMPT =
  "You are a routing classifier. Classify each request into exactly one tier." +
  " Respond with only the tier name. No explanation, no punctuation.";

export interface ClassifierOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  method?: "direct" | "subprocess" | "auto";
  signal?: AbortSignal;
}

export const _classifierDeps = { spawn };

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


async function classifyWithDirectHttp(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<string | undefined> {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTokens = options.maxTokens ?? 20;
  const temperature = options.temperature ?? 0;
  const userPrompt = classificationPrompt(categories, prompt);

  if (classifierModel.kind === "registry") {
    const stream = await streamSimpleVia(
      ctx,
      classifierModel.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      {
        maxTokens,
        temperature,
        signal: options.signal ?? ctxSignal(ctx),
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
      const fallbackText = options.signal?.aborted ? undefined : await promptWithMinimalSession(
        classifierModel.model,
        userPrompt,
        { cwd: ctx.cwd, systemPrompt, signal: options.signal ?? ctxSignal(ctx) },
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal ?? ctxSignal(ctx) ?? (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(30_000)
        : undefined),
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
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<string | undefined> {
  if (classifierModel.kind !== "registry" || options.signal?.aborted) return undefined;
  const model = classifierModel.model;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userPrompt = classificationPrompt(categories, prompt);
  const invocation = classifierSubprocessInvocation(ctx, model, systemPrompt);
  if (!invocation) {
    debug("classifier", "subprocess.unavailable", { model: `${model.provider}/${model.id}` });
    return undefined;
  }
  debug("classifier", "subprocess.start", { model: `${model.provider}/${model.id}`, command: invocation.command });

  let resolve!: (result: string | undefined) => void;
  const promise = new Promise<string | undefined>((resolver) => { resolve = resolver; });
  let settled = false;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = _classifierDeps.spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    console.error(`[bifrost] classifier subprocess error: ${err}`);
    resolve(undefined);
    return promise;
  }

  let stdout = "";
  let stderr = "";
  const MAX_CHUNK = 2_000;
  const finish = (result: string | undefined) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve(result);
  };
  const stop = () => {
    try {
      if (!child.killed) child.kill("SIGTERM");
    } catch (err) {
      debug("classifier", "subprocess.kill_error", {
        model: `${model.provider}/${model.id}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const abort = () => {
    stop();
    finish(undefined);
  };
  const timer = setTimeout(() => {
    stop();
    console.error(`[bifrost] classifier subprocess timed out`);
    finish(undefined);
  }, 120_000);

  const onStdinError = (err: unknown) => {
    debug("classifier", "subprocess.stdin_error", {
      model: `${model.provider}/${model.id}`,
      error: err instanceof Error ? err.message : String(err),
    });
    finish(undefined);
    stop();
  };
  const onChildError = (err: Error) => {
    console.error(`[bifrost] classifier subprocess error: ${err}`);
    finish(undefined);
  };
  const onClose = (code: number | null) => {
    if (options.signal?.aborted) {
      finish(undefined);
      return;
    }
    if (code !== 0) {
      debug("classifier", "subprocess.error", {
        model: `${model.provider}/${model.id}`,
        exitCode: code,
      });
      console.error(`[bifrost] classifier subprocess exited ${code}`);
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
  };

  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < MAX_CHUNK) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_CHUNK) stderr += chunk;
  });

  // Register stream/process handlers before writing. A child can exit before
  // consuming stdin, which makes the writable emit EPIPE asynchronously.
  child.stdin.on("error", onStdinError);
  child.on("error", onChildError);
  child.on("close", onClose);
  if (child.stdin.destroyed || child.stdin.writableEnded || child.stdin.writable === false) {
    onStdinError(new Error("classifier subprocess stdin is closed"));
  } else {
    try {
      child.stdin.end(userPrompt);
    } catch (err) {
      onStdinError(err);
    }
  }
  return promise;
}

export async function classifyWithLLM(
  ctx: ExtensionContext,
  classifierModel: ClassifierModel,
  categories: readonly string[],
  prompt: string,
  options: ClassifierOptions = {},
): Promise<string | undefined> {
  const method = options.method ?? "auto";

  if (method === "direct" || method === "auto") {
    const direct = await classifyWithDirectHttp(
      ctx,
      classifierModel,
      categories,
      prompt,
      options,
    );
    if (direct) return direct;
    if (options.signal?.aborted) return undefined;
    if (isOmpHost()) return undefined;
  }

  if (method === "subprocess" || method === "auto") {
    return classifyWithSubprocess(ctx, classifierModel, categories, prompt, options);
  }

  return undefined;
}
