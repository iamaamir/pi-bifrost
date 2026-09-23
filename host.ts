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
// - setWorkingVisible / ModelSelectorComponent / ModelRuntime: Pi-only
// - model_select / agent_settled events: Pi-only (omp never emits them)

import * as host from "@earendil-works/pi-coding-agent";
import { streamSimple as standaloneStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Host's config dir name: ".pi" under Pi, ".omp" under omp. */
export const CONFIG_DIR_NAME: string = host.CONFIG_DIR_NAME;

let ompRuntime = false;

/**
 * Detect and latch the host from the ExtensionAPI instance. Called once
 * at extension load. omp exposes `pi.zod`; Pi's ExtensionAPI does not.
 */
export function initHost(pi: unknown): boolean {
  ompRuntime = hostIsOmp(pi);
  return ompRuntime;
}

/** Structural probe — safe to call without latching state. */
export function hostIsOmp(pi: unknown): boolean {
  return typeof pi === "object" && pi !== null && "zod" in pi;
}

/** True after initHost latched an omp host. */
export function isOmpHost(): boolean {
  return ompRuntime;
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
  // Standalone path (omp): streamSimple does not resolve credentials itself,
  // and omp providers throw MissingApiKeyError before issuing the request —
  // even for keyless endpoints (local Ollama proxying :cloud models,
  // llama.cpp, LM Studio). omp's own agent path passes the kNoAuth sentinel
  // for those; mirror it so keyless providers stay usable from the probe
  // and classifier.
  if (options.apiKey === undefined) {
    let key: string | undefined;
    if (typeof registry.getApiKey === "function") {
      try {
        key = await registry.getApiKey(model);
      } catch {
        key = undefined;
      }
    }
    // A real key wins; anything else (undefined, or omp's sentinel returned
    // for a keyless provider) falls through to the sentinel so the request
    // is still issued. Endpoints that need real auth will 401 either way.
    options = { ...options, apiKey: key ?? OMP_NO_AUTH };
  }
  return _streamDeps.standaloneStreamSimple(
    model,
    context as Parameters<typeof _streamDeps.standaloneStreamSimple>[1],
    options as Parameters<typeof _streamDeps.standaloneStreamSimple>[2],
  );
}
