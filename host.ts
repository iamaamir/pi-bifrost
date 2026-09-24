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
// - agent_end: omp marks a non-terminal end with willContinue: true

import * as host from "@earendil-works/pi-coding-agent";
import { streamSimple as standaloneStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Host's config dir name: ".pi" under Pi, ".omp" under omp. */
export const CONFIG_DIR_NAME: string = host.CONFIG_DIR_NAME;

/** omp's config dir name — see hostIsOmp for why this identifies the host. */
const OMP_CONFIG_DIR_NAME = ".omp";

/** @internal test seam for the import-time host signals. */
export const _hostDeps = { configDirName: CONFIG_DIR_NAME };

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

// ── agent_end semantics ───────────────────────────────────────────
// omp marks a non-terminal agent_end — another continuation is already
// scheduled — with `willContinue: true`. Pi's AgentEndEvent has no such
// field; there it is `agent_settled` that marks a completed run.

/** True when an agent_end is not terminal and must not settle. */
export function agentEndContinues(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  return (event as { willContinue?: boolean }).willContinue === true;
}

// ── context fields missing on omp ─────────────────────────────────

export function ctxSignal(ctx: ExtensionContext): AbortSignal | undefined {
  return (ctx as ExtensionContext & { signal?: AbortSignal }).signal;
}

export function thinkingLevelOf(ctx: ExtensionContext): string | undefined {
  return (ctx as ExtensionContext & { thinkingLevel?: string }).thinkingLevel;
}

export function scopedModelsOf(ctx: ExtensionContext): readonly never[] {
  return (ctx as ExtensionContext & { scopedModels?: readonly never[] }).scopedModels ?? [];
}

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
    // Call as a method: omp's registry uses #private fields and an
    // unbound call would throw "undefined is not an object".
    await bound.refresh("online-if-uncached");
    return;
  }
  if (signal) {
    await bound.refresh({ signal });
    return;
  }
  await bound.refresh();
}

// ── simple streaming ──────────────────────────────────────────────
// Pi's ModelRegistry exposes streamSimple; omp's does not, but both
// hosts' pi-ai export an identical standalone streamSimple(model,
// context, options). On the standalone path we resolve the API key
// through the registry first (omp's keyless sentinel is "N/A").

interface SimpleStreamArgs {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

interface SimpleStreamOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  cacheRetention?: "none";
  apiKey?: string;
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
  const registry = ctx.modelRegistry as unknown as {
    streamSimple?: typeof _streamDeps.standaloneStreamSimple;
    getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
  };
  if (typeof registry.streamSimple === "function") {
    return registry.streamSimple(model, context, options);
  }
  // Standalone path (omp): streamSimple does not resolve credentials itself.
  // OMP's ModelRegistry returns the kNoAuth sentinel explicitly for providers
  // it marks keyless (including local Ollama/llama.cpp/LM Studio). Preserve
  // that sentinel, but do not invent one when a normal provider has no
  // resolved credential; the provider must report its normal missing-auth
  // error instead of receiving a fake key.
  if (options.apiKey === undefined && typeof registry.getApiKey === "function") {
    // Deliberately no catch: an error thrown by getApiKey (OAuth refresh
    // failure, credential broker or command failure, malformed auth) is a
    // real credential-resolution failure and must reach the caller's error
    // path.
    const key = await registry.getApiKey(model);
    if (key !== undefined) options = { ...options, apiKey: key };
  }
  return _streamDeps.standaloneStreamSimple(
    model,
    context as Parameters<typeof _streamDeps.standaloneStreamSimple>[1],
    options as Parameters<typeof _streamDeps.standaloneStreamSimple>[2],
  );
}
