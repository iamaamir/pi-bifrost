import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRouteRequest, ModelRoute } from "@earendil-works/pi-coding-agent";
import type { VirtualOverride } from "./virtual-override.ts";

/** Explains what to fix: empty pool vs configured-but-unresolvable pool. */
export function poolProblem(tier: string, pool: string | string[] | undefined): string {
  const patterns = pool === undefined ? [] : Array.isArray(pool) ? pool : [pool];
  return patterns.length === 0
    ? `0 models configured for "${tier}" — add models to bifrost.json or run /bifrost init`
    : `pool [${patterns.join(", ")}] resolved 0 available models — check provider credentials and model ids`;
}

/** Fail-closed error that says what to fix: empty pool vs unresolved pool. */
export function noModelError(tier: string, pool: string | string[] | undefined, reason?: string): string {
  const suffix = reason ? ` (${reason})` : "";
  return `Bifrost: no healthy physical model for tier ${tier}${suffix}: ${poolProblem(tier, pool)}`;
}

export interface VirtualRouteDependencies {
  overrides: VirtualOverride;
  select: (prompt: string, forcedTier?: string, signal?: AbortSignal) => Promise<Model<Api> | undefined>;
  fallback: () => Model<Api> | undefined;
  /** Last dispatched physical model — session fact, not routing policy. */
  sticky?: () => Model<Api> | undefined;
  onDispatch?: (model: Model<Api>, thinkingLevel: ModelRoute["thinkingLevel"]) => void;
  /** Release dispatch bookkeeping (e.g. claimed half-open trial) when dispatch setup throws. */
  onDispatchFailed?: (model: Model<Api>) => void;
  /** Visible degrade: kept model when no pool resolves. */
  onDegrade?: (model: Model<Api>) => void;
  routeError?: (detail: string) => Error;
}

function latestUserText(messages: readonly Message[]): string {
  const user = messages.filter((message) => message.role === "user").at(-1);
  if (!user) return "";
  return typeof user.content === "string"
    ? user.content
    : user.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

export function createVirtualRoute(deps: VirtualRouteDependencies): (request: ModelRouteRequest) => Promise<ModelRoute> {
  return async (request) => {
    const sticky = request.reason === "retry" ? (request.failed ?? request.previous) : request.previous;
    const fail = (detail: string) => deps.routeError ? deps.routeError(detail) : new Error(`Bifrost: ${detail}`);
    const dispatch = (model: Model<Api>, thinkingLevel: ModelRoute["thinkingLevel"]): ModelRoute => {
      try {
        deps.onDispatch?.(model, thinkingLevel);
      } catch (error) {
        deps.onDispatchFailed?.(model);
        throw error;
      }
      return { model, thinkingLevel };
    };
    if (request.reason !== "user") {
      const model = sticky?.model ?? deps.fallback();
      if (!model) throw fail("no healthy physical model for virtual request");
      return dispatch(model, clampThinkingLevel(model, sticky?.thinkingLevel ?? request.thinkingLevel));
    }

    const prompt = latestUserText(request.messages);
    const forcedTier = deps.overrides.take(prompt);
    const model = await deps.select(prompt, forcedTier, request.signal);
    if (!model) {
      const kept = deps.sticky?.();
      if (!kept) throw fail("no healthy physical model for virtual request");
      deps.onDegrade?.(kept);
      return dispatch(kept, clampThinkingLevel(kept, request.thinkingLevel));
    }
    return dispatch(model, clampThinkingLevel(model, request.thinkingLevel));
  };
}
