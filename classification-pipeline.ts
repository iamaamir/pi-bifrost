import type { ClassifierModel } from "./classifier.ts";
import { classifyCompiled, compileRules, type RouteRule } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassificationJudgment, type ClassifierOutput } from "./classifier-backends.ts";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "inline";

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource; readonly judgment?: ClassificationJudgment }
  | { readonly kind: "fallback"; readonly tier: string }
  | { readonly kind: "unclassified" };

// ── Pipeline dependencies ──────────────────────────────────────

/**
 * Dependencies injected into the pipeline. All are in-process.
 *
 * `cacheLookup` may internally mutate its backing store for LRU
 * tracking — this is an accepted impurity (see ADR candidate #4).
 */
export interface PipelineDeps {
  /** Query cache. Returns tier or undefined. */
  readonly cacheLookup: (text: string) => string | undefined;
  /** Optional provider-neutral backend attempted before prompt classifier. */
  readonly classifyWithTypeSafe?: (text: string, tiers: readonly string[], signal?: AbortSignal) => Promise<ClassifierOutput | undefined>;
  /** Classifier models in priority order. Empty array = skip LLM. */
  readonly classifierModels: readonly ClassifierModel[];
  /** Invoke the LLM classifier for a single model. Returns tier or undefined. */
  readonly classifyWithLLM: (
    model: ClassifierModel,
    text: string,
    tiers: readonly string[],
    signal?: AbortSignal,
  ) => Promise<ClassifierOutput | undefined>;
  /** Regex routing rules. First match wins. */
  readonly regexRules: readonly RouteRule[];
  /** Default tier when nothing matches. */
  readonly defaultTier: string | undefined;
  /** Known tier names, from config.models keys. */
  readonly tiers: readonly string[];
}

// ── Pipeline interface ─────────────────────────────────────────

export interface ClassificationPipeline {
  readonly classify: (text: string, signal?: AbortSignal) => Promise<ClassificationResult>;
}

function normalizeJudgment(output: ClassifierOutput, backend: "prompt" | "typesafe"): ClassificationJudgment {
  return typeof output === "string"
    ? { tier: output, backend }
    : output;
}

// ── Factory ────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): ClassificationPipeline {
  const {
    cacheLookup,
    classifyWithTypeSafe,
    classifierModels,
    classifyWithLLM,
    regexRules: rawRegexRules,
    defaultTier,
    tiers,
  } = deps;

  // Compile rules once at pipeline construction — no per-turn regex building.
  // Per-rule testing preserves rule-order match precedence exactly.
  const regexRules = compileRules(rawRegexRules);

  async function classify(text: string, signal?: AbortSignal): Promise<ClassificationResult> {
    // Stage 1: pre-check regex for direct model references only.
    // Runs before tiers check — direct bindings work even with zero tiers.
    {
      const endPre = debugMeasure("pipeline", "regex_pre");
      const pre = classifyCompiled(text, regexRules);
      endPre({ match: !!pre, tier: pre });
      if (pre && pre.includes("/") && !tiers.includes(pre)) {
        debug("pipeline", "result", { source: "regex", tier: pre, direct: true });
        return { kind: "classified", tier: pre, source: "regex" };
      }
    }

    if (tiers.length === 0) return { kind: "unclassified" };
    if (signal?.aborted) return { kind: "unclassified" };

    // Stage 2: cache lookup
    const endCache = debugMeasure("pipeline", "cache");
    const cached = cacheLookup(text);
    endCache({ hit: !!cached });
    if (cached && tiers.includes(cached)) {
      debug("pipeline", "result", { source: "cache", tier: cached });
      return { kind: "classified", tier: cached, source: "cache" };
    }

    // Stage 3: optional TypeSafe classifier, then existing prompt classifier.
    if (classifyWithTypeSafe) {
      try {
        const endTypeSafe = debugMeasure("pipeline", `${CLASSIFIER_BACKEND_IDS.typesafe}.attempt`);
        const output = await classifyWithTypeSafe(text, tiers, signal);
        const judgment = output === undefined ? undefined : normalizeJudgment(output, CLASSIFIER_BACKEND_IDS.typesafe);
        const tier = judgment?.tier;
        endTypeSafe({ tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment };
        }
      } catch {
        debug("pipeline", `${CLASSIFIER_BACKEND_IDS.typesafe}.error`, { aborted: signal?.aborted ?? false });
      }
      if (signal?.aborted) return { kind: "unclassified" };
    }

    // Existing prompt classifier — try each model in priority order.
    for (const model of classifierModels) {
      if (signal?.aborted) return { kind: "unclassified" };
      try {
        const endLLM = debugMeasure("pipeline", "classifier.attempt");
        const output = await classifyWithLLM(model, text, tiers, signal);
        const modelId = model.kind === "registry" ? model.model.id : model.id;
        const judgment = output === undefined ? undefined : normalizeJudgment(output, CLASSIFIER_BACKEND_IDS.prompt);
        const tier = judgment?.tier;
        endLLM({ model: modelId, tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("classifier", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model ?? modelId, confidence: judgment.confidence });
          return { kind: "classified", tier: judgment.tier, source: "classifier", judgment: { ...judgment, model: judgment.model ?? modelId } };
        }
      } catch {
        debug("classifier", "classifier.error", { category: "classifier_failure" });
        console.error("[bifrost] classifier model failed");
      }
      if (signal?.aborted) return { kind: "unclassified" };
    }

    if (signal?.aborted) return { kind: "unclassified" };

    // Stage 4: regex rules
    const endRegex = debugMeasure("pipeline", "regex");
    const regex = classifyCompiled(text, regexRules);
    endRegex({ match: !!regex, tier: regex });
    if (regex) {
      if (tiers.includes(regex)) {
        // Tier name match — route through strategy.
        debug("pipeline", "result", { source: "regex", tier: regex });
        return { kind: "classified", tier: regex, source: "regex" };
      }
      if (regex.includes("/")) {
        // Direct model reference (e.g. "opencode-go/glm-5.1" in rule).
        debug("pipeline", "result", { source: "regex", tier: regex, direct: true });
        return { kind: "classified", tier: regex, source: "regex" };
      }
    }

    // Stage 4: default fallback
    debug("pipeline", "result", { source: "fallback", tier: defaultTier });
    if (defaultTier) {
      return { kind: "fallback", tier: defaultTier };
    }

    return { kind: "unclassified" };
  }

  return { classify };
}
