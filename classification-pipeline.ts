import type { ClassifierModel } from "./classifier.ts";
import { classify as regexClassify, type RouteRule } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "inline";

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource }
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
  /** Classifier models in priority order. Empty array = skip LLM. */
  readonly classifierModels: readonly ClassifierModel[];
  /** Invoke the LLM classifier for a single model. Returns tier or undefined. */
  readonly classifyWithLLM: (
    model: ClassifierModel,
    text: string,
    tiers: readonly string[],
  ) => Promise<string | undefined>;
  /** Regex routing rules. First match wins. */
  readonly regexRules: readonly RouteRule[];
  /** Default tier when nothing matches. */
  readonly defaultTier: string | undefined;
  /** Known tier names, from config.models keys. */
  readonly tiers: readonly string[];
}

// ── Pipeline interface ─────────────────────────────────────────

export interface ClassificationPipeline {
  readonly classify: (text: string) => Promise<ClassificationResult>;
}

// ── Factory ────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): ClassificationPipeline {
  const {
    cacheLookup,
    classifierModels,
    classifyWithLLM,
    regexRules,
    defaultTier,
    tiers,
  } = deps;

  async function classify(text: string): Promise<ClassificationResult> {
    if (tiers.length === 0) return { kind: "unclassified" };

    // Stage 1: pre-check regex for direct model references only
    // Runs before cache — explicit bindings beat LLM or cached guesses.
    {
      const endPre = debugMeasure("pipeline", "regex_pre");
      const pre = regexClassify(text, regexRules);
      endPre({ match: !!pre, tier: pre });
      if (pre && pre.includes("/") && !tiers.includes(pre)) {
        debug("pipeline", "result", { source: "regex", tier: pre, direct: true });
        return { kind: "classified", tier: pre, source: "regex" };
      }
    }

    // Stage 2: cache lookup
    const endCache = debugMeasure("pipeline", "cache");
    const cached = cacheLookup(text);
    endCache({ hit: !!cached });
    if (cached && tiers.includes(cached)) {
      debug("pipeline", "result", { source: "cache", tier: cached });
      return { kind: "classified", tier: cached, source: "cache" };
    }

    // Stage 3: LLM classifier — try each model in priority order
    for (const model of classifierModels) {
      try {
        const endLLM = debugMeasure("pipeline", "classifier.attempt");
        const tier = await classifyWithLLM(model, text, tiers);
        const modelId = model.kind === "registry" ? model.model.id : model.id;
        endLLM({ model: modelId, tier });
        if (tier && tiers.includes(tier)) {
          debug("pipeline", "result", { source: "classifier", tier });
          return { kind: "classified", tier, source: "classifier" };
        }
      } catch (err) {
        debug("pipeline", "classifier.error", { error: String(err) });
        console.error(`[bifrost] classifier model failed: ${err}`);
      }
    }

    // Stage 3: regex rules
    const endRegex = debugMeasure("pipeline", "regex");
    const regex = regexClassify(text, regexRules);
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
