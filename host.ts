// ── Host compatibility seam (Pi ⇆ omp) ─────────────────────────────
// Bifrost runs unmodified on both Pi and omp (oh-my-pi). omp rewrites
// @earendil-works/* imports onto its bundled host code and accepts the
// pi.extensions manifest, so this module typechecks against either
// package; runtime differences are probed, never assumed.
//
// Known host gaps handled here and in call sites:
// - input result shape:      Pi { action } vs omp { handled?, text? }
// - registry.refresh:        Pi refresh({signal}) vs omp refresh(strategy)
// - registry.streamSimple:   Pi method vs standalone pi-ai function
// - ctx.signal / thinkingLevel / scopedModels: Pi-only context fields
// - setWorkingVisible / ModelRuntime: Pi-only
// - ModelSelectorComponent: Pi-only; commands.ts falls back to the host select dialog on OMP
// - model_select / agent_settled events: Pi-only (omp never emits them)
// - agent_end: OMP extension notifications use willContinue; isTerminal:false is retained for compatibility

import * as host from "@earendil-works/pi-coding-agent";
import { streamSimple as standaloneStreamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/** Host's config dir name: ".pi" under Pi, ".omp" under omp. */
export const CONFIG_DIR_NAME: string = host.CONFIG_DIR_NAME;

/** omp's config dir name — see hostIsOmp for why this identifies the host. */
const OMP_CONFIG_DIR_NAME = ".omp";

/** OMP abandons extension handlers after 30s; finish cancellable work first. */
export const OMP_OPERATION_TIMEOUT_MS = 25_000;

/** @internal test seam for import-time host signals and bounded operations. */
export const _hostDeps = {
  configDirName: CONFIG_DIR_NAME,
  operationTimeoutMs: OMP_OPERATION_TIMEOUT_MS,
};

let ompRuntime = false;
/**
 * Detect and latch the host from the ExtensionAPI instance. Called once
 * at extension load.
 */
export function initHost(pi: unknown): boolean {
  ompRuntime = hostIsOmp(pi);
  return ompRuntime;
}

/** Structural probe — safe to call without latching state. */
export function hostIsOmp(pi: unknown): boolean {
  // Primary signal: the imported host package's own config dir name. omp's
  // compat loader rewrites `@earendil-works/*` imports onto its bundled
  // packages, so this value identifies which host distribution is loaded
  // rather than a capability Pi could later happen to add.
  if (_hostDeps.configDirName === OMP_CONFIG_DIR_NAME) return true;
  // Fallback: omp injects `pi.zod` (and `pi.arktype`) into the ExtensionAPI;
  // Pi's ExtensionAPI carries neither.
  return typeof pi === "object" && pi !== null && "zod" in pi;
}

/** True after initHost latched an omp host. */
export function isOmpHost(): boolean {
  return ompRuntime;
}

/**
 * Host-appropriate TypeSafe credential guidance. OMP resolves credentials
 * through an abstract host store, so its portable setup instruction is the
 * environment variable rather than a fabricated auth-file path.
 */
export function typeSafeCredentialOptions(envName: string): string {
  const usesOmp = ompRuntime || _hostDeps.configDirName === OMP_CONFIG_DIR_NAME;
  return usesOmp
    ? `the ${envName} environment variable`
    : `Pi's ~/.pi/agent/auth.json or ${envName}`;
}

export function isProjectTrusted(ctx: ExtensionContext): boolean {
  if (typeof ctx.isProjectTrusted === "function") return ctx.isProjectTrusted();
  // OMP intentionally applies no project-trust gate. Older Pi-shaped hosts
  // may omit the method; retain their historical project-layer behavior.
  return true;
}

/** @internal test reset */
export function _resetHostForTests(): void {
  ompRuntime = false;
}

// ── input handler results ─────────────────────────────────────────
// Pi: { action: "continue" } proceeds; { action: "transform", text }
// rewrites the prompt. omp: a returned `text` replaces the input and
// an empty result passes through; `handled: true` would swallow it.
// These helpers return `never` (the bottom type) so the host-specific
// runtime value satisfies either host's handler signature.

export function inputContinue(): never {
  return (ompRuntime ? {} : { action: "continue" }) as never;
}

export function inputTransform(text: string): never {
  return (ompRuntime ? { text } : { action: "transform", text }) as never;
}
// OMP consumes `{ handled: true }`; Pi consumes `{ action: "handled" }`.
export function inputHandled(): never {
  return (ompRuntime ? { handled: true } : { action: "handled" }) as never;
}

// ── agent_end semantics ───────────────────────────────────────────
// omp marks a non-terminal agent_end — another continuation is already
// scheduled — with `willContinue: true`. Pi's AgentEndEvent has no such
// field; there it is `agent_settled` that marks a completed run.

/** True when an agent_end is non-terminal and must not settle. */
export function agentEndContinues(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const value = event as { willContinue?: unknown; isTerminal?: unknown };
  return value.willContinue === true || value.isTerminal === false;
}

// ── context fields missing on omp ─────────────────────────────────

export function ctxSignal(ctx: ExtensionContext): AbortSignal | undefined {
  return (ctx as ExtensionContext & { signal?: AbortSignal }).signal;
}

export function thinkingLevelOf(ctx: ExtensionContext, pi?: { getThinkingLevel?: () => string }): string | undefined {
  const contextLevel = (ctx as ExtensionContext & { thinkingLevel?: string }).thinkingLevel;
  if (contextLevel !== undefined) return contextLevel;
  try {
    return pi?.getThinkingLevel?.();
  } catch {
    return undefined;
  }
}

export function scopedModelsOf(ctx: ExtensionContext): readonly never[] {
  return (ctx as ExtensionContext & { scopedModels?: readonly never[] }).scopedModels ?? [];
}

export function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return (ctx as ExtensionContext & { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}


export interface OperationSignal {
  readonly signal: AbortSignal | undefined;
  readonly done: () => void;
  readonly timedOut: () => boolean;
}

/**
 * Compose Pi's live turn signal with an OMP-owned watchdog. OMP does not expose
 * its private handler signal, so the watchdog is deliberately below its 30s cap.
 */
export function operationSignalFor(
  ctx: ExtensionContext,
  timeoutMs = _hostDeps.operationTimeoutMs,
): OperationSignal {
  const hostSignal = ctxSignal(ctx);
  if (!isOmpHost()) return { signal: hostSignal, done: () => {}, timedOut: () => false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), timeoutMs);
  const signal = hostSignal ? AbortSignal.any([hostSignal, controller.signal]) : controller.signal;
  return {
    signal,
    done: () => clearTimeout(timer),
    timedOut: () => controller.signal.aborted && !hostSignal?.aborted,
  };
}

export interface OperationResult<T> {
  readonly aborted: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

/** Resolve promptly on cancellation while observing a late operation rejection. */
export async function waitForOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<OperationResult<T>> {
  if (!signal) {
    try {
      return { aborted: false, value: await operation };
    } catch (error) {
      return { aborted: false, error };
    }
  }
  if (signal.aborted) {
    void Promise.resolve(operation).then(
      (value) => {
        try { onLateValue?.(value); } catch { /* cleanup only */ }
      },
      () => undefined,
    );
    return { aborted: true };
  }
  let resolve!: (result: OperationResult<T>) => void;
  const promise = new Promise<OperationResult<T>>((resolver) => { resolve = resolver; });
  const finish = (result: OperationResult<T>) => {
    signal.removeEventListener("abort", abort);
    resolve(result);
  };
  const abort = () => finish({ aborted: true });
  signal.addEventListener("abort", abort, { once: true });
  void Promise.resolve(operation).then(
    (value) => finish({ aborted: false, value }),
    (error) => finish({ aborted: false, error }),
  );
  return promise;
}

export const _subprocessDeps = { existsSync };

/** @internal test seam for identifying the running OMP executable. */
export const _processDeps = { execPath: process.execPath, argv0: process.argv[0], entry: process.argv[1] };

// ── registry refresh ──────────────────────────────────────────────
// Pi: refresh(options?: { signal? }). omp: refresh(strategy?, options?)
// with no signal support.

export async function refreshRegistry(
  registry: ExtensionContext["modelRegistry"],
  signal?: AbortSignal,
): Promise<void> {
  const bound = registry as unknown as {
    refresh: (a?: unknown, b?: unknown) => Promise<unknown>;
  };
  if (ompRuntime) {
    const background = bound as {
      awaitBackgroundRefresh?: () => Promise<unknown>;
    };
    // OMP discovery may already be in flight. Observe its completion before
    // issuing the explicit refresh used by init/providers.
    if (typeof background.awaitBackgroundRefresh === "function") {
      await background.awaitBackgroundRefresh();
    }
    await bound.refresh("online-if-uncached");
    return;
  }
  if (signal) {
    await bound.refresh({ signal });
    return;
  }
  await bound.refresh();
}

/** Resolve a provider credential through OMP's context-aware public registry. */
export async function providerApiKeyViaRegistry(
  ctx: ExtensionContext,
  provider: string,
  options: { baseUrl?: string; modelId?: string; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  if (!isOmpHost()) return undefined;
  const registry = ctx.modelRegistry as unknown as {
    getApiKeyForProvider?: (
      provider: string,
      sessionId?: string,
      options?: { baseUrl?: string; modelId?: string; signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
  if (typeof registry.getApiKeyForProvider !== "function") return undefined;
  const registryOptions = options.signal === undefined
    ? { baseUrl: options.baseUrl, modelId: options.modelId }
    : options;
  return registry.getApiKeyForProvider(provider, sessionIdOf(ctx), registryOptions);
}

// ── simple streaming ──────────────────────────────────────────────
// Pi's ModelRegistry exposes streamSimple; omp's does not, but both
// hosts' pi-ai export an identical standalone streamSimple(model,
// context, options). On the standalone path we resolve the API key
// through the registry first (omp's keyless sentinel is "N/A").

type ApiKeyResolver = (context: {
  lastChance: boolean;
  error: unknown;
  previousKey?: string;
  signal?: AbortSignal;
}) => Promise<string | { apiKey: string; credentialId?: number } | undefined> | string | { apiKey: string; credentialId?: number } | undefined;

interface SimpleStreamArgs {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

interface SimpleStreamOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  cacheRetention?: "none";
  apiKey?: string | ApiKeyResolver;
  cwd?: string;
  sessionId?: string;
}

/** @internal test seam */
export const _streamDeps = { standaloneStreamSimple };

/** omp's kNoAuth sentinel: providers treat it as "keyless, proceed anyway". */
export const OMP_NO_AUTH = "N/A";

export async function streamSimpleVia(
  ctx: ExtensionContext,
  model: Model<Api>,
  context: SimpleStreamArgs,
  options: SimpleStreamOptions = {},
): Promise<ReturnType<typeof _streamDeps.standaloneStreamSimple>> {
  const sessionId = options.sessionId ?? sessionIdOf(ctx);
  const requestOptions: SimpleStreamOptions = {
    ...options,
    signal: options.signal ?? ctxSignal(ctx),
    ...(sessionId ? { sessionId } : {}),
  };
  const registry = ctx.modelRegistry as unknown as {
    streamSimple?: typeof _streamDeps.standaloneStreamSimple;
    resolver?: (model: Model<Api>, sessionId?: string) => ApiKeyResolver;
    getApiKey?: (
      model: Model<Api>,
      sessionId?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
  if (typeof registry.streamSimple === "function") {
    return registry.streamSimple(model, context, requestOptions as never);
  }
  // Standalone path (omp): streamSimple does not resolve credentials itself.
  // Prefer the session-aware resolver so refresh/rotation remains live across
  // provider auth retries. Older registries retain the one-shot getApiKey path.
  if (requestOptions.apiKey === undefined && typeof registry.resolver === "function") {
    requestOptions.apiKey = registry.resolver(model, sessionId);
  } else if (requestOptions.apiKey === undefined && typeof registry.getApiKey === "function") {
    const key = await registry.getApiKey(model, sessionId, requestOptions.signal ? { signal: requestOptions.signal } : undefined);
    if (key !== undefined) requestOptions.apiKey = key;
  }
  if (isOmpHost() && ctx.cwd) requestOptions.cwd = ctx.cwd;
  return _streamDeps.standaloneStreamSimple(
    model,
    context as Parameters<typeof _streamDeps.standaloneStreamSimple>[1],
    requestOptions as Parameters<typeof _streamDeps.standaloneStreamSimple>[2],
  );
}

export interface SubprocessInvocation {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function executableName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return basename(path).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function isOmpEntry(path: string | undefined): boolean {
  if (!path || !_subprocessDeps.existsSync(path)) return false;
  const name = basename(path).toLowerCase();
  return name === "omp" || name === "omp.js" || name === "omp.ts" || name === "cli.js" || name === "cli.ts";
}

/**
 * Build a host CLI invocation for the classifier subprocess. The user prompt
 * is deliberately absent: callers pipe it through stdin. OMP discovery is
 * conservative and returns undefined when the running executable cannot be
 * identified, so auto mode never launches an unrelated bare `omp` binary.
 */
export function classifierSubprocessInvocation(
  ctx: ExtensionContext,
  model: Model<Api>,
  systemPrompt: string,
): SubprocessInvocation | undefined {
  const common = [
    "--no-extensions",
    "--no-session",
    "--no-tools",
    "--print",
    "--system-prompt",
    systemPrompt,
    "--model",
    `${model.provider}/${model.id}`,
  ];
  if (!isOmpHost()) {
    const script = _processDeps.entry;
    if (script && /\.[cm]?[jt]s$/.test(script)) {
      return { command: _processDeps.execPath, args: [script, ...common, "--no-prompt-templates", "--no-context-files", "--no-approve"], cwd: ctx.cwd, env: process.env };
    }
    return { command: "pi", args: [...common, "--no-prompt-templates", "--no-context-files", "--no-approve"], cwd: ctx.cwd, env: process.env };
  }

  const runningOmp = executableName(_processDeps.execPath) === "omp" || executableName(_processDeps.argv0) === "omp";
  if (runningOmp) {
    return {
      command: _processDeps.execPath,
      args: [...common, "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--cwd", ctx.cwd],
      cwd: ctx.cwd,
      env: process.env,
    };
  }
  const entry = _processDeps.entry;
  if (isOmpEntry(entry)) {
    return {
      command: _processDeps.execPath,
      args: [entry, ...common, "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--cwd", ctx.cwd],
      cwd: ctx.cwd,
      env: process.env,
    };
  }
  return undefined;
}
