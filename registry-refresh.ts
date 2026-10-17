import type { ModelsRefreshResult } from "@earendil-works/pi-ai";

export interface ProviderRefreshEvidence {
  readonly status: "complete" | "partial" | "stale";
  readonly refreshedAt: number;
}

/**
 * Project Pi's refresh result into content-free evidence for one provider.
 * The caller must pass the providers known to the current registry snapshot.
 */
export function projectProviderRefreshEvidence(
  result: ModelsRefreshResult,
  provider: string,
  knownProviders: readonly string[],
  observedAt: number,
): ProviderRefreshEvidence {
  const stale = (): ProviderRefreshEvidence => Object.freeze({ status: "stale", refreshedAt: observedAt });
  if (typeof provider !== "string" || provider.length === 0
    || !Array.isArray(knownProviders) || !knownProviders.includes(provider)
    || !Number.isFinite(observedAt) || Math.abs(observedAt) > 8_640_000_000_000_000
    || !result || typeof result !== "object" || typeof result.aborted !== "boolean"
    || !result.errors || typeof result.errors.has !== "function") return stale();
  if (result.aborted) return stale();
  try {
    return Object.freeze({ status: result.errors.has(provider) ? "partial" : "complete", refreshedAt: observedAt });
  } catch {
    return stale();
  }
}

export async function waitForRegistryRefresh<T = unknown>(
  refresh: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  onCompleted?: (result: T) => void,
): Promise<"completed" | "aborted"> {
  if (signal?.aborted) return "aborted";
  if (!signal) {
    const result = await refresh();
    onCompleted?.(result);
    return "completed";
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const finish = (result: "completed" | "aborted") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => finish("aborted");
    const complete = (result: T) => {
      if (settled) return;
      if (signal.aborted) {
        finish("aborted");
        return;
      }
      settled = true;
      cleanup();
      try {
        onCompleted?.(result);
        resolve("completed");
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish("aborted");
      return;
    }
    Promise.resolve()
      .then(() => {
        if (settled || signal.aborted) {
          finish("aborted");
          return undefined;
        }
        return refresh(signal);
      })
      .then((result) => {
        if (!settled && !signal.aborted) complete(result as T);
        else finish("aborted");
      }, (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
  });
}
