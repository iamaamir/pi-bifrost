import * as host from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

// ModelRuntime exists on Pi; omp has no equivalent class (its registry is
// process-global), so the minimal-session transport is unavailable there.
// The module must not crash at import time on omp — degrade instead.
const ModelRuntime = (host as unknown as { ModelRuntime?: abstract new (...args: never[]) => object }).ModelRuntime;

type MinimalRuntime = object;

let runtimePromise: Promise<MinimalRuntime> | undefined;

async function getRuntime(): Promise<MinimalRuntime> {
  runtimePromise ??= (ModelRuntime as unknown as { create: () => Promise<MinimalRuntime> }).create();
  return runtimePromise;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
}

type RacedValue<T> = { readonly aborted: false; readonly value: T } | { readonly aborted: true };

async function raceWithSignal<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<RacedValue<T>> {
  if (!signal) {
    return { aborted: false, value: await operation };
  }
  if (signal.aborted) {
    void Promise.resolve(operation).then(
      (value) => { try { onLateValue?.(value); } catch { /* cleanup only */ } },
      () => undefined,
    );
    return { aborted: true };
  }
  return new Promise<RacedValue<T>>((resolve) => {
    let settled = false;
    const finish = (result: RacedValue<T>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(operation).then(
      (value) => finish({ aborted: false, value }),
      () => finish({ aborted: true }),
    );
  });
}

/** True when the host can spawn a minimal side session (Pi only). */
export function minimalSessionAvailable(): boolean {
  return typeof ModelRuntime === "function";
}

export async function promptWithMinimalSession(
  model: Model<Api>,
  prompt: string,
  options: {
    cwd?: string;
    systemPrompt?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  if (!minimalSessionAvailable()) {
    debugUnavailableOnce();
    return undefined;
  }
  const signal = options.signal;
  if (signal?.aborted) return undefined;
  const cwd = options.cwd ?? process.cwd();
  const systemPrompt = options.systemPrompt ?? "You are a helpful assistant.";
  const runtimeResult = await raceWithSignal(getRuntime(), signal);
  if (runtimeResult.aborted) return undefined;
  const runtime = runtimeResult.value;
  if (signal?.aborted) return undefined;
  const loader = new host.DefaultResourceLoader({
    cwd,
    agentDir: agentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  const loaderResult = await raceWithSignal(loader.reload(), signal);
  if (loaderResult.aborted) return undefined;

  const sessionResult = await raceWithSignal(host.createAgentSession({
    cwd,
    modelRuntime: runtime as host.ModelRuntime,
    model,
    sessionManager: host.SessionManager.inMemory(cwd),
    resourceLoader: loader,
    noTools: "all",
  }), signal, (result) => result.session.dispose());
  if (sessionResult.aborted) return undefined;
  const { session } = sessionResult.value;
  let abortPromise: Promise<void> | undefined;
  const abort = () => {
    abortPromise ??= session.abort().catch(() => {});
  };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    await session.prompt(prompt);
    await abortPromise;
    if (signal?.aborted) return undefined;
    const text = session.getLastAssistantText()?.trim();
    return text ? text : undefined;
  } finally {
    signal?.removeEventListener("abort", abort);
    await abortPromise;
    session.dispose();
  }
}

let warnedUnavailable = false;
function debugUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.error("[bifrost] minimal-session transport unavailable on this host; session fallback disabled");
}
